// Service: the planning board. A group is a real folder, a file card is a
// real file. Content rows live in the workspace's own
// <root>/.research-ops/board.sqlite3. Path bytes go through the control
// store's guarded write (assertInsideWorkspace, create-only, register).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { STICKY_COLORS } from './stickies.mjs';

const handles = new Map();

function boardDb(rootPath) {
  const root = path.resolve(String(rootPath || ''));
  if (!rootPath || !fs.existsSync(root)) throw new Error(`Board needs an existing workspace rootPath, got: ${rootPath}`);
  let db = handles.get(root);
  if (db) return db;
  const home = path.join(root, '.research-ops');
  fs.mkdirSync(home, { recursive: true });
  db = new DatabaseSync(path.join(home, 'board.sqlite3'));
  // foreign_keys is per-connection; the cached handle keeps it for its lifetime.
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS board_groups (
      group_id INTEGER PRIMARY KEY,
      parent_id INTEGER NULL REFERENCES board_groups(group_id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      orientation TEXT NOT NULL DEFAULT 'vertical' CHECK(orientation IN ('horizontal','vertical')),
      sort_order INTEGER NOT NULL DEFAULT 100,
      folder_path TEXT,
      color TEXT,
      face TEXT,
      icon TEXT,
      fields_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS board_cards (
      card_id INTEGER PRIMARY KEY,
      group_id INTEGER NULL REFERENCES board_groups(group_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('file','link','note')),
      ref TEXT NOT NULL,
      title TEXT,
      color TEXT,
      face TEXT,
      icon TEXT,
      fields_json TEXT,
      sort_order INTEGER NOT NULL DEFAULT 100,
      created_at TEXT NOT NULL
    );
  `);
  // Boards written before sticky colors, folder_path, or the two faces existed lack the columns.
  const cardColumns = db.prepare('PRAGMA table_info(board_cards)').all().map(c => c.name);
  if (!cardColumns.includes('color')) db.exec('ALTER TABLE board_cards ADD COLUMN color TEXT');
  if (!cardColumns.includes('face')) db.exec('ALTER TABLE board_cards ADD COLUMN face TEXT');
  if (!cardColumns.includes('icon')) db.exec('ALTER TABLE board_cards ADD COLUMN icon TEXT');
  if (!cardColumns.includes('fields_json')) db.exec('ALTER TABLE board_cards ADD COLUMN fields_json TEXT');
  const groupColumns = db.prepare('PRAGMA table_info(board_groups)').all().map(c => c.name);
  if (!groupColumns.includes('folder_path')) db.exec('ALTER TABLE board_groups ADD COLUMN folder_path TEXT');
  if (!groupColumns.includes('color')) db.exec('ALTER TABLE board_groups ADD COLUMN color TEXT');
  if (!groupColumns.includes('face')) db.exec('ALTER TABLE board_groups ADD COLUMN face TEXT');
  if (!groupColumns.includes('icon')) db.exec('ALTER TABLE board_groups ADD COLUMN icon TEXT');
  if (!groupColumns.includes('fields_json')) db.exec('ALTER TABLE board_groups ADD COLUMN fields_json TEXT');
  // Boards written when group_id was NOT NULL refuse a root file or note.
  // CREATE TABLE IF NOT EXISTS does not rebuild; copy into a nullable table.
  const groupIdCol = db.prepare('PRAGMA table_info(board_cards)').all().find(c => c.name === 'group_id');
  if (groupIdCol && groupIdCol.notnull) {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      CREATE TABLE board_cards_new (
        card_id INTEGER PRIMARY KEY,
        group_id INTEGER NULL REFERENCES board_groups(group_id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('file','link','note')),
        ref TEXT NOT NULL,
        title TEXT,
        color TEXT,
        face TEXT,
        icon TEXT,
        fields_json TEXT,
        sort_order INTEGER NOT NULL DEFAULT 100,
        created_at TEXT NOT NULL
      );
      INSERT INTO board_cards_new (card_id, group_id, kind, ref, title, color, face, icon, fields_json, sort_order, created_at)
        SELECT card_id, group_id, kind, ref, title, color, face, icon, fields_json, sort_order, created_at FROM board_cards;
      DROP TABLE board_cards;
      ALTER TABLE board_cards_new RENAME TO board_cards;
      PRAGMA foreign_keys=ON;
    `);
  }
  handles.set(root, db);
  return db;
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const NAMED_ICONS = ['file', 'folder', 'note', 'link'];
const MAX_FIELDS = 4;

function defaultFace(kind) {
  return kind === 'folder' ? 'sticky' : 'card';
}

function defaultIcon(kind) {
  return NAMED_ICONS.includes(kind) ? kind : 'file';
}

function parseFace(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const face = String(raw);
  if (face !== 'card' && face !== 'sticky') throw fail('BOARD_BAD_INPUT', `Unknown face: ${face}`);
  return face;
}

function parseIcon(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const icon = String(raw);
  if (NAMED_ICONS.includes(icon)) return icon;
  if ([...icon].length === 1) return icon;
  throw fail('BOARD_BAD_INPUT', `Unknown icon: ${icon}`);
}

function parseFields(payload, existingJson) {
  if (payload.fields === undefined && payload.fields_json === undefined) {
    return existingJson ?? '[]';
  }
  let arr;
  if (payload.fields !== undefined) {
    arr = payload.fields;
  } else if (payload.fields_json == null || payload.fields_json === '') {
    arr = [];
  } else if (typeof payload.fields_json === 'string') {
    try { arr = JSON.parse(payload.fields_json); }
    catch { throw fail('BOARD_BAD_INPUT', 'fields_json is not JSON'); }
  } else {
    arr = payload.fields_json;
  }
  if (!Array.isArray(arr)) throw fail('BOARD_BAD_INPUT', 'fields must be an array');
  if (arr.length > MAX_FIELDS) throw fail('BOARD_BAD_INPUT', 'A card holds at most four fields');
  const clean = arr.map(item => {
    if (!item || typeof item !== 'object') throw fail('BOARD_BAD_INPUT', 'Each field needs a label and a value');
    return { label: String(item.label ?? ''), value: String(item.value ?? '') };
  });
  return JSON.stringify(clean);
}

function viewCard(row) {
  if (!row) return row;
  return {
    ...row,
    face: row.face || defaultFace(row.kind),
    icon: row.icon || defaultIcon(row.kind),
    fields_json: row.fields_json || '[]'
  };
}

function viewGroup(row) {
  if (!row) return row;
  return {
    ...row,
    face: row.face || 'sticky',
    icon: row.icon || 'folder',
    fields_json: row.fields_json || '[]'
  };
}

function mustGroup(db, groupId) {
  const row = db.prepare('SELECT * FROM board_groups WHERE group_id=?').get(groupId);
  if (!row) throw fail('BOARD_NOT_FOUND', `No such group: ${groupId}`);
  return viewGroup(row);
}

function mustCard(db, cardId) {
  const row = db.prepare('SELECT * FROM board_cards WHERE card_id=?').get(cardId);
  if (!row) throw fail('BOARD_NOT_FOUND', `No such card: ${cardId}`);
  return viewCard(row);
}

function mustStore(store) {
  if (!store) throw fail('BOARD_NO_STORE', 'File and folder writes need the control store');
  return store;
}

function needName(raw) {
  const name = String(raw || '').trim();
  if (!name) throw fail('BOARD_BAD_INPUT', 'A name is required');
  if (name === '.' || name === '..' || /[\\/]/.test(name)) {
    throw fail('BOARD_BAD_INPUT', 'A name is one path segment');
  }
  return name;
}

function childRel(parentRel, name) {
  return parentRel ? `${parentRel.replace(/\/+$/, '')}/${name}` : name;
}

function absIn(rootPath, rel) {
  return path.join(path.resolve(rootPath), rel);
}

// The board stops at three levels of groups (owner rule): root, subgroup, and
// a third nest for the finest grain. The cap gates mutations only — a deeper
// tree written before the rule still renders. Depth 3 holds files only.
const MAX_DEPTH = 3;

function groupDepth(db, groupId) {
  let depth = 0;
  let cursor = groupId;
  while (cursor != null) { depth++; cursor = mustGroup(db, cursor).parent_id; }
  return depth;
}

function subtreeHeight(db, groupId) {
  const children = db.prepare('SELECT group_id FROM board_groups WHERE parent_id=?').all(groupId);
  let deepest = 0;
  for (const child of children) deepest = Math.max(deepest, subtreeHeight(db, child.group_id));
  return 1 + deepest;
}

// New siblings land after the last one, with a gap the client can drag into.
function nextOrder(db, table, where, value) {
  const row = db.prepare(`SELECT MAX(sort_order) AS top FROM ${table} WHERE ${where}`).get(value);
  return row?.top == null ? 100 : Number(row.top) + 10;
}

function parentFolder(db, parentId) {
  if (parentId == null) return { folder_path: '' };
  const parent = mustGroup(db, parentId);
  if (!parent.folder_path) throw fail('BOARD_UNBOUND', `Bind group ${parentId} to a folder first`);
  return parent;
}

// A group is a folder. Missing: mkdir. Already there: bind to it. A file
// at that path is not a group and is refused. createDirectory still throws
// if the path exists, so the exist-and-adopt check sits in front of it.
function ensureFolder(store, rootPath, folder_path) {
  const target = absIn(rootPath, folder_path);
  mustStore(store).assertInsideWorkspace(rootPath, target);
  if (!fs.existsSync(target)) {
    store.createDirectory({ rootPath, dirPath: target, actor: 'human' });
  } else if (!fs.statSync(target).isDirectory()) {
    throw fail('BOARD_BAD_INPUT', `Not a folder: ${folder_path}`);
  }
  return target;
}

function createBoundGroup(db, { store, rootPath, parentId, title, orientation, now }) {
  if (parentId != null) {
    mustGroup(db, parentId);
    if (groupDepth(db, parentId) >= MAX_DEPTH) {
      throw fail('BOARD_DEPTH', `Groups nest at most ${MAX_DEPTH} deep`);
    }
  }
  if (!['horizontal', 'vertical'].includes(orientation)) throw fail('BOARD_BAD_INPUT', `Unknown orientation: ${orientation}`);
  const parent = parentFolder(db, parentId);
  const folder_path = childRel(parent.folder_path, title);
  ensureFolder(store, rootPath, folder_path);
  const sortOrder = nextOrder(db, 'board_groups', parentId == null ? 'parent_id IS NULL AND ?=1' : 'parent_id=?', parentId == null ? 1 : parentId);
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO board_groups (parent_id, title, orientation, sort_order, folder_path, created_at, face, icon, fields_json) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(parentId, title, orientation, sortOrder, folder_path, now(), 'sticky', 'folder', '[]');
  return mustGroup(db, Number(lastInsertRowid));
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

function tree(db) {
  const groups = db.prepare('SELECT * FROM board_groups ORDER BY sort_order, group_id').all();
  const cards = db.prepare('SELECT * FROM board_cards ORDER BY sort_order, card_id').all();
  const byId = new Map(groups.map(g => [g.group_id, { ...viewGroup(g), groups: [], cards: [] }]));
  const rootCards = [];
  for (const card of cards) {
    const viewed = viewCard(card);
    if (card.group_id == null) rootCards.push(viewed);
    else byId.get(card.group_id)?.cards.push(viewed);
  }
  const roots = [];
  for (const node of byId.values()) {
    if (node.parent_id != null && byId.has(node.parent_id)) byId.get(node.parent_id).groups.push(node);
    else roots.push(node);
  }
  return { groups: roots, cards: rootCards };
}

export const plugin = {
  id: 'board',
  label: 'Board',
  order: 75,
  scope: 'workspace',
  surface: 'main',
  category: 'planning',
  requiresWorkspace: true,
  description: 'Planning board content: groups, subgroups and cards (files, links, notes) stored per workspace in .research-ops/board.sqlite3. A group is a real folder and a file card is a real file.',
  async action({ action, payload, surface, store, plugins }) {
    // Whitelist, not per-action gates: any future mutation defaults to refused.
    if (surface === 'agent' && action !== 'tree') {
      throw fail('OWNER_SURFACE_ONLY', 'The board is arranged on the owner surface; agents may only read the tree.');
    }
    const db = boardDb(payload.rootPath);
    const now = () => new Date().toISOString();
    const rootPath = payload.rootPath;

    if (action === 'tree') return tree(db);

    if (action === 'add-card') {
      const kind = String(payload.kind || '');
      if (kind === 'folder') {
        const name = needName(payload.name);
        const parentId = payload.groupId == null || payload.groupId === '' ? null : Number(payload.groupId);
        return createBoundGroup(db, { store, rootPath, parentId, title: name, orientation: 'vertical', now });
      }

      const groupId = payload.groupId == null || payload.groupId === '' ? null : Number(payload.groupId);
      if (groupId != null) mustGroup(db, groupId);
      if (!['file', 'link', 'note'].includes(kind)) throw fail('BOARD_BAD_INPUT', `Unknown card kind: ${kind}`);
      const color = payload.color == null ? null : String(payload.color);
      if (color != null && !STICKY_COLORS.includes(color)) throw fail('BOARD_BAD_INPUT', `Not a sticky color: ${color}`);
      const sortWhere = groupId == null ? 'group_id IS NULL AND ?=1' : 'group_id=?';
      const sortValue = groupId == null ? 1 : groupId;
      const sortOrder = nextOrder(db, 'board_cards', sortWhere, sortValue);

      let ref;
      let title = payload.title == null ? null : String(payload.title);
      if (kind === 'file') {
        const name = needName(payload.name);
        const parent = parentFolder(db, groupId);
        const rel = childRel(parent.folder_path, name);
        const body = payload.body == null ? '' : String(payload.body);
        const content = body && !body.endsWith('\n') ? `${body}\n` : body;
        ref = await writeNewFile({ store, plugins, rootPath, rel, content });
        if (title == null && body.trim()) title = body.trim().split('\n')[0];
      } else {
        ref = String(payload.ref || '').trim();
        if (!ref) throw fail('BOARD_BAD_INPUT', 'A card needs a ref (path, url, or note text)');
      }

      const face = parseFace(payload.face, defaultFace(kind));
      const icon = parseIcon(payload.icon, defaultIcon(kind));
      const fields_json = parseFields(payload, '[]');
      const { lastInsertRowid } = db.prepare(
        'INSERT INTO board_cards (group_id, kind, ref, title, color, sort_order, created_at, face, icon, fields_json) VALUES (?,?,?,?,?,?,?,?,?,?)'
      ).run(groupId, kind, ref, title, color, sortOrder, now(), face, icon, fields_json);
      return mustCard(db, Number(lastInsertRowid));
    }

    if (action === 'bind-group') {
      const group = mustGroup(db, Number(payload.groupId));
      if (group.folder_path) return group;
      const parent = group.parent_id == null ? { folder_path: '' } : mustGroup(db, group.parent_id);
      if (group.parent_id != null && !parent.folder_path) {
        throw fail('BOARD_UNBOUND', `Bind group ${group.parent_id} to a folder first`);
      }
      const title = needName(group.title);
      const folder_path = childRel(parent.folder_path, title);
      ensureFolder(store, rootPath, folder_path);
      db.prepare('UPDATE board_groups SET folder_path=? WHERE group_id=?').run(folder_path, group.group_id);
      return mustGroup(db, group.group_id);
    }

    if (action === 'rename') {
      const title = needName(payload.title);
      const group = mustGroup(db, Number(payload.groupId));
      if (!group.folder_path) {
        db.prepare('UPDATE board_groups SET title=? WHERE group_id=?').run(title, group.group_id);
        return mustGroup(db, group.group_id);
      }
      if (title === group.title) return group;
      const parent = parentFolder(db, group.parent_id);
      const fromRel = group.folder_path;
      const toRel = childRel(parent.folder_path, title);
      mustStore(store).moveEntry({
        rootPath,
        fromPath: absIn(rootPath, fromRel),
        toPath: absIn(rootPath, toRel),
        actor: 'human'
      });
      db.prepare('UPDATE board_groups SET title=?, folder_path=? WHERE group_id=?')
        .run(title, toRel, group.group_id);
      db.prepare(`UPDATE board_groups SET folder_path=? || substr(folder_path, length(?)+1) WHERE folder_path LIKE ? || '/%'`)
        .run(toRel, fromRel, fromRel);
      db.prepare(`UPDATE board_cards SET ref=? || substr(ref, length(?)+1) WHERE kind='file' AND (ref=? OR ref LIKE ? || '/%')`)
        .run(toRel, fromRel, fromRel, fromRel);
      return mustGroup(db, group.group_id);
    }

    if (action === 'update-card') {
      if (payload.cardId == null && payload.groupId != null) {
        const group = mustGroup(db, Number(payload.groupId));
        let color = group.color;
        if (payload.color !== undefined) {
          color = payload.color == null ? null : String(payload.color);
          if (color != null && !STICKY_COLORS.includes(color)) throw fail('BOARD_BAD_INPUT', `Not a sticky color: ${color}`);
        }
        const face = parseFace(payload.face, group.face);
        const icon = parseIcon(payload.icon, group.icon);
        const fields_json = parseFields(payload, group.fields_json);
        db.prepare('UPDATE board_groups SET color=?, face=?, icon=?, fields_json=? WHERE group_id=?')
          .run(color, face, icon, fields_json, group.group_id);
        return mustGroup(db, group.group_id);
      }
      const card = mustCard(db, Number(payload.cardId));
      let color = card.color;
      if (payload.color !== undefined) {
        color = payload.color == null ? null : String(payload.color);
        if (color != null && !STICKY_COLORS.includes(color)) throw fail('BOARD_BAD_INPUT', `Not a sticky color: ${color}`);
      }
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
      db.prepare('UPDATE board_cards SET color=?, title=?, ref=?, face=?, icon=?, fields_json=? WHERE card_id=?')
        .run(color, title, ref, face, icon, fields_json, card.card_id);
      return mustCard(db, card.card_id);
    }

    if (action === 'set-orientation') {
      const orientation = String(payload.orientation || '');
      if (!['horizontal', 'vertical'].includes(orientation)) throw fail('BOARD_BAD_INPUT', `Unknown orientation: ${orientation}`);
      mustGroup(db, Number(payload.groupId));
      db.prepare('UPDATE board_groups SET orientation=? WHERE group_id=?').run(orientation, Number(payload.groupId));
      return mustGroup(db, Number(payload.groupId));
    }

    if (action === 'move') {
      const sortOrder = Number(payload.sortOrder);
      if (!Number.isFinite(sortOrder)) throw fail('BOARD_BAD_INPUT', 'Move needs a numeric sortOrder');
      if (payload.cardId != null) {
        const card = mustCard(db, Number(payload.cardId));
        const toGroupId = payload.toGroupId === undefined ? card.group_id
          : payload.toGroupId == null ? null : Number(payload.toGroupId);
        if (toGroupId != null) mustGroup(db, toGroupId);
        db.prepare('UPDATE board_cards SET group_id=?, sort_order=? WHERE card_id=?').run(toGroupId, sortOrder, card.card_id);
        return mustCard(db, card.card_id);
      }
      const group = mustGroup(db, Number(payload.groupId));
      const toParentId = payload.toParentId == null ? null : Number(payload.toParentId);
      if (toParentId != null) {
        // Walk the ancestor chain of the destination; hitting the moving group
        // (including the destination itself) would make it its own descendant.
        let cursor = toParentId;
        while (cursor != null) {
          if (cursor === group.group_id) throw fail('BOARD_CYCLE', 'Cannot move a group under itself or its own descendant');
          cursor = mustGroup(db, cursor).parent_id;
        }
        if (groupDepth(db, toParentId) + subtreeHeight(db, group.group_id) > MAX_DEPTH) {
          throw fail('BOARD_DEPTH', `Groups nest at most ${MAX_DEPTH} deep`);
        }
      }
      db.prepare('UPDATE board_groups SET parent_id=?, sort_order=? WHERE group_id=?').run(toParentId, sortOrder, group.group_id);
      return mustGroup(db, group.group_id);
    }

    if (action === 'remove') {
      if (payload.cardId != null) {
        mustCard(db, Number(payload.cardId));
        db.prepare('DELETE FROM board_cards WHERE card_id=?').run(Number(payload.cardId));
        return { removed: 'card', cardId: Number(payload.cardId), disk: 'left' };
      }
      mustGroup(db, Number(payload.groupId));
      db.prepare('DELETE FROM board_groups WHERE group_id=?').run(Number(payload.groupId));
      return { removed: 'group', groupId: Number(payload.groupId), disk: 'left' };
    }

    throw new Error(`Unknown board action: ${action}`);
  }
};
