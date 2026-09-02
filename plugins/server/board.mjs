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
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS board_cards (
      card_id INTEGER PRIMARY KEY,
      group_id INTEGER NULL REFERENCES board_groups(group_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('file','link','note')),
      ref TEXT NOT NULL,
      title TEXT,
      color TEXT,
      sort_order INTEGER NOT NULL DEFAULT 100,
      created_at TEXT NOT NULL
    );
  `);
  // Boards written before sticky colors or folder_path existed lack the columns.
  const cardColumns = db.prepare('PRAGMA table_info(board_cards)').all().map(c => c.name);
  if (!cardColumns.includes('color')) db.exec('ALTER TABLE board_cards ADD COLUMN color TEXT');
  const groupColumns = db.prepare('PRAGMA table_info(board_groups)').all().map(c => c.name);
  if (!groupColumns.includes('folder_path')) db.exec('ALTER TABLE board_groups ADD COLUMN folder_path TEXT');
  handles.set(root, db);
  return db;
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function mustGroup(db, groupId) {
  const row = db.prepare('SELECT * FROM board_groups WHERE group_id=?').get(groupId);
  if (!row) throw fail('BOARD_NOT_FOUND', `No such group: ${groupId}`);
  return row;
}

function mustCard(db, cardId) {
  const row = db.prepare('SELECT * FROM board_cards WHERE card_id=?').get(cardId);
  if (!row) throw fail('BOARD_NOT_FOUND', `No such card: ${cardId}`);
  return row;
}

function mustStore(store) {
  if (!store) throw fail('BOARD_NO_STORE', 'File and folder writes need the control store');
  return store;
}

function needName(payload) {
  const name = String(payload.name || '').trim();
  if (!name) throw fail('BOARD_BAD_INPUT', 'A name is required');
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
    'INSERT INTO board_groups (parent_id, title, orientation, sort_order, folder_path, created_at) VALUES (?,?,?,?,?,?)'
  ).run(parentId, title, orientation, sortOrder, folder_path, now());
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
  const byId = new Map(groups.map(g => [g.group_id, { ...g, groups: [], cards: [] }]));
  const rootCards = [];
  for (const card of cards) {
    if (card.group_id == null) rootCards.push(card);
    else byId.get(card.group_id)?.cards.push(card);
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

    if (action === 'add-group') {
      const title = String(payload.title || '').trim();
      if (!title) throw fail('BOARD_BAD_INPUT', 'A group needs a title');
      const parentId = payload.parentId == null ? null : Number(payload.parentId);
      const orientation = payload.orientation || 'vertical';
      return createBoundGroup(db, { store, rootPath, parentId, title, orientation, now });
    }

    if (action === 'add-card') {
      const kind = String(payload.kind || '');
      if (kind === 'folder') {
        const name = needName(payload);
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
        const name = needName(payload);
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

      const { lastInsertRowid } = db.prepare(
        'INSERT INTO board_cards (group_id, kind, ref, title, color, sort_order, created_at) VALUES (?,?,?,?,?,?,?)'
      ).run(groupId, kind, ref, title, color, sortOrder, now());
      return mustCard(db, Number(lastInsertRowid));
    }

    if (action === 'bind-group') {
      const group = mustGroup(db, Number(payload.groupId));
      if (group.folder_path) return group;
      const parent = group.parent_id == null ? { folder_path: '' } : mustGroup(db, group.parent_id);
      if (group.parent_id != null && !parent.folder_path) {
        throw fail('BOARD_UNBOUND', `Bind group ${group.parent_id} to a folder first`);
      }
      const folder_path = childRel(parent.folder_path, group.title);
      ensureFolder(store, rootPath, folder_path);
      db.prepare('UPDATE board_groups SET folder_path=? WHERE group_id=?').run(folder_path, group.group_id);
      return mustGroup(db, group.group_id);
    }

    if (action === 'rename') {
      const title = String(payload.title || '').trim();
      if (!title) throw fail('BOARD_BAD_INPUT', 'Rename needs a title');
      mustGroup(db, Number(payload.groupId));
      db.prepare('UPDATE board_groups SET title=? WHERE group_id=?').run(title, Number(payload.groupId));
      return mustGroup(db, Number(payload.groupId));
    }

    if (action === 'update-card') {
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
      db.prepare('UPDATE board_cards SET color=?, title=?, ref=? WHERE card_id=?')
        .run(color, title, ref, card.card_id);
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
