// The board service: groups/subgroups/cards as CONTENT in the workspace's own
// board.sqlite3 — never in control.sqlite3. File and folder creates go through
// the control store's guarded write so the card is the document.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { plugin } from '../plugins/server/board.mjs';
import { ControlStore } from '../src/store.mjs';

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-ops-board-'));
  const root = path.join(dir, 'ws');
  fs.mkdirSync(root);
  const store = new ControlStore(path.join(dir, 'control.sqlite3'));
  store.addWorkspace(root, 'board-test');
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { root, store, dir };
}

function act(ws, action, payload = {}, surface = 'owner') {
  return plugin.action({ action, payload: { rootPath: ws.root, ...payload }, surface, store: ws.store });
}

test('content lands in <root>/.research-ops/board.sqlite3, not control.sqlite3', async t => {
  const ws = workspace(t);
  await act(ws, 'add-group', { title: 'Pipeline' });
  assert.equal(fs.existsSync(path.join(ws.root, '.research-ops', 'board.sqlite3')), true);
  assert.equal(fs.existsSync(path.join(ws.root, '.research-ops', 'control.sqlite3')), false);
});

test('tree nests groups/subgroups/cards ordered by sort_order', async t => {
  const ws = workspace(t);
  const a = await act(ws, 'add-group', { title: 'A', orientation: 'horizontal' });
  const b = await act(ws, 'add-group', { title: 'B' });
  const a1 = await act(ws, 'add-group', { parentId: a.group_id, title: 'A1' });
  await act(ws, 'add-card', { groupId: a1.group_id, kind: 'note', ref: 'first note' });
  await act(ws, 'add-card', { groupId: a1.group_id, kind: 'file', name: 'plan.md', title: 'Plan' });
  const { groups } = await act(ws, 'tree');
  assert.deepEqual(groups.map(g => g.title), ['A', 'B']);
  assert.equal(groups[0].orientation, 'horizontal');
  assert.equal(b.orientation, 'vertical');
  assert.equal(groups[0].groups.length, 1);
  assert.equal(groups[0].groups[0].title, 'A1');
  assert.deepEqual(groups[0].groups[0].cards.map(c => c.ref), ['first note', 'A/A1/plan.md']);
  // Reorder: push the first card after the second.
  const [n1, n2] = groups[0].groups[0].cards;
  await act(ws, 'move', { cardId: n1.card_id, toGroupId: a1.group_id, sortOrder: n2.sort_order + 10 });
  const after = await act(ws, 'tree');
  assert.deepEqual(after.groups[0].groups[0].cards.map(c => c.ref), ['A/A1/plan.md', 'first note']);
});

test('move reparents a card and a group; rename and set-orientation stick', async t => {
  const ws = workspace(t);
  const a = await act(ws, 'add-group', { title: 'A' });
  const b = await act(ws, 'add-group', { title: 'B' });
  const card = await act(ws, 'add-card', { groupId: a.group_id, kind: 'link', ref: 'http://127.0.0.1:8787' });
  await act(ws, 'move', { cardId: card.card_id, toGroupId: b.group_id, sortOrder: 10 });
  await act(ws, 'move', { groupId: a.group_id, toParentId: b.group_id, sortOrder: 20 });
  await act(ws, 'rename', { groupId: a.group_id, title: 'A renamed' });
  await act(ws, 'set-orientation', { groupId: b.group_id, orientation: 'horizontal' });
  const { groups } = await act(ws, 'tree');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, 'B');
  assert.equal(groups[0].orientation, 'horizontal');
  assert.deepEqual(groups[0].cards.map(c => c.ref), ['http://127.0.0.1:8787']);
  assert.deepEqual(groups[0].groups.map(g => g.title), ['A renamed']);
});

test('move refuses to put a group under its own descendant', async t => {
  const ws = workspace(t);
  const a = await act(ws, 'add-group', { title: 'A' });
  const a1 = await act(ws, 'add-group', { parentId: a.group_id, title: 'A1' });
  const a2 = await act(ws, 'add-group', { parentId: a1.group_id, title: 'A2' });
  await assert.rejects(act(ws, 'move', { groupId: a.group_id, toParentId: a2.group_id, sortOrder: 10 }), /descendant/);
  await assert.rejects(act(ws, 'move', { groupId: a.group_id, toParentId: a.group_id, sortOrder: 10 }), /descendant|itself/);
});

test('remove cascades to subgroups and cards', async t => {
  const ws = workspace(t);
  const a = await act(ws, 'add-group', { title: 'A' });
  const a1 = await act(ws, 'add-group', { parentId: a.group_id, title: 'A1' });
  await act(ws, 'add-card', { groupId: a1.group_id, kind: 'note', ref: 'doomed' });
  await act(ws, 'add-group', { title: 'B' });
  await act(ws, 'remove', { groupId: a.group_id });
  const { groups } = await act(ws, 'tree');
  assert.deepEqual(groups.map(g => g.title), ['B']);
  assert.equal(groups[0].groups.length, 0);
  assert.equal(groups[0].cards.length, 0);
});

test('nesting stops at depth 3 — add-group and move both enforce it', async t => {
  const ws = workspace(t);
  const a = await act(ws, 'add-group', { title: 'A' });
  const a1 = await act(ws, 'add-group', { parentId: a.group_id, title: 'A1' });
  const a2 = await act(ws, 'add-group', { parentId: a1.group_id, title: 'A2' });
  // Depth 4 by creation is refused.
  await assert.rejects(
    act(ws, 'add-group', { parentId: a2.group_id, title: 'A3' }),
    error => error.code === 'BOARD_DEPTH'
  );
  // Depth 4 by moving a subtree is refused: A1 (height 2, holds A2) under A2's
  // sibling at depth 2 would land A2's copy at depth 4.
  const b = await act(ws, 'add-group', { title: 'B' });
  const b1 = await act(ws, 'add-group', { parentId: b.group_id, title: 'B1' });
  await assert.rejects(
    act(ws, 'move', { groupId: a1.group_id, toParentId: b1.group_id, sortOrder: 10 }),
    error => error.code === 'BOARD_DEPTH'
  );
  // A leaf group at depth 3 is fine, and so is moving one there.
  await act(ws, 'move', { groupId: a2.group_id, toParentId: b1.group_id, sortOrder: 10 });
  const { groups } = await act(ws, 'tree');
  assert.deepEqual(groups.map(g => g.title), ['A', 'B']);
  assert.equal(groups[1].groups[0].groups[0].title, 'A2');
});

test('a pre-existing deeper tree still renders — the cap gates mutations only', async t => {
  const ws = workspace(t);
  const a = await act(ws, 'add-group', { title: 'A' });
  const a1 = await act(ws, 'add-group', { parentId: a.group_id, title: 'A1' });
  const a2 = await act(ws, 'add-group', { parentId: a1.group_id, title: 'A2' });
  // Simulate a board written before the cap existed.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(ws.root, '.research-ops', 'board.sqlite3'));
  db.prepare('INSERT INTO board_groups (parent_id, title, orientation, sort_order, created_at) VALUES (?,?,?,?,?)')
    .run(a2.group_id, 'legacy-depth-4', 'vertical', 100, new Date().toISOString());
  db.close();
  const { groups } = await act(ws, 'tree');
  assert.equal(groups[0].groups[0].groups[0].groups[0].title, 'legacy-depth-4');
});

test('sticky colors: column added to pre-existing boards, set-color validates the palette', async t => {
  const ws = workspace(t);
  // Simulate a board created before the color column existed.
  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(path.join(ws.root, '.research-ops'), { recursive: true });
  const old = new DatabaseSync(path.join(ws.root, '.research-ops', 'board.sqlite3'));
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
  const colored = await act(ws, 'set-color', { cardId: 1, color: STICKY_COLORS[3] });
  assert.equal(colored.color, STICKY_COLORS[3]);
  await assert.rejects(act(ws, 'set-color', { cardId: 1, color: '#123456' }), e => e.code === 'BOARD_BAD_INPUT');
  const cleared = await act(ws, 'set-color', { cardId: 1, color: null });
  assert.equal(cleared.color, null);
});

test('color round-trips on file, link, and note cards', async t => {
  const ws = workspace(t);
  const g = await act(ws, 'add-group', { title: 'G' });
  const { STICKY_COLORS } = await import('../plugins/server/stickies.mjs');
  const file = await act(ws, 'add-card', { groupId: g.group_id, kind: 'file', name: 'plan.md', color: STICKY_COLORS[1] });
  const link = await act(ws, 'add-card', { groupId: g.group_id, kind: 'link', ref: 'http://127.0.0.1:9', color: STICKY_COLORS[2] });
  const note = await act(ws, 'add-card', { groupId: g.group_id, kind: 'note', ref: 'hello\nworld', color: STICKY_COLORS[3] });
  assert.equal(file.color, STICKY_COLORS[1]);
  assert.equal(link.color, STICKY_COLORS[2]);
  assert.equal(note.color, STICKY_COLORS[3]);
  await act(ws, 'set-color', { cardId: file.card_id, color: STICKY_COLORS[4] });
  await act(ws, 'set-color', { cardId: link.card_id, color: STICKY_COLORS[5] });
  await act(ws, 'set-color', { cardId: note.card_id, color: STICKY_COLORS[0] });
  const { groups } = await act(ws, 'tree');
  const byKind = Object.fromEntries(groups[0].cards.map(c => [c.kind, c.color]));
  assert.equal(byKind.file, STICKY_COLORS[4]);
  assert.equal(byKind.link, STICKY_COLORS[5]);
  assert.equal(byKind.note, STICKY_COLORS[0]);
  await act(ws, 'set-color', { cardId: file.card_id, color: null });
  const after = await act(ws, 'tree');
  assert.equal(after.groups[0].cards.find(c => c.kind === 'file').color, null);
  await assert.rejects(
    act(ws, 'add-card', { groupId: g.group_id, kind: 'note', ref: 'nope', color: '#123456' }),
    e => e.code === 'BOARD_BAD_INPUT'
  );
});

test('set-orientation writes the group row; a later tree read returns it', async t => {
  const ws = workspace(t);
  const g = await act(ws, 'add-group', { title: 'plans' });
  assert.equal(g.orientation, 'vertical');
  const flipped = await act(ws, 'set-orientation', { groupId: g.group_id, orientation: 'horizontal' });
  assert.equal(flipped.orientation, 'horizontal');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(ws.root, '.research-ops', 'board.sqlite3'));
  const row = db.prepare('SELECT title, orientation FROM board_groups WHERE group_id=?').get(g.group_id);
  db.close();
  assert.equal(row.title, 'plans');
  assert.equal(row.orientation, 'horizontal');
  const { groups } = await act(ws, 'tree');
  assert.equal(groups[0].orientation, 'horizontal');
  assert.equal(groups[0].title, 'plans');
});

test('update-card writes color and text in one call', async t => {
  const ws = workspace(t);
  const g = await act(ws, 'add-group', { title: 'G' });
  const { STICKY_COLORS } = await import('../plugins/server/stickies.mjs');
  const note = await act(ws, 'add-card', { groupId: g.group_id, kind: 'note', ref: 'old' });
  const link = await act(ws, 'add-card', { groupId: g.group_id, kind: 'link', ref: 'http://127.0.0.1:9', title: 'old' });
  const file = await act(ws, 'add-card', { groupId: g.group_id, kind: 'file', name: 'README.md' });
  const noteOut = await act(ws, 'update-card', { cardId: note.card_id, color: STICKY_COLORS[1], text: 'hello\nworld' });
  assert.equal(noteOut.color, STICKY_COLORS[1]);
  assert.equal(noteOut.ref, 'hello\nworld');
  const linkOut = await act(ws, 'update-card', { cardId: link.card_id, color: STICKY_COLORS[2], name: 'renamed' });
  assert.equal(linkOut.color, STICKY_COLORS[2]);
  assert.equal(linkOut.title, 'renamed');
  const fileOut = await act(ws, 'update-card', { cardId: file.card_id, color: STICKY_COLORS[3] });
  assert.equal(fileOut.color, STICKY_COLORS[3]);
  assert.equal(fileOut.ref, 'G/README.md');
  await assert.rejects(
    act(ws, 'update-card', { cardId: note.card_id, color: '#123456' }),
    e => e.code === 'BOARD_BAD_INPUT'
  );
});

test('agent surface may read the tree but never mutate', async t => {
  const ws = workspace(t);
  const a = await act(ws, 'add-group', { title: 'A' });
  const card = await act(ws, 'add-card', { groupId: a.group_id, kind: 'note', ref: 'owner note' });
  const { groups } = await act(ws, 'tree', {}, 'agent');
  assert.equal(groups.length, 1);
  const mutations = [
    ['add-group', { title: 'nope' }],
    ['add-card', { groupId: a.group_id, kind: 'note', ref: 'nope' }],
    ['rename', { groupId: a.group_id, title: 'nope' }],
    ['set-orientation', { groupId: a.group_id, orientation: 'horizontal' }],
    ['update-card', { cardId: card.card_id, color: null, text: 'nope' }],
    ['move', { cardId: card.card_id, toGroupId: a.group_id, sortOrder: 5 }],
    ['remove', { cardId: card.card_id }],
    ['bind-group', { groupId: a.group_id }]
  ];
  for (const [action, payload] of mutations) {
    await assert.rejects(act(ws, action, payload, 'agent'), error => error.code === 'OWNER_SURFACE_ONLY');
  }
  const after = await act(ws, 'tree');
  assert.deepEqual(after.groups[0].cards.map(c => c.ref), ['owner note']);
});

test('folder creation writes the directory and binds the group', async t => {
  const ws = workspace(t);
  const plans = await act(ws, 'add-card', { kind: 'folder', groupId: null, name: 'plans' });
  assert.equal(plans.title, 'plans');
  assert.equal(plans.folder_path, 'plans');
  assert.equal(fs.statSync(path.join(ws.root, 'plans')).isDirectory(), true);
  const q3 = await act(ws, 'add-card', { kind: 'folder', groupId: plans.group_id, name: 'q3' });
  assert.equal(q3.folder_path, 'plans/q3');
  assert.equal(fs.statSync(path.join(ws.root, 'plans', 'q3')).isDirectory(), true);
  const { groups } = await act(ws, 'tree');
  assert.equal(groups[0].folder_path, 'plans');
  assert.equal(groups[0].groups[0].folder_path, 'plans/q3');
});

test('file creation writes the file, registers it, and binds the card', async t => {
  const ws = workspace(t);
  const plans = await act(ws, 'add-card', { kind: 'folder', name: 'plans' });
  const card = await act(ws, 'add-card', {
    kind: 'file', groupId: plans.group_id, name: 'README.md', body: 'first plan'
  });
  assert.equal(card.kind, 'file');
  assert.equal(card.ref, 'plans/README.md');
  const abs = path.join(ws.root, 'plans', 'README.md');
  assert.equal(fs.readFileSync(abs, 'utf8'), 'first plan\n');
  const artifact = ws.store.getArtifact(abs);
  assert.ok(artifact, 'file is in the ledger');
  assert.equal(artifact.state, 'working');
  const q3 = await act(ws, 'add-card', { kind: 'folder', groupId: plans.group_id, name: 'q3' });
  const notes = await act(ws, 'add-card', { kind: 'file', groupId: q3.group_id, name: 'notes.md' });
  assert.equal(notes.ref, 'plans/q3/notes.md');
  assert.equal(fs.existsSync(path.join(ws.root, 'plans', 'q3', 'notes.md')), true);
});

test('depth-3 folder refused', async t => {
  const ws = workspace(t);
  const a = await act(ws, 'add-card', { kind: 'folder', name: 'A' });
  const a1 = await act(ws, 'add-card', { kind: 'folder', groupId: a.group_id, name: 'A1' });
  const a2 = await act(ws, 'add-card', { kind: 'folder', groupId: a1.group_id, name: 'A2' });
  await assert.rejects(
    act(ws, 'add-card', { kind: 'folder', groupId: a2.group_id, name: 'A3' }),
    error => error.code === 'BOARD_DEPTH'
  );
  const leaf = await act(ws, 'add-card', { kind: 'file', groupId: a2.group_id, name: 'leaf.md' });
  assert.equal(leaf.ref, 'A/A1/A2/leaf.md');
});

test('outside-root refused', async t => {
  const ws = workspace(t);
  const plans = await act(ws, 'add-card', { kind: 'folder', name: 'plans' });
  await assert.rejects(
    act(ws, 'add-card', { kind: 'file', groupId: plans.group_id, name: '../../outside.md' }),
    error => /outside workspace/i.test(error.message)
  );
  assert.equal(fs.existsSync('/tmp/outside.md'), false);
});

test('existing-file refused', async t => {
  const ws = workspace(t);
  const plans = await act(ws, 'add-card', { kind: 'folder', name: 'plans' });
  await act(ws, 'add-card', { kind: 'file', groupId: plans.group_id, name: 'README.md', body: 'first' });
  await assert.rejects(
    act(ws, 'add-card', { kind: 'file', groupId: plans.group_id, name: 'README.md', body: 'second' }),
    error => error.code === 'ALREADY_EXISTS' || /Already exists/.test(error.message)
  );
  assert.equal(fs.readFileSync(path.join(ws.root, 'plans', 'README.md'), 'utf8'), 'first\n');
});

test('remove drops the board row and leaves the disk alone', async t => {
  const ws = workspace(t);
  const plans = await act(ws, 'add-card', { kind: 'folder', name: 'plans' });
  const card = await act(ws, 'add-card', { kind: 'file', groupId: plans.group_id, name: 'README.md', body: 'stay' });
  const removed = await act(ws, 'remove', { cardId: card.card_id });
  assert.equal(removed.disk, 'left');
  assert.equal(fs.readFileSync(path.join(ws.root, 'plans', 'README.md'), 'utf8'), 'stay\n');
  const goneGroup = await act(ws, 'remove', { groupId: plans.group_id });
  assert.equal(goneGroup.disk, 'left');
  assert.equal(fs.statSync(path.join(ws.root, 'plans')).isDirectory(), true);
  const { groups } = await act(ws, 'tree');
  assert.deepEqual(groups, []);
});

test('unbound group from before folder_path still renders and bind-group writes the folder', async t => {
  const ws = workspace(t);
  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(path.join(ws.root, '.research-ops'), { recursive: true });
  const old = new DatabaseSync(path.join(ws.root, '.research-ops', 'board.sqlite3'));
  old.exec(`
    CREATE TABLE board_groups (group_id INTEGER PRIMARY KEY, parent_id INTEGER NULL, title TEXT NOT NULL,
      orientation TEXT NOT NULL DEFAULT 'vertical', sort_order INTEGER NOT NULL DEFAULT 100, created_at TEXT NOT NULL);
    CREATE TABLE board_cards (card_id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL, kind TEXT NOT NULL,
      ref TEXT NOT NULL, title TEXT, sort_order INTEGER NOT NULL DEFAULT 100, created_at TEXT NOT NULL);
    INSERT INTO board_groups (title, orientation, sort_order, created_at) VALUES ('legacy', 'vertical', 100, '2026-01-01');
  `);
  old.close();
  const { groups } = await act(ws, 'tree');
  assert.equal(groups[0].title, 'legacy');
  assert.equal(groups[0].folder_path, null);
  const bound = await act(ws, 'bind-group', { groupId: groups[0].group_id });
  assert.equal(bound.folder_path, 'legacy');
  assert.equal(fs.statSync(path.join(ws.root, 'legacy')).isDirectory(), true);
});
