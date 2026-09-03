// Service: the planning board. A lane is a named container with an
// orientation (vertical is serial order, horizontal is parallel work) and it
// writes nothing to disk. A surface is a canvas (ADR-043): a top-level lane
// sits at x, y with an optional width w, a nested lane flows in its parent. A file card is a real file and a folder card is a
// real folder, both directly under the surface's folder. The surface is the
// workspace-relative folder the board is showing, '' for the root. Rows live
// in <root>/.research-ops/board.sqlite3. Path bytes go through the control
// store's guarded write (assertInsideWorkspace, create-only, register).
// A lane runs: run-lane seeds an execution-state run whose steps are the
// lane's cards in canvas order; the lane row keeps only the run id.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  fail, needName, needLaneName, idOrNull, relPath, childRel,
  parseColor, parseOrientation, parseFace, parseIcon, parseFields, parseWidth, parseLaneWidth, parseCoord, defaultIcon, viewCard,
  nextOrder, laneDepth, subtreeHeight, assertDepth, assertNoCycle, imageDataUrl, imageFileName, nestTree,
  slugText, laneSlug, landingSpot, settleLanes
} from '../../public/contrib/lib/board-rules.js';
import { plugin as stickies } from './stickies.mjs';

const handles = new Map();

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS board_lanes (
    lane_id INTEGER PRIMARY KEY,
    surface TEXT NOT NULL DEFAULT '',
    parent_lane_id INTEGER NULL REFERENCES board_lanes(lane_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL DEFAULT '',
    orientation TEXT NOT NULL DEFAULT 'vertical' CHECK(orientation IN ('horizontal','vertical')),
    x INTEGER,
    y INTEGER,
    w INTEGER,
    run_id TEXT,
    sort_order INTEGER NOT NULL DEFAULT 100,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS board_cards (
    card_id INTEGER PRIMARY KEY,
    surface TEXT NOT NULL DEFAULT '',
    lane_id INTEGER NULL REFERENCES board_lanes(lane_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('file','folder','link','note')),
    ref TEXT NOT NULL,
    title TEXT,
    color TEXT,
    face TEXT,
    icon TEXT,
    fields_json TEXT,
    width INTEGER,
    sort_order INTEGER NOT NULL DEFAULT 100,
    created_at TEXT NOT NULL
  );
`;

// Boards written when a group was a folder (board_groups with folder_path)
// or older. A group becomes a lane on the surface of its parent's folder; a
// bound group also leaves a folder card for its folder in that lane; cards
// keep their lane. An unbound child nests under its parent's lane.
function migrateGroups(db) {
  const groups = db.prepare('SELECT * FROM board_groups ORDER BY sort_order, group_id').all();
  const cards = db.prepare('SELECT * FROM board_cards ORDER BY sort_order, card_id').all();
  db.exec('BEGIN');
  try {
    migrateRows(db, groups, cards);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function migrateRows(db, groups, cards) {
  db.exec(`DROP TABLE board_cards; DROP TABLE board_groups; ${SCHEMA}`);
  const insLane = db.prepare('INSERT INTO board_lanes (surface, parent_lane_id, name, orientation, sort_order, created_at) VALUES (?,?,?,?,?,?)');
  const insCard = db.prepare('INSERT INTO board_cards (surface, lane_id, kind, ref, title, color, face, icon, fields_json, sort_order, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const byId = new Map(groups.map(g => [g.group_id, g]));
  const laneOf = new Map();
  const laneFor = gid => {
    if (laneOf.has(gid)) return laneOf.get(gid);
    const g = byId.get(gid);
    const parent = g.parent_id != null && byId.has(g.parent_id) ? byId.get(g.parent_id) : null;
    let surface = '';
    let parentLane = null;
    if (parent) {
      const p = laneFor(parent.group_id);
      if (parent.folder_path) surface = parent.folder_path;
      else { surface = p.surface; parentLane = p.lane_id; }
    }
    const name = g.folder_path ? path.posix.basename(g.folder_path) : g.title;
    const orientation = g.orientation === 'horizontal' ? 'horizontal' : 'vertical';
    const { lastInsertRowid } = insLane.run(surface, parentLane, name, orientation, g.sort_order ?? 100, g.created_at || new Date().toISOString());
    const lane = { lane_id: Number(lastInsertRowid), surface };
    laneOf.set(gid, lane);
    if (g.folder_path) {
      insCard.run(surface, lane.lane_id, 'folder', g.folder_path, name, g.color ?? null,
        g.face || 'sticky', g.icon || 'folder', g.fields_json || '[]', 90, g.created_at || new Date().toISOString());
    }
    return lane;
  };
  for (const g of groups) laneFor(g.group_id);
  for (const c of cards) {
    const lane = c.group_id != null && byId.has(c.group_id) ? laneFor(c.group_id) : null;
    insCard.run(lane ? lane.surface : '', lane ? lane.lane_id : null, c.kind, c.ref, c.title ?? null, c.color ?? null,
      c.face ?? null, c.icon ?? null, c.fields_json ?? null, c.sort_order ?? 100, c.created_at || new Date().toISOString());
  }
}

// Columns added after a table shipped; a board from before one gets it on open.
const LATER_COLUMNS = [
  ['board_cards', 'width', 'INTEGER'],
  ['board_lanes', 'slug', "TEXT NOT NULL DEFAULT ''"],
  ['board_lanes', 'x', 'INTEGER'],
  ['board_lanes', 'y', 'INTEGER'],
  ['board_lanes', 'w', 'INTEGER'],
  ['board_lanes', 'run_id', 'TEXT']
];

function addLaterColumns(db) {
  for (const [table, column, ddl] of LATER_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

// Lanes from before the canvas get a position and a slug once, on open.
function settleBoard(db) {
  const changed = settleLanes(db.prepare('SELECT * FROM board_lanes').all());
  const write = db.prepare('UPDATE board_lanes SET slug=?, x=?, y=? WHERE lane_id=?');
  for (const l of changed) write.run(l.slug, l.x, l.y, l.lane_id);
}

function boardDb(rootPath) {
  const root = path.resolve(String(rootPath || ''));
  if (!rootPath || !fs.existsSync(root)) throw new Error(`Board needs an existing workspace rootPath, got: ${rootPath}`);
  let db = handles.get(root);
  if (db) return db;
  const home = path.join(root, '.research-ops');
  fs.mkdirSync(home, { recursive: true });
  db = new DatabaseSync(path.join(home, 'board.sqlite3'));
  // foreign_keys is per-connection and cannot change inside a transaction.
  db.exec('PRAGMA foreign_keys=OFF');
  const legacy = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='board_groups'").get();
  if (legacy) migrateGroups(db);
  else { db.exec(SCHEMA); addLaterColumns(db); }
  settleBoard(db);
  db.exec('PRAGMA foreign_keys=ON');
  handles.set(root, db);
  return db;
}

function mustLane(db, laneId) {
  const row = db.prepare('SELECT * FROM board_lanes WHERE lane_id=?').get(laneId);
  if (!row) throw fail('BOARD_NOT_FOUND', `No such lane: ${laneId}`);
  return row;
}

function mustCard(db, cardId) {
  const row = db.prepare('SELECT * FROM board_cards WHERE card_id=?').get(cardId);
  if (!row) throw fail('BOARD_NOT_FOUND', `No such card: ${cardId}`);
  return viewCard(row);
}

function laneOn(db, laneId, surface) {
  const lane = mustLane(db, laneId);
  if (lane.surface !== surface) throw fail('BOARD_BAD_INPUT', `Lane ${laneId} is on surface '${lane.surface}', not '${surface}'`);
  return lane;
}

function mustStore(store) {
  if (!store) throw fail('BOARD_NO_STORE', 'File and folder writes need the control store');
  return store;
}

function joinRel(a, b) {
  return a && b ? `${a}/${b}` : a || b;
}

function absIn(rootPath, rel) {
  return path.join(path.resolve(rootPath), rel);
}

function underSurface(rel, surface) {
  return surface === '' ? rel !== '' : rel.startsWith(`${surface}/`);
}

const parentOf = db => id => mustLane(db, id).parent_lane_id;
const childrenOf = db => id => db.prepare('SELECT lane_id FROM board_lanes WHERE parent_lane_id=?').all(id).map(r => r.lane_id);

// The lane and every lane under it, parents before children.
function laneSubtree(db, laneId) {
  const ids = [laneId];
  for (let i = 0; i < ids.length; i++) ids.push(...childrenOf(db)(ids[i]));
  return ids;
}

function topOrder(db, table, where, ...params) {
  return db.prepare(`SELECT MAX(sort_order) AS top FROM ${table} WHERE ${where}`).get(...params)?.top;
}

function nextCardOrder(db, surface, laneId) {
  return nextOrder(laneId == null
    ? topOrder(db, 'board_cards', 'surface=? AND lane_id IS NULL', surface)
    : topOrder(db, 'board_cards', 'lane_id=?', laneId));
}

function nextLaneOrder(db, surface, parentLaneId) {
  return nextOrder(parentLaneId == null
    ? topOrder(db, 'board_lanes', 'surface=? AND parent_lane_id IS NULL', surface)
    : topOrder(db, 'board_lanes', 'parent_lane_id=?', parentLaneId));
}

const topLanes = (db, surface) => db.prepare('SELECT lane_id, x, w FROM board_lanes WHERE surface=? AND parent_lane_id IS NULL').all(surface);

function slugOn(db, surface, name, exceptId = null) {
  const taken = db.prepare('SELECT slug FROM board_lanes WHERE surface=? AND lane_id IS NOT ?').all(surface, exceptId);
  return laneSlug(name, new Set(taken.map(r => r.slug)));
}

// A nested lane has no position (its w rides along, ignored until it is
// top-level again); a top-level one without a given spot lands past the
// placed lanes.
function insertLane(db, { surface, parentLaneId, name, orientation, x = null, y = null, w = null, now }) {
  let spot = { x: null, y: null, w };
  if (parentLaneId != null) {
    laneOn(db, parentLaneId, surface);
    assertDepth(laneDepth(parentLaneId, parentOf(db)) + 1);
  } else {
    spot = x == null || y == null ? { ...landingSpot(topLanes(db, surface)), w } : { x, y, w };
  }
  const sortOrder = nextLaneOrder(db, surface, parentLaneId);
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO board_lanes (surface, parent_lane_id, name, slug, orientation, x, y, w, sort_order, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(surface, parentLaneId, name, slugOn(db, surface, name), orientation, spot.x, spot.y, spot.w, sortOrder, now());
  return mustLane(db, Number(lastInsertRowid));
}

function insertCard(db, { surface, laneId, kind, ref, title, color, face, icon, fields_json, width = null, now }) {
  const sortOrder = nextCardOrder(db, surface, laneId);
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO board_cards (surface, lane_id, kind, ref, title, color, face, icon, fields_json, width, sort_order, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(surface, laneId, kind, ref, title, color, face, icon, fields_json, width, sortOrder, now());
  return mustCard(db, Number(lastInsertRowid));
}

// A folder card is a folder. Missing: mkdir. Already there: adopt it. A file
// at that path is refused. createDirectory throws if the path exists, so the
// exist-and-adopt check sits in front of it.
function ensureFolder(store, rootPath, rel) {
  const target = absIn(rootPath, rel);
  mustStore(store).assertInsideWorkspace(rootPath, target);
  if (!fs.existsSync(target)) {
    store.createDirectory({ rootPath, dirPath: target, actor: 'human' });
  } else if (!fs.statSync(target).isDirectory()) {
    throw fail('BOARD_BAD_INPUT', `Not a folder: ${rel}`);
  }
  return target;
}

async function writeNewFile({ store, plugins, rootPath, rel, content }) {
  const target = absIn(rootPath, rel);
  mustStore(store).assertInsideWorkspace(rootPath, target);
  if (plugins?.beforeWrite) {
    await plugins.beforeWrite({ filePath: target, content, actor: 'human', rootPath });
  }
  const written = store.writeFile({
    rootPath,
    filePath: target,
    content,
    actor: 'human',
    createOnly: true
  });
  return written.relativePath;
}

function slugFile(text, ext) {
  return `${slugText(text) || 'note'}${ext}`;
}

function uniqueName(used, name) {
  if (!used.has(name)) { used.add(name); return name; }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let i = 2;
  while (used.has(`${base}-${i}${ext}`)) i++;
  const next = `${base}-${i}${ext}`;
  used.add(next);
  return next;
}

function textBody(raw) {
  const body = raw == null ? '' : String(raw);
  return body && !body.endsWith('\n') ? `${body}\n` : body;
}

function baseName(ref) {
  return String(ref || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

function depthOf(rel) {
  return rel ? rel.split('/').length : 0;
}

// Save writes a sketch's cards flat under the destination (one folder per
// folder card, never one per lane), copies its lanes onto the destination
// surface, and records the arrangement in LANES.json beside the files.
async function saveSketch(db, ctx, dest, model) {
  if (!model || typeof model !== 'object') throw fail('BOARD_BAD_INPUT', 'Save needs a model');
  const lanes = Array.isArray(model.lanes) ? model.lanes : [];
  const cards = Array.isArray(model.cards) ? model.cards : [];
  const laneRows = new Map(lanes.map(l => [l.lane_id, l]));
  const laneOf = new Map();
  const laneFor = id => {
    if (laneOf.has(id)) return laneOf.get(id);
    const l = laneRows.get(id);
    if (!l) throw fail('BOARD_NOT_FOUND', `No such lane in the sketch: ${id}`);
    const parentLaneId = l.parent_lane_id != null && laneRows.has(l.parent_lane_id) ? laneFor(l.parent_lane_id).lane_id : null;
    const row = insertLane(db, {
      surface: joinRel(dest, relPath(l.surface, 'A surface')),
      parentLaneId,
      name: needLaneName(l.name),
      orientation: l.orientation === 'horizontal' ? 'horizontal' : 'vertical',
      x: parentLaneId == null ? parseCoord(l.x, 'x') : null,
      y: parentLaneId == null ? parseCoord(l.y, 'y') : null,
      w: parseLaneWidth(l.w),
      now: ctx.now
    });
    laneOf.set(id, row);
    return row;
  };
  for (const l of lanes) laneFor(l.lane_id);

  const ordered = [...cards].sort((a, b) => {
    const fa = a.kind === 'folder' ? 0 : 1;
    const fb = b.kind === 'folder' ? 0 : 1;
    return fa - fb || depthOf(String(a.surface || '')) - depthOf(String(b.surface || '')) || (a.sort_order ?? 0) - (b.sort_order ?? 0);
  });
  const usedBySurface = new Map([[dest, new Set(['LANES.json'])]]);
  const used = surface => {
    if (!usedBySurface.has(surface)) usedBySurface.set(surface, new Set());
    return usedBySurface.get(surface);
  };
  const surfaces = new Set([dest]);
  for (const card of ordered) {
    const kind = String(card.kind || '');
    const surface = joinRel(dest, relPath(card.surface, 'A surface'));
    surfaces.add(surface);
    const laneId = card.lane_id != null ? laneFor(card.lane_id).lane_id : null;
    const color = parseColor(card.color);
    const fields_json = parseFields(card, card.fields_json || '[]');
    let title = card.title == null ? null : String(card.title);
    let ref;
    let iconKind = 'file';
    let rowKind = 'file';
    let width = null;
    if (kind === 'folder') {
      const name = needName(baseName(card.ref) || card.title);
      ref = childRel(surface, name);
      ensureFolder(ctx.store, ctx.rootPath, ref);
      rowKind = 'folder';
      iconKind = 'folder';
      if (title == null) title = name;
    } else {
      let name;
      let content;
      if (kind === 'image') {
        const image = imageDataUrl(card.ref);
        name = uniqueName(used(surface), imageFileName(card.title, image.mime));
        content = Buffer.from(image.base64, 'base64');
        iconKind = 'image';
        width = parseWidth(card.width);
        if (title == null) title = name;
      } else if (kind === 'file') {
        name = uniqueName(used(surface), needName(baseName(card.ref) || card.title || 'file.md'));
        content = textBody(card.body != null ? card.body : '');
        if (title == null && String(content).trim()) title = String(content).trim().split('\n')[0];
      } else if (kind === 'note') {
        name = uniqueName(used(surface), slugFile(card.ref || card.title || 'note', '.md'));
        content = textBody(card.ref || '');
        iconKind = 'note';
        if (title == null) title = String(card.ref || '').split('\n')[0] || name;
      } else if (kind === 'link') {
        name = uniqueName(used(surface), slugFile(card.title || card.ref || 'link', '.md'));
        content = textBody(card.ref || '');
        iconKind = 'link';
      } else {
        throw fail('BOARD_BAD_INPUT', `Unknown card kind: ${kind}`);
      }
      ref = await writeNewFile({ ...ctx, rel: childRel(surface, name), content });
      if (title == null) title = name;
    }
    // The sticky text typed on a file or folder of the sketch becomes its sticky note.
    const text = String(card.text || '').trim();
    if ((kind === 'file' || kind === 'folder') && text) {
      await stickies.action({ action: 'set', payload: { rootPath: ctx.rootPath, path: ref, text, color }, surface: 'owner' });
    }
    insertCard(db, {
      surface, laneId, kind: rowKind, ref, title, color,
      face: parseFace(card.face, null),
      icon: parseIcon(card.icon, defaultIcon(iconKind)),
      fields_json, width, now: ctx.now
    });
  }

  const outline = {};
  const laneOutline = lane => ({
    name: lane.name,
    slug: lane.slug,
    orientation: lane.orientation,
    x: lane.x,
    y: lane.y,
    w: lane.w,
    cards: lane.cards.map(c => c.ref),
    lanes: lane.lanes.map(laneOutline)
  });
  for (const surface of surfaces) {
    const t = tree(db, surface);
    outline[surface.slice(dest.length).replace(/^\//, '')] = { lanes: t.lanes.map(laneOutline), cards: t.cards.map(c => c.ref) };
  }
  await writeNewFile({ ...ctx, rel: childRel(dest, 'LANES.json'), content: `${JSON.stringify(outline, null, 2)}\n` });
}

function tree(db, surface) {
  return nestTree(
    surface,
    db.prepare('SELECT * FROM board_lanes WHERE surface=? ORDER BY sort_order, lane_id').all(surface),
    db.prepare('SELECT * FROM board_cards WHERE surface=? ORDER BY sort_order, card_id').all(surface)
  );
}

// The lane's plan: its own cards, then each child lane's cards, depth-first,
// in canvas order, so serial and parallel order on the canvas is step order.
// A folder card is a surface to open, not a step (owner, RO-24b).
function laneNode(nodes, laneId) {
  for (const node of nodes) {
    if (node.lane_id === laneId) return node;
    const hit = laneNode(node.lanes, laneId);
    if (hit) return hit;
  }
  return null;
}

function planSteps(node, out = []) {
  for (const card of node.cards) if (card.kind !== 'folder') out.push({ card: card.ref, kind: card.kind, status: 'todo' });
  for (const sub of node.lanes) planSteps(sub, out);
  return out;
}

// What the lane header shows. The run is the state; step and total are read
// from it on every call, null when the state row is gone.
function laneRun(exec, lane) {
  const record = exec.getExecutionState(lane.run_id);
  const state = record?.state;
  const step = Number(state?.step);
  return {
    laneId: lane.lane_id,
    runId: lane.run_id,
    step: record ? (Number.isFinite(step) ? step : 0) + 1 : null,
    total: record ? (Array.isArray(state.steps) ? state.steps.length : 0) : null
  };
}

const AGENT_READS = new Set(['tree', 'lane-run-state']);

export const plugin = {
  id: 'board',
  label: 'Board',
  order: 75,
  scope: 'workspace',
  surface: 'main',
  category: 'planning',
  requiresWorkspace: true,
  description: 'Planning board content: lanes (serial or parallel, no disk entry, placed on a canvas by x, y, w, addressed by slug, runnable as an execution-state run) and cards (files, folders, links, notes) per surface folder, stored per workspace in .research-ops/board.sqlite3. A file card is a real file and a folder card is a real folder.',
  async action({ action, payload, surface: caller, store, plugins }) {
    // Whitelist, not per-action gates: any future mutation defaults to refused.
    if (caller === 'agent' && !AGENT_READS.has(action)) {
      throw fail('OWNER_SURFACE_ONLY', 'The board is arranged on the owner surface; agents may only read the tree and a lane\'s run state.');
    }
    const db = boardDb(payload.rootPath);
    const now = () => new Date().toISOString();
    const rootPath = payload.rootPath;
    const surface = relPath(payload.surface, 'A surface');

    if (action === 'tree') return tree(db, surface);

    if (action === 'lane-run-state') {
      const lane = laneOn(db, Number(payload.laneId), surface);
      return lane.run_id == null ? null : laneRun(mustStore(store), lane);
    }

    // One-way guarantee across two databases: the run id lands on the lane
    // only if the state seeded (the lane update is rolled back when
    // initExecutionState throws). A COMMIT that fails after the seed leaves a
    // state row in control.sqlite3 that no lane names.
    if (action === 'run-lane') {
      const lane = laneOn(db, Number(payload.laneId), surface);
      const exec = mustStore(store);
      if (lane.run_id != null) return { ...laneRun(exec, lane), created: false };
      const runId = `${lane.slug || 'lane'}-${crypto.randomBytes(4).toString('hex')}`;
      const steps = planSteps(laneNode(tree(db, surface).lanes, lane.lane_id));
      if (!steps.length) throw fail('BOARD_BAD_INPUT', 'Nothing to run: the lane has no cards');
      db.exec('BEGIN');
      try {
        db.prepare('UPDATE board_lanes SET run_id=? WHERE lane_id=?').run(runId, lane.lane_id);
        exec.initExecutionState({ runId, initial: { board: { surface, lane: lane.slug }, steps, step: 0 } });
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return { ...laneRun(exec, mustLane(db, lane.lane_id)), created: true };
    }

    if (action === 'add-lane') {
      return insertLane(db, {
        surface,
        parentLaneId: idOrNull(payload.parentLaneId),
        name: needLaneName(payload.name),
        orientation: payload.orientation == null ? 'vertical' : parseOrientation(payload.orientation),
        x: parseCoord(payload.x, 'x'),
        y: parseCoord(payload.y, 'y'),
        w: parseLaneWidth(payload.w),
        now
      });
    }

    if (action === 'add-card') {
      const kind = String(payload.kind || '');
      const laneId = idOrNull(payload.laneId);
      if (laneId != null) laneOn(db, laneId, surface);
      if (!['file', 'folder', 'link', 'note'].includes(kind)) throw fail('BOARD_BAD_INPUT', `Unknown card kind: ${kind}`);
      const color = parseColor(payload.color);
      let ref;
      let title = payload.title == null ? null : String(payload.title);
      if (kind === 'folder') {
        const name = needName(payload.name);
        ref = childRel(surface, name);
        ensureFolder(store, rootPath, ref);
        if (title == null) title = name;
      } else if (kind === 'file' && payload.ref != null && payload.ref !== '') {
        ref = relPath(payload.ref, 'A file');
        if (!underSurface(ref, surface)) {
          throw fail('BOARD_OUTSIDE_SURFACE', `${ref} is not under the surface '${surface || 'workspace root'}'`);
        }
        const abs = absIn(rootPath, ref);
        mustStore(store).assertInsideWorkspace(rootPath, abs);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw fail('BOARD_NOT_FOUND', `No such file: ${ref}`);
        const carded = db.prepare('SELECT lane_id FROM board_cards WHERE surface=? AND kind=? AND ref=?').get(surface, 'file', ref);
        if (carded) {
          const where = carded.lane_id == null ? 'on the floor' : `in lane ${mustLane(db, carded.lane_id).name}`;
          throw fail('BOARD_DUPLICATE', `${ref} is already on this surface, ${where}`);
        }
      } else if (kind === 'file') {
        const name = needName(payload.name);
        const body = payload.body == null ? '' : String(payload.body);
        ref = await writeNewFile({ store, plugins, rootPath, rel: childRel(surface, name), content: textBody(body) });
        if (title == null && body.trim()) title = body.trim().split('\n')[0];
      } else {
        ref = String(payload.ref || '').trim();
        if (!ref) throw fail('BOARD_BAD_INPUT', 'A card needs a ref (path, url, or note text)');
      }
      return insertCard(db, {
        surface, laneId, kind, ref, title, color,
        face: parseFace(payload.face, null),
        icon: parseIcon(payload.icon, defaultIcon(kind)),
        fields_json: parseFields(payload, '[]'),
        now
      });
    }

    if (action === 'rename') {
      const lane = mustLane(db, Number(payload.laneId));
      const name = needLaneName(payload.name);
      db.prepare('UPDATE board_lanes SET name=?, slug=? WHERE lane_id=?').run(name, slugOn(db, lane.surface, name, lane.lane_id), lane.lane_id);
      return mustLane(db, lane.lane_id);
    }

    if (action === 'set-width') {
      const lane = mustLane(db, Number(payload.laneId));
      if (lane.parent_lane_id != null) throw fail('BOARD_BAD_INPUT', 'Only a top-level lane has a width; a nested lane flows in its parent');
      db.prepare('UPDATE board_lanes SET w=? WHERE lane_id=?').run(parseLaneWidth(payload.w), lane.lane_id);
      return mustLane(db, lane.lane_id);
    }

    if (action === 'set-orientation') {
      const lane = mustLane(db, Number(payload.laneId));
      db.prepare('UPDATE board_lanes SET orientation=? WHERE lane_id=?').run(parseOrientation(payload.orientation), lane.lane_id);
      return mustLane(db, lane.lane_id);
    }

    if (action === 'update-card') {
      const card = mustCard(db, Number(payload.cardId));
      const color = payload.color === undefined ? card.color : parseColor(payload.color);
      let title = card.title;
      let ref = card.ref;
      if (payload.name !== undefined && payload.name !== null) {
        const t = String(payload.name).trim();
        if (t) title = t;
      }
      if (payload.text !== undefined && payload.text !== null) {
        const t = String(payload.text).trim();
        if (t) {
          if (card.kind === 'note') {
            ref = t;
            if (payload.name === undefined) title = t;
          } else if (card.kind === 'link' && payload.name === undefined) {
            title = t;
          }
        }
      }
      const face = parseFace(payload.face, card.face);
      const icon = parseIcon(payload.icon, card.icon);
      const fields_json = parseFields(payload, card.fields_json);
      const width = payload.width === undefined ? card.width : parseWidth(payload.width);
      db.prepare('UPDATE board_cards SET color=?, title=?, ref=?, face=?, icon=?, fields_json=?, width=? WHERE card_id=?')
        .run(color, title, ref, face, icon, fields_json, width, card.card_id);
      return mustCard(db, card.card_id);
    }

    if (action === 'move-card') {
      const sortOrder = Number(payload.sortOrder);
      if (!Number.isFinite(sortOrder)) throw fail('BOARD_BAD_INPUT', 'Move needs a numeric sortOrder');
      const card = mustCard(db, Number(payload.cardId));
      const toLaneId = payload.toLaneId === undefined ? card.lane_id : idOrNull(payload.toLaneId);
      if (toLaneId != null) laneOn(db, toLaneId, card.surface);
      db.prepare('UPDATE board_cards SET lane_id=?, sort_order=? WHERE card_id=?').run(toLaneId, sortOrder, card.card_id);
      return mustCard(db, card.card_id);
    }

    // Into a parent: the lane flows there and drops its position, keeping
    // its w for the way back. Onto the canvas: it sits at x, y (the
    // payload's, else its own, else the landing spot).
    if (action === 'move-lane') {
      const lane = mustLane(db, Number(payload.laneId));
      const toParentId = idOrNull(payload.parentLaneId);
      let spot = { x: null, y: null, w: lane.w };
      if (toParentId != null) {
        laneOn(db, toParentId, lane.surface);
        assertNoCycle(lane.lane_id, toParentId, parentOf(db));
        assertDepth(laneDepth(toParentId, parentOf(db)) + subtreeHeight(lane.lane_id, childrenOf(db)));
      } else {
        const x = parseCoord(payload.x, 'x');
        const y = parseCoord(payload.y, 'y');
        spot = x != null && y != null ? { x, y, w: lane.w }
          : lane.x != null ? { x: lane.x, y: lane.y, w: lane.w }
            : { ...landingSpot(topLanes(db, lane.surface).filter(l => l.lane_id !== lane.lane_id)), w: lane.w };
      }
      const sortOrder = payload.sortOrder != null ? Number(payload.sortOrder)
        : toParentId === lane.parent_lane_id ? lane.sort_order : nextLaneOrder(db, lane.surface, toParentId);
      if (!Number.isFinite(sortOrder)) throw fail('BOARD_BAD_INPUT', 'Move needs a numeric sortOrder');
      db.prepare('UPDATE board_lanes SET parent_lane_id=?, x=?, y=?, w=?, sort_order=? WHERE lane_id=?')
        .run(toParentId, spot.x, spot.y, spot.w, sortOrder, lane.lane_id);
      return mustLane(db, lane.lane_id);
    }

    if (action === 'remove') {
      if (payload.cardId != null) {
        mustCard(db, Number(payload.cardId));
        db.prepare('DELETE FROM board_cards WHERE card_id=?').run(Number(payload.cardId));
        return { removed: 'card', cardId: Number(payload.cardId) };
      }
      const lane = mustLane(db, Number(payload.laneId));
      for (const id of laneSubtree(db, lane.lane_id)) {
        for (const card of db.prepare('SELECT card_id FROM board_cards WHERE lane_id=? ORDER BY sort_order, card_id').all(id)) {
          db.prepare('UPDATE board_cards SET lane_id=NULL, sort_order=? WHERE card_id=?')
            .run(nextCardOrder(db, lane.surface, null), card.card_id);
        }
      }
      db.prepare('DELETE FROM board_lanes WHERE lane_id=?').run(lane.lane_id);
      return { removed: 'lane', laneId: lane.lane_id, cards: 'floor' };
    }

    // Save creates <parent>/<name> for the sketch and refuses a folder that exists.
    if (action === 'save-to-project') {
      const dest = joinRel(relPath(payload.parent, 'A parent folder'), needName(payload.name));
      const target = absIn(rootPath, dest);
      mustStore(store).assertInsideWorkspace(rootPath, target);
      if (fs.existsSync(target)) throw fail('BOARD_EXISTS', `${dest} exists`);
      store.createDirectory({ rootPath, dirPath: target, actor: 'human' });
      await saveSketch(db, { store, plugins, rootPath, now }, dest, payload.model);
      return { destination: dest, ...tree(db, dest) };
    }

    throw new Error(`Unknown board action: ${action}`);
  }
};
