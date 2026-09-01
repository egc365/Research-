// Service: the planning board — sticky notes that are real files (or links, or
// notes), in groups and subgroups, horizontal for hierarchy, vertical for
// serial execution order. Per the data rule this is CONTENT, so it lives in
// the workspace's own <root>/.research-ops/board.sqlite3, never in the
// control store — this plugin deliberately never touches `store`.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS board_cards (
      card_id INTEGER PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES board_groups(group_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('file','link','note')),
      ref TEXT NOT NULL,
      title TEXT,
      sort_order INTEGER NOT NULL DEFAULT 100,
      created_at TEXT NOT NULL
    );
  `);
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

// New siblings land after the last one, with a gap the client can drag into.
function nextOrder(db, table, where, value) {
  const row = db.prepare(`SELECT MAX(sort_order) AS top FROM ${table} WHERE ${where}`).get(value);
  return row?.top == null ? 100 : Number(row.top) + 10;
}

function tree(db) {
  const groups = db.prepare('SELECT * FROM board_groups ORDER BY sort_order, group_id').all();
  const cards = db.prepare('SELECT * FROM board_cards ORDER BY sort_order, card_id').all();
  const byId = new Map(groups.map(g => [g.group_id, { ...g, groups: [], cards: [] }]));
  for (const card of cards) byId.get(card.group_id)?.cards.push(card);
  const roots = [];
  for (const node of byId.values()) {
    if (node.parent_id != null && byId.has(node.parent_id)) byId.get(node.parent_id).groups.push(node);
    else roots.push(node);
  }
  return { groups: roots };
}

export const plugin = {
  id: 'board',
  label: 'Board',
  order: 75,
  scope: 'workspace',
  surface: 'main',
  category: 'planning',
  requiresWorkspace: true,
  description: 'Planning board content: groups, subgroups and cards (files, links, notes) stored per workspace in .research-ops/board.sqlite3.',
  async action({ action, payload, surface }) {
    // Whitelist, not per-action gates: any future mutation defaults to refused.
    if (surface === 'agent' && action !== 'tree') {
      throw fail('OWNER_SURFACE_ONLY', 'The board is arranged on the owner surface; agents may only read the tree.');
    }
    const db = boardDb(payload.rootPath);
    const now = () => new Date().toISOString();

    if (action === 'tree') return tree(db);

    if (action === 'add-group') {
      const title = String(payload.title || '').trim();
      if (!title) throw fail('BOARD_BAD_INPUT', 'A group needs a title');
      const parentId = payload.parentId == null ? null : Number(payload.parentId);
      if (parentId != null) mustGroup(db, parentId);
      const orientation = payload.orientation || 'vertical';
      if (!['horizontal', 'vertical'].includes(orientation)) throw fail('BOARD_BAD_INPUT', `Unknown orientation: ${orientation}`);
      const sortOrder = nextOrder(db, 'board_groups', parentId == null ? 'parent_id IS NULL AND ?=1' : 'parent_id=?', parentId == null ? 1 : parentId);
      const { lastInsertRowid } = db.prepare(
        'INSERT INTO board_groups (parent_id, title, orientation, sort_order, created_at) VALUES (?,?,?,?,?)'
      ).run(parentId, title, orientation, sortOrder, now());
      return mustGroup(db, Number(lastInsertRowid));
    }

    if (action === 'add-card') {
      const groupId = Number(payload.groupId);
      mustGroup(db, groupId);
      const kind = String(payload.kind || '');
      if (!['file', 'link', 'note'].includes(kind)) throw fail('BOARD_BAD_INPUT', `Unknown card kind: ${kind}`);
      const ref = String(payload.ref || '').trim();
      if (!ref) throw fail('BOARD_BAD_INPUT', 'A card needs a ref (path, url, or note text)');
      const sortOrder = nextOrder(db, 'board_cards', 'group_id=?', groupId);
      const { lastInsertRowid } = db.prepare(
        'INSERT INTO board_cards (group_id, kind, ref, title, sort_order, created_at) VALUES (?,?,?,?,?,?)'
      ).run(groupId, kind, ref, payload.title == null ? null : String(payload.title), sortOrder, now());
      return mustCard(db, Number(lastInsertRowid));
    }

    if (action === 'rename') {
      const title = String(payload.title || '').trim();
      if (!title) throw fail('BOARD_BAD_INPUT', 'Rename needs a title');
      if (payload.cardId != null) {
        mustCard(db, Number(payload.cardId));
        // A note card's text IS its ref; renaming a note edits the note.
        db.prepare("UPDATE board_cards SET title=?, ref=CASE WHEN kind='note' THEN ? ELSE ref END WHERE card_id=?")
          .run(title, title, Number(payload.cardId));
        return mustCard(db, Number(payload.cardId));
      }
      mustGroup(db, Number(payload.groupId));
      db.prepare('UPDATE board_groups SET title=? WHERE group_id=?').run(title, Number(payload.groupId));
      return mustGroup(db, Number(payload.groupId));
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
        const toGroupId = payload.toGroupId == null ? card.group_id : Number(payload.toGroupId);
        mustGroup(db, toGroupId);
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
      }
      db.prepare('UPDATE board_groups SET parent_id=?, sort_order=? WHERE group_id=?').run(toParentId, sortOrder, group.group_id);
      return mustGroup(db, group.group_id);
    }

    if (action === 'remove') {
      if (payload.cardId != null) {
        mustCard(db, Number(payload.cardId));
        db.prepare('DELETE FROM board_cards WHERE card_id=?').run(Number(payload.cardId));
        return { removed: 'card', cardId: Number(payload.cardId) };
      }
      mustGroup(db, Number(payload.groupId));
      db.prepare('DELETE FROM board_groups WHERE group_id=?').run(Number(payload.groupId));
      return { removed: 'group', groupId: Number(payload.groupId) };
    }

    throw new Error(`Unknown board action: ${action}`);
  }
};
