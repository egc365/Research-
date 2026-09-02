// The board service: groups/subgroups/cards as CONTENT in the workspace's own
// board.sqlite3 — never in control.sqlite3. Every call here passes no store at
// all, so any accidental control-store dependency fails loudly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { plugin } from '../plugins/server/board.mjs';

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-ops-board-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function act(root, action, payload = {}, surface = 'owner') {
  return plugin.action({ action, payload: { rootPath: root, ...payload }, surface });
}

test('content lands in <root>/.research-ops/board.sqlite3, not control.sqlite3', async t => {
  const root = workspace(t);
  await act(root, 'add-group', { title: 'Pipeline' });
  assert.equal(fs.existsSync(path.join(root, '.research-ops', 'board.sqlite3')), true);
  assert.equal(fs.existsSync(path.join(root, '.research-ops', 'control.sqlite3')), false);
});

test('tree nests groups/subgroups/cards ordered by sort_order', async t => {
  const root = workspace(t);
  const a = await act(root, 'add-group', { title: 'A', orientation: 'horizontal' });
  const b = await act(root, 'add-group', { title: 'B' });
  const a1 = await act(root, 'add-group', { parentId: a.group_id, title: 'A1' });
  await act(root, 'add-card', { groupId: a1.group_id, kind: 'note', ref: 'first note' });
  await act(root, 'add-card', { groupId: a1.group_id, kind: 'file', ref: 'docs/plan.md', title: 'Plan' });
  const { groups } = await act(root, 'tree');
  assert.deepEqual(groups.map(g => g.title), ['A', 'B']);
  assert.equal(groups[0].orientation, 'horizontal');
  assert.equal(b.orientation, 'vertical');
  assert.equal(groups[0].groups.length, 1);
  assert.equal(groups[0].groups[0].title, 'A1');
  assert.deepEqual(groups[0].groups[0].cards.map(c => c.ref), ['first note', 'docs/plan.md']);
  // Reorder: push the first card after the second.
  const [n1, n2] = groups[0].groups[0].cards;
  await act(root, 'move', { cardId: n1.card_id, toGroupId: a1.group_id, sortOrder: n2.sort_order + 10 });
  const after = await act(root, 'tree');
  assert.deepEqual(after.groups[0].groups[0].cards.map(c => c.ref), ['docs/plan.md', 'first note']);
});

test('move reparents a card and a group; rename and set-orientation stick', async t => {
  const root = workspace(t);
  const a = await act(root, 'add-group', { title: 'A' });
  const b = await act(root, 'add-group', { title: 'B' });
  const card = await act(root, 'add-card', { groupId: a.group_id, kind: 'link', ref: 'http://127.0.0.1:8787' });
  await act(root, 'move', { cardId: card.card_id, toGroupId: b.group_id, sortOrder: 10 });
  await act(root, 'move', { groupId: a.group_id, toParentId: b.group_id, sortOrder: 20 });
  await act(root, 'rename', { groupId: a.group_id, title: 'A renamed' });
  await act(root, 'set-orientation', { groupId: b.group_id, orientation: 'horizontal' });
  const { groups } = await act(root, 'tree');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, 'B');
  assert.equal(groups[0].orientation, 'horizontal');
  assert.deepEqual(groups[0].cards.map(c => c.ref), ['http://127.0.0.1:8787']);
  assert.deepEqual(groups[0].groups.map(g => g.title), ['A renamed']);
});

test('move refuses to put a group under its own descendant', async t => {
  const root = workspace(t);
  const a = await act(root, 'add-group', { title: 'A' });
  const a1 = await act(root, 'add-group', { parentId: a.group_id, title: 'A1' });
  const a2 = await act(root, 'add-group', { parentId: a1.group_id, title: 'A2' });
  await assert.rejects(act(root, 'move', { groupId: a.group_id, toParentId: a2.group_id, sortOrder: 10 }), /descendant/);
  await assert.rejects(act(root, 'move', { groupId: a.group_id, toParentId: a.group_id, sortOrder: 10 }), /descendant|itself/);
});

test('remove cascades to subgroups and cards', async t => {
  const root = workspace(t);
  const a = await act(root, 'add-group', { title: 'A' });
  const a1 = await act(root, 'add-group', { parentId: a.group_id, title: 'A1' });
  await act(root, 'add-card', { groupId: a1.group_id, kind: 'note', ref: 'doomed' });
  await act(root, 'add-group', { title: 'B' });
  await act(root, 'remove', { groupId: a.group_id });
  const { groups } = await act(root, 'tree');
  assert.deepEqual(groups.map(g => g.title), ['B']);
  assert.equal(groups[0].groups.length, 0);
  assert.equal(groups[0].cards.length, 0);
});

test('nesting stops at depth 3 — add-group and move both enforce it', async t => {
  const root = workspace(t);
  const a = await act(root, 'add-group', { title: 'A' });
  const a1 = await act(root, 'add-group', { parentId: a.group_id, title: 'A1' });
  const a2 = await act(root, 'add-group', { parentId: a1.group_id, title: 'A2' });
  // Depth 4 by creation is refused.
  await assert.rejects(
    act(root, 'add-group', { parentId: a2.group_id, title: 'A3' }),
    error => error.code === 'BOARD_DEPTH'
  );
  // Depth 4 by moving a subtree is refused: A1 (height 2, holds A2) under A2's
  // sibling at depth 2 would land A2's copy at depth 4.
  const b = await act(root, 'add-group', { title: 'B' });
  const b1 = await act(root, 'add-group', { parentId: b.group_id, title: 'B1' });
  await assert.rejects(
    act(root, 'move', { groupId: a1.group_id, toParentId: b1.group_id, sortOrder: 10 }),
    error => error.code === 'BOARD_DEPTH'
  );
  // A leaf group at depth 3 is fine, and so is moving one there.
  await act(root, 'move', { groupId: a2.group_id, toParentId: b1.group_id, sortOrder: 10 });
  const { groups } = await act(root, 'tree');
  assert.deepEqual(groups.map(g => g.title), ['A', 'B']);
  assert.equal(groups[1].groups[0].groups[0].title, 'A2');
});

test('a pre-existing deeper tree still renders — the cap gates mutations only', async t => {
  const root = workspace(t);
  const a = await act(root, 'add-group', { title: 'A' });
  const a1 = await act(root, 'add-group', { parentId: a.group_id, title: 'A1' });
  const a2 = await act(root, 'add-group', { parentId: a1.group_id, title: 'A2' });
  // Simulate a board written before the cap existed.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(root, '.research-ops', 'board.sqlite3'));
  db.prepare('INSERT INTO board_groups (parent_id, title, orientation, sort_order, created_at) VALUES (?,?,?,?,?)')
    .run(a2.group_id, 'legacy-depth-4', 'vertical', 100, new Date().toISOString());
  db.close();
  const { groups } = await act(root, 'tree');
  assert.equal(groups[0].groups[0].groups[0].groups[0].title, 'legacy-depth-4');
});

test('sticky colors: column added to pre-existing boards, set-color validates the palette', async t => {
  const root = workspace(t);
  // Simulate a board created before the color column existed.
  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(path.join(root, '.research-ops'), { recursive: true });
  const old = new DatabaseSync(path.join(root, '.research-ops', 'board.sqlite3'));
  old.exec(`
    CREATE TABLE board_groups (group_id INTEGER PRIMARY KEY, parent_id INTEGER NULL, title TEXT NOT NULL,
      orientation TEXT NOT NULL DEFAULT 'vertical', sort_order INTEGER NOT NULL DEFAULT 100, created_at TEXT NOT NULL);
    CREATE TABLE board_cards (card_id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL, kind TEXT NOT NULL,
      ref TEXT NOT NULL, title TEXT, sort_order INTEGER NOT NULL DEFAULT 100, created_at TEXT NOT NULL);
    INSERT INTO board_groups (title, orientation, sort_order, created_at) VALUES ('Old', 'vertical', 100, '2026-01-01');
    INSERT INTO board_cards (group_id, kind, ref, sort_order, created_at) VALUES (1, 'note', 'pre-color note', 100, '2026-01-01');
  `);
  old.close();
  const { STICKY_COLORS } = await import('../plugins/server/stickies.mjs');
  const colored = await act(root, 'set-color', { cardId: 1, color: STICKY_COLORS[3] });
  assert.equal(colored.color, STICKY_COLORS[3]);
  await assert.rejects(act(root, 'set-color', { cardId: 1, color: '#123456' }), e => e.code === 'BOARD_BAD_INPUT');
  const cleared = await act(root, 'set-color', { cardId: 1, color: null });
  assert.equal(cleared.color, null);
});

test('color round-trips on file, link, and note cards', async t => {
  const root = workspace(t);
  const g = await act(root, 'add-group', { title: 'G' });
  const { STICKY_COLORS } = await import('../plugins/server/stickies.mjs');
  const file = await act(root, 'add-card', { groupId: g.group_id, kind: 'file', ref: 'docs/plan.md', color: STICKY_COLORS[1] });
  const link = await act(root, 'add-card', { groupId: g.group_id, kind: 'link', ref: 'http://127.0.0.1:9', color: STICKY_COLORS[2] });
  const note = await act(root, 'add-card', { groupId: g.group_id, kind: 'note', ref: 'hello\nworld', color: STICKY_COLORS[3] });
  assert.equal(file.color, STICKY_COLORS[1]);
  assert.equal(link.color, STICKY_COLORS[2]);
  assert.equal(note.color, STICKY_COLORS[3]);
  await act(root, 'set-color', { cardId: file.card_id, color: STICKY_COLORS[4] });
  await act(root, 'set-color', { cardId: link.card_id, color: STICKY_COLORS[5] });
  await act(root, 'set-color', { cardId: note.card_id, color: STICKY_COLORS[0] });
  const { groups } = await act(root, 'tree');
  const byKind = Object.fromEntries(groups[0].cards.map(c => [c.kind, c.color]));
  assert.equal(byKind.file, STICKY_COLORS[4]);
  assert.equal(byKind.link, STICKY_COLORS[5]);
  assert.equal(byKind.note, STICKY_COLORS[0]);
  await act(root, 'set-color', { cardId: file.card_id, color: null });
  const after = await act(root, 'tree');
  assert.equal(after.groups[0].cards.find(c => c.kind === 'file').color, null);
  await assert.rejects(
    act(root, 'add-card', { groupId: g.group_id, kind: 'note', ref: 'nope', color: '#123456' }),
    e => e.code === 'BOARD_BAD_INPUT'
  );
});

test('set-orientation writes the group row; a later tree read returns it', async t => {
  const root = workspace(t);
  const g = await act(root, 'add-group', { title: 'plans' });
  assert.equal(g.orientation, 'vertical');
  const flipped = await act(root, 'set-orientation', { groupId: g.group_id, orientation: 'horizontal' });
  assert.equal(flipped.orientation, 'horizontal');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(root, '.research-ops', 'board.sqlite3'));
  const row = db.prepare('SELECT title, orientation FROM board_groups WHERE group_id=?').get(g.group_id);
  db.close();
  assert.equal(row.title, 'plans');
  assert.equal(row.orientation, 'horizontal');
  const { groups } = await act(root, 'tree');
  assert.equal(groups[0].orientation, 'horizontal');
  assert.equal(groups[0].title, 'plans');
});

test('update-card writes color and text in one call', async t => {
  const root = workspace(t);
  const g = await act(root, 'add-group', { title: 'G' });
  const { STICKY_COLORS } = await import('../plugins/server/stickies.mjs');
  const note = await act(root, 'add-card', { groupId: g.group_id, kind: 'note', ref: 'old' });
  const link = await act(root, 'add-card', { groupId: g.group_id, kind: 'link', ref: 'http://127.0.0.1:9', title: 'old' });
  const file = await act(root, 'add-card', { groupId: g.group_id, kind: 'file', ref: 'plans/README.md' });
  const noteOut = await act(root, 'update-card', { cardId: note.card_id, color: STICKY_COLORS[1], text: 'hello\nworld' });
  assert.equal(noteOut.color, STICKY_COLORS[1]);
  assert.equal(noteOut.ref, 'hello\nworld');
  const linkOut = await act(root, 'update-card', { cardId: link.card_id, color: STICKY_COLORS[2], name: 'renamed' });
  assert.equal(linkOut.color, STICKY_COLORS[2]);
  assert.equal(linkOut.title, 'renamed');
  const fileOut = await act(root, 'update-card', { cardId: file.card_id, color: STICKY_COLORS[3] });
  assert.equal(fileOut.color, STICKY_COLORS[3]);
  assert.equal(fileOut.ref, 'plans/README.md');
  await assert.rejects(
    act(root, 'update-card', { cardId: note.card_id, color: '#123456' }),
    e => e.code === 'BOARD_BAD_INPUT'
  );
});

test('agent surface may read the tree but never mutate', async t => {
  const root = workspace(t);
  const a = await act(root, 'add-group', { title: 'A' });
  const card = await act(root, 'add-card', { groupId: a.group_id, kind: 'note', ref: 'owner note' });
  const { groups } = await act(root, 'tree', {}, 'agent');
  assert.equal(groups.length, 1);
  const mutations = [
    ['add-group', { title: 'nope' }],
    ['add-card', { groupId: a.group_id, kind: 'note', ref: 'nope' }],
    ['rename', { groupId: a.group_id, title: 'nope' }],
    ['set-orientation', { groupId: a.group_id, orientation: 'horizontal' }],
    ['update-card', { cardId: card.card_id, color: null, text: 'nope' }],
    ['move', { cardId: card.card_id, toGroupId: a.group_id, sortOrder: 5 }],
    ['remove', { cardId: card.card_id }]
  ];
  for (const [action, payload] of mutations) {
    await assert.rejects(act(root, action, payload, 'agent'), error => error.code === 'OWNER_SURFACE_ONLY');
  }
  const after = await act(root, 'tree');
  assert.deepEqual(after.groups[0].cards.map(c => c.ref), ['owner note']);
});
