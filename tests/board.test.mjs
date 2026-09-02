// The board service: lanes and cards as CONTENT in the workspace's own
// board.sqlite3. Never in control.sqlite3. A lane writes nothing to disk.
// File and folder cards go through the control store's guarded write so the
// card is the document, always directly under the surface's folder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { plugin } from '../plugins/server/board.mjs';
import { STICKY_COLORS } from '../plugins/server/stickies.mjs';
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

function findAll(root) {
  const out = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name === '.research-ops') continue;
      const abs = path.join(dir, name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      out.push(fs.statSync(abs).isDirectory() ? `${rel}/` : rel);
      if (fs.statSync(abs).isDirectory()) walk(abs);
    }
  }
  walk(root);
  return out;
}

// Today's schema at base 8e69bff: a group is a folder with folder_path.
function legacyBoard(root, sql) {
  fs.mkdirSync(path.join(root, '.research-ops'), { recursive: true });
  const old = new DatabaseSync(path.join(root, '.research-ops', 'board.sqlite3'));
  old.exec(`
    CREATE TABLE board_groups (
      group_id INTEGER PRIMARY KEY,
      parent_id INTEGER NULL REFERENCES board_groups(group_id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      orientation TEXT NOT NULL DEFAULT 'vertical' CHECK(orientation IN ('horizontal','vertical')),
      sort_order INTEGER NOT NULL DEFAULT 100,
      folder_path TEXT, color TEXT, face TEXT, icon TEXT, fields_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE board_cards (
      card_id INTEGER PRIMARY KEY,
      group_id INTEGER NULL REFERENCES board_groups(group_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('file','link','note')),
      ref TEXT NOT NULL, title TEXT, color TEXT, face TEXT, icon TEXT, fields_json TEXT,
      sort_order INTEGER NOT NULL DEFAULT 100,
      created_at TEXT NOT NULL
    );
    ${sql}
  `);
  old.close();
}

test('content lands in <root>/.research-ops/board.sqlite3, not control.sqlite3', async t => {
  const ws = workspace(t);
  await act(ws, 'add-lane', { name: 'Pipeline' });
  assert.equal(fs.existsSync(path.join(ws.root, '.research-ops', 'board.sqlite3')), true);
  assert.equal(fs.existsSync(path.join(ws.root, '.research-ops', 'control.sqlite3')), false);
});

test('add-lane writes no disk entry', async t => {
  const ws = workspace(t);
  const lane = await act(ws, 'add-lane', { name: 'task 2' });
  assert.equal(lane.name, 'task 2');
  assert.equal(lane.surface, '');
  assert.equal(lane.orientation, 'vertical');
  const inner = await act(ws, 'add-lane', { name: 'a/b step', parentLaneId: lane.lane_id });
  assert.equal(inner.parent_lane_id, lane.lane_id);
  fs.mkdirSync(path.join(ws.root, 'hello'));
  await act(ws, 'add-lane', { surface: 'hello', name: 'execution', orientation: 'horizontal' });
  assert.deepEqual(findAll(ws.root), ['hello/']);
});

test('a file added inside a lane lands under the surface folder, not the lane', async t => {
  const ws = workspace(t);
  fs.mkdirSync(path.join(ws.root, 'hello'));
  const lane = await act(ws, 'add-lane', { surface: 'hello', name: 'task 1' });
  const card = await act(ws, 'add-card', { surface: 'hello', laneId: lane.lane_id, kind: 'file', name: 'plan.md', body: 'first plan' });
  assert.equal(card.kind, 'file');
  assert.equal(card.ref, 'hello/plan.md');
  assert.equal(card.lane_id, lane.lane_id);
  assert.equal(card.surface, 'hello');
  assert.equal(card.title, 'first plan');
  assert.equal(fs.readFileSync(path.join(ws.root, 'hello', 'plan.md'), 'utf8'), 'first plan\n');
  const artifact = ws.store.getArtifact(path.join(ws.root, 'hello', 'plan.md'));
  assert.equal(artifact.state, 'working');
  const folder = await act(ws, 'add-card', { surface: 'hello', laneId: lane.lane_id, kind: 'folder', name: 'howdy' });
  assert.equal(folder.kind, 'folder');
  assert.equal(folder.ref, 'hello/howdy');
  assert.equal(folder.face, 'sticky');
  assert.equal(folder.icon, 'folder');
  assert.deepEqual(findAll(ws.root), ['hello/', 'hello/howdy/', 'hello/plan.md']);
  const { lanes, cards } = await act(ws, 'tree', { surface: 'hello' });
  assert.deepEqual(lanes[0].cards.map(c => c.ref), ['hello/plan.md', 'hello/howdy']);
  assert.deepEqual(cards, []);
  const rootTree = await act(ws, 'tree');
  assert.deepEqual(rootTree.lanes, []);
});

test('the example of done: one horizontal lane holding three vertical lanes, five files, one folder', async t => {
  const ws = workspace(t);
  fs.mkdirSync(path.join(ws.root, 'hello'));
  const s = { surface: 'hello' };
  const exec = await act(ws, 'add-lane', { ...s, name: 'execution', orientation: 'horizontal' });
  const tasks = [];
  for (const name of ['task 1', 'task 2', 'task 3']) {
    tasks.push(await act(ws, 'add-lane', { ...s, name, parentLaneId: exec.lane_id }));
  }
  await act(ws, 'add-card', { ...s, laneId: tasks[0].lane_id, kind: 'file', name: 'plan.md' });
  for (const name of ['a.md', 'b.md', 'c.md']) await act(ws, 'add-card', { ...s, laneId: tasks[1].lane_id, kind: 'file', name });
  await act(ws, 'add-card', { ...s, laneId: tasks[2].lane_id, kind: 'file', name: 'README.md' });
  await act(ws, 'add-card', { ...s, kind: 'folder', name: 'howdy' });
  assert.deepEqual(findAll(ws.root), [
    'hello/', 'hello/README.md', 'hello/a.md', 'hello/b.md', 'hello/c.md', 'hello/howdy/', 'hello/plan.md'
  ]);
  const { lanes, cards } = await act(ws, 'tree', s);
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].orientation, 'horizontal');
  assert.deepEqual(lanes[0].lanes.map(l => [l.name, l.orientation, l.cards.map(c => c.ref)]), [
    ['task 1', 'vertical', ['hello/plan.md']],
    ['task 2', 'vertical', ['hello/a.md', 'hello/b.md', 'hello/c.md']],
    ['task 3', 'vertical', ['hello/README.md']]
  ]);
  assert.deepEqual(cards.map(c => [c.kind, c.ref]), [['folder', 'hello/howdy']]);
});

test('move-card between lanes and to the floor, on one surface only', async t => {
  const ws = workspace(t);
  const a = await act(ws, 'add-lane', { name: 'A' });
  const b = await act(ws, 'add-lane', { name: 'B' });
  const inner = await act(ws, 'add-lane', { name: 'B inner', parentLaneId: b.lane_id });
  const card = await act(ws, 'add-card', { laneId: a.lane_id, kind: 'note', ref: 'moving' });
  const sticky = await act(ws, 'add-card', { laneId: a.lane_id, kind: 'note', ref: 'staying', face: 'sticky' });
  await act(ws, 'move-card', { cardId: card.card_id, toLaneId: b.lane_id, sortOrder: 10 });
  let tree = await act(ws, 'tree');
  assert.deepEqual(tree.lanes.map(l => l.cards.map(c => c.ref)), [['staying'], ['moving']]);
  await act(ws, 'move-card', { cardId: card.card_id, toLaneId: inner.lane_id, sortOrder: 10 });
  tree = await act(ws, 'tree');
  assert.deepEqual(tree.lanes[1].lanes[0].cards.map(c => c.ref), ['moving']);
  await act(ws, 'move-card', { cardId: card.card_id, toLaneId: null, sortOrder: 10 });
  await act(ws, 'move-card', { cardId: sticky.card_id, toLaneId: null, sortOrder: 20 });
  tree = await act(ws, 'tree');
  assert.deepEqual(tree.cards.map(c => c.ref), ['moving', 'staying']);
  assert.deepEqual(tree.lanes.map(l => l.cards.length), [0, 0]);
  await act(ws, 'move-card', { cardId: sticky.card_id, sortOrder: 5 });
  tree = await act(ws, 'tree');
  assert.deepEqual(tree.cards.map(c => c.ref), ['staying', 'moving']);
  fs.mkdirSync(path.join(ws.root, 'hello'));
  const elsewhere = await act(ws, 'add-lane', { surface: 'hello', name: 'far' });
  await assert.rejects(
    act(ws, 'move-card', { cardId: card.card_id, toLaneId: elsewhere.lane_id, sortOrder: 10 }),
    e => e.code === 'BOARD_BAD_INPUT' && /surface/.test(e.message)
  );
});

test('tree drop: an existing file under the surface becomes a card, one outside is refused', async t => {
  const ws = workspace(t);
  fs.mkdirSync(path.join(ws.root, 'hello', 'howdy'), { recursive: true });
  fs.writeFileSync(path.join(ws.root, 'hello', 'x.md'), 'x\n');
  fs.writeFileSync(path.join(ws.root, 'hello', 'howdy', 'deep.md'), 'deep\n');
  fs.writeFileSync(path.join(ws.root, 'top.md'), 'top\n');
  const lane = await act(ws, 'add-lane', { surface: 'hello', name: 'task 1' });
  const card = await act(ws, 'add-card', { surface: 'hello', laneId: lane.lane_id, kind: 'file', ref: 'hello/x.md' });
  assert.equal(card.ref, 'hello/x.md');
  assert.equal(card.lane_id, lane.lane_id);
  const deep = await act(ws, 'add-card', { surface: 'hello', laneId: lane.lane_id, kind: 'file', ref: `${ws.root}/hello/howdy/deep.md`.replace(`${ws.root}/`, '') });
  assert.equal(deep.ref, 'hello/howdy/deep.md');
  await assert.rejects(
    act(ws, 'add-card', { surface: 'hello', laneId: lane.lane_id, kind: 'file', ref: 'top.md' }),
    e => e.code === 'BOARD_OUTSIDE_SURFACE' && /'hello'/.test(e.message)
  );
  await assert.rejects(
    act(ws, 'add-card', { surface: 'hello', laneId: lane.lane_id, kind: 'file', ref: 'hello/missing.md' }),
    e => e.code === 'BOARD_NOT_FOUND'
  );
  await assert.rejects(
    act(ws, 'add-card', { surface: 'hello', kind: 'file', ref: '../outside.md' }),
    e => e.code === 'BOARD_BAD_INPUT'
  );
  assert.equal(fs.readFileSync(path.join(ws.root, 'hello', 'x.md'), 'utf8'), 'x\n');
  assert.deepEqual(findAll(ws.root), ['hello/', 'hello/howdy/', 'hello/howdy/deep.md', 'hello/x.md', 'top.md']);
});

test('migration: bound groups become lanes with a folder card, cards keep their lane', async t => {
  const ws = workspace(t);
  fs.mkdirSync(path.join(ws.root, 'plans', 'q3'), { recursive: true });
  fs.writeFileSync(path.join(ws.root, 'plans', 'README.md'), 'first plan\n');
  fs.writeFileSync(path.join(ws.root, 'plans', 'q3', 'notes.md'), 'notes\n');
  legacyBoard(ws.root, `
    INSERT INTO board_groups (group_id, parent_id, title, orientation, sort_order, folder_path, color, face, icon, fields_json, created_at)
      VALUES (1, NULL, 'plans', 'horizontal', 100, 'plans', '${STICKY_COLORS[2]}', 'card', 'P', '[{"label":"owner","value":"dan"}]', '2026-01-01');
    INSERT INTO board_groups (group_id, parent_id, title, orientation, sort_order, folder_path, created_at)
      VALUES (2, 1, 'q3', 'vertical', 100, 'plans/q3', '2026-01-01');
    INSERT INTO board_groups (group_id, parent_id, title, orientation, sort_order, folder_path, created_at)
      VALUES (3, NULL, 'legacy', 'vertical', 110, NULL, '2026-01-01');
    INSERT INTO board_groups (group_id, parent_id, title, orientation, sort_order, folder_path, created_at)
      VALUES (4, 3, 'legacy inner', 'horizontal', 100, NULL, '2026-01-01');
    INSERT INTO board_cards (group_id, kind, ref, title, sort_order, created_at) VALUES (1, 'file', 'plans/README.md', 'README.md', 100, '2026-01-01');
    INSERT INTO board_cards (group_id, kind, ref, title, sort_order, created_at) VALUES (2, 'file', 'plans/q3/notes.md', 'notes.md', 100, '2026-01-01');
    INSERT INTO board_cards (group_id, kind, ref, title, sort_order, created_at) VALUES (4, 'note', 'inner note', 'inner note', 100, '2026-01-01');
    INSERT INTO board_cards (group_id, kind, ref, title, sort_order, created_at) VALUES (NULL, 'note', 'floor note', 'floor note', 100, '2026-01-01');
  `);
  const before = findAll(ws.root);
  const root = await act(ws, 'tree');
  assert.deepEqual(root.lanes.map(l => [l.name, l.orientation, l.parent_lane_id]), [['plans', 'horizontal', null], ['legacy', 'vertical', null]]);
  const plans = root.lanes[0];
  assert.deepEqual(plans.cards.map(c => [c.kind, c.ref, c.title, c.color, c.face, c.icon, c.fields_json]), [
    ['folder', 'plans', 'plans', STICKY_COLORS[2], 'card', 'P', '[{"label":"owner","value":"dan"}]'],
    ['file', 'plans/README.md', 'README.md', null, 'card', 'file', '[]']
  ]);
  const legacy = root.lanes[1];
  assert.deepEqual(legacy.lanes.map(l => [l.name, l.orientation, l.cards.map(c => c.ref)]), [['legacy inner', 'horizontal', ['inner note']]]);
  assert.deepEqual(root.cards.map(c => c.ref), ['floor note']);
  const inPlans = await act(ws, 'tree', { surface: 'plans' });
  assert.deepEqual(inPlans.lanes.map(l => [l.name, l.parent_lane_id, l.cards.map(c => [c.kind, c.ref])]), [
    ['q3', null, [['folder', 'plans/q3'], ['file', 'plans/q3/notes.md']]]
  ]);
  assert.deepEqual(findAll(ws.root), before);
  const db = new DatabaseSync(path.join(ws.root, '.research-ops', 'board.sqlite3'));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  db.close();
  assert.deepEqual(tables, ['board_cards', 'board_lanes']);
  const added = await act(ws, 'add-card', { surface: 'plans', laneId: inPlans.lanes[0].lane_id, kind: 'file', name: 'new.md' });
  assert.equal(added.ref, 'plans/new.md');
});

test('migration: a board from before folder_path and color, group_id NOT NULL', async t => {
  const ws = workspace(t);
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
  const { lanes } = await act(ws, 'tree');
  assert.deepEqual(lanes.map(l => [l.name, l.cards.map(c => [c.ref, c.color, c.face])]), [['Old', [['pre-color note', null, 'card']]]]);
  const colored = await act(ws, 'update-card', { cardId: lanes[0].cards[0].card_id, color: STICKY_COLORS[3] });
  assert.equal(colored.color, STICKY_COLORS[3]);
  const floor = await act(ws, 'add-card', { kind: 'note', ref: 'a thought' });
  assert.equal(floor.lane_id, null);
});

test('tree nests lanes and cards ordered by sort_order', async t => {
  const ws = workspace(t);
  const a = await act(ws, 'add-lane', { name: 'A', orientation: 'horizontal' });
  const b = await act(ws, 'add-lane', { name: 'B' });
  const a1 = await act(ws, 'add-lane', { name: 'A1', parentLaneId: a.lane_id });
  await act(ws, 'add-card', { laneId: a1.lane_id, kind: 'note', ref: 'first note' });
  await act(ws, 'add-card', { laneId: a1.lane_id, kind: 'file', name: 'plan.md', title: 'Plan' });
  const { lanes } = await act(ws, 'tree');
  assert.deepEqual(lanes.map(l => l.name), ['A', 'B']);
  assert.equal(lanes[0].orientation, 'horizontal');
  assert.equal(b.orientation, 'vertical');
  assert.deepEqual(lanes[0].lanes[0].cards.map(c => c.ref), ['first note', 'plan.md']);
  const [n1, n2] = lanes[0].lanes[0].cards;
  await act(ws, 'move-card', { cardId: n1.card_id, toLaneId: a1.lane_id, sortOrder: n2.sort_order + 10 });
  const after = await act(ws, 'tree');
  assert.deepEqual(after.lanes[0].lanes[0].cards.map(c => c.ref), ['plan.md', 'first note']);
});

test('move-lane reparents; rename and set-orientation stick', async t => {
  const ws = workspace(t);
  const a = await act(ws, 'add-lane', { name: 'A' });
  const b = await act(ws, 'add-lane', { name: 'B' });
  await act(ws, 'move-lane', { laneId: a.lane_id, toParentLaneId: b.lane_id, sortOrder: 20 });
  await act(ws, 'rename', { laneId: a.lane_id, name: 'A renamed' });
  await act(ws, 'set-orientation', { laneId: b.lane_id, orientation: 'horizontal' });
  const { lanes } = await act(ws, 'tree');
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].name, 'B');
  assert.equal(lanes[0].orientation, 'horizontal');
  assert.deepEqual(lanes[0].lanes.map(l => l.name), ['A renamed']);
  await assert.rejects(act(ws, 'rename', { laneId: a.lane_id, name: '  ' }), e => e.code === 'BOARD_BAD_INPUT');
  await assert.rejects(act(ws, 'set-orientation', { laneId: a.lane_id, orientation: 'diagonal' }), e => e.code === 'BOARD_BAD_INPUT');
  const db = new DatabaseSync(path.join(ws.root, '.research-ops', 'board.sqlite3'));
  const row = db.prepare('SELECT name, orientation FROM board_lanes WHERE lane_id=?').get(b.lane_id);
  db.close();
  assert.deepEqual([row.name, row.orientation], ['B', 'horizontal']);
});

test('move-lane refuses a cycle; nesting stops at depth 3 on create and move', async t => {
  const ws = workspace(t);
  const a = await act(ws, 'add-lane', { name: 'A' });
  const a1 = await act(ws, 'add-lane', { name: 'A1', parentLaneId: a.lane_id });
  const a2 = await act(ws, 'add-lane', { name: 'A2', parentLaneId: a1.lane_id });
  await assert.rejects(act(ws, 'move-lane', { laneId: a.lane_id, toParentLaneId: a2.lane_id, sortOrder: 10 }), e => e.code === 'BOARD_CYCLE');
  await assert.rejects(act(ws, 'move-lane', { laneId: a.lane_id, toParentLaneId: a.lane_id, sortOrder: 10 }), e => e.code === 'BOARD_CYCLE');
  await assert.rejects(act(ws, 'add-lane', { name: 'A3', parentLaneId: a2.lane_id }), e => e.code === 'BOARD_DEPTH');
  const b = await act(ws, 'add-lane', { name: 'B' });
  const b1 = await act(ws, 'add-lane', { name: 'B1', parentLaneId: b.lane_id });
  await assert.rejects(act(ws, 'move-lane', { laneId: a1.lane_id, toParentLaneId: b1.lane_id, sortOrder: 10 }), e => e.code === 'BOARD_DEPTH');
  await act(ws, 'move-lane', { laneId: a2.lane_id, toParentLaneId: b1.lane_id, sortOrder: 10 });
  const leaf = await act(ws, 'add-card', { laneId: a2.lane_id, kind: 'file', name: 'leaf.md' });
  assert.equal(leaf.ref, 'leaf.md');
  const { lanes } = await act(ws, 'tree');
  assert.equal(lanes[1].lanes[0].lanes[0].name, 'A2');
});

test('removing a card drops the row and leaves the disk alone', async t => {
  const ws = workspace(t);
  const folder = await act(ws, 'add-card', { kind: 'folder', name: 'plans' });
  const file = await act(ws, 'add-card', { kind: 'file', name: 'README.md', body: 'stay' });
  assert.equal((await act(ws, 'remove', { cardId: folder.card_id })).removed, 'card');
  assert.equal((await act(ws, 'remove', { cardId: file.card_id })).removed, 'card');
  assert.equal(fs.statSync(path.join(ws.root, 'plans')).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(ws.root, 'README.md'), 'utf8'), 'stay\n');
  assert.deepEqual((await act(ws, 'tree')).cards, []);
  await assert.rejects(act(ws, 'remove', { cardId: file.card_id }), e => e.code === 'BOARD_NOT_FOUND');
});

test('removing a lane drops its cards, and its inner lanes\' cards, to the floor of the same surface', async t => {
  const ws = workspace(t);
  fs.mkdirSync(path.join(ws.root, 'hello'));
  const s = { surface: 'hello' };
  const a = await act(ws, 'add-lane', { ...s, name: 'A' });
  const a1 = await act(ws, 'add-lane', { ...s, name: 'A1', parentLaneId: a.lane_id });
  await act(ws, 'add-lane', { ...s, name: 'B' });
  const floor = await act(ws, 'add-card', { ...s, kind: 'note', ref: 'already on the floor' });
  const inner = await act(ws, 'add-card', { ...s, laneId: a1.lane_id, kind: 'note', ref: 'inner' });
  const file = await act(ws, 'add-card', { ...s, laneId: a.lane_id, kind: 'file', name: 'README.md', body: 'stay' });
  const rootNote = await act(ws, 'add-card', { kind: 'note', ref: 'root surface' });
  const removed = await act(ws, 'remove', { laneId: a.lane_id });
  assert.equal(removed.cards, 'floor');
  assert.equal(removed.removed, 'lane');
  const { lanes, cards } = await act(ws, 'tree', s);
  assert.deepEqual(lanes.map(l => l.name), ['B']);
  assert.deepEqual(cards.map(c => [c.card_id, c.ref, c.lane_id]), [
    [floor.card_id, 'already on the floor', null], [file.card_id, 'hello/README.md', null], [inner.card_id, 'inner', null]
  ]);
  assert.ok(cards[1].sort_order > cards[0].sort_order && cards[2].sort_order > cards[1].sort_order);
  assert.deepEqual((await act(ws, 'tree')).cards.map(c => c.card_id), [rootNote.card_id]);
  assert.equal(fs.readFileSync(path.join(ws.root, 'hello', 'README.md'), 'utf8'), 'stay\n');
});

test('a folder card adopts a folder already on disk and refuses a file at that path', async t => {
  const ws = workspace(t);
  fs.mkdirSync(path.join(ws.root, 'plans'));
  fs.writeFileSync(path.join(ws.root, 'plans', 'keep.md'), 'keep\n');
  const mtime = fs.statSync(path.join(ws.root, 'plans', 'keep.md')).mtimeMs;
  const card = await act(ws, 'add-card', { kind: 'folder', name: 'plans' });
  assert.equal(card.ref, 'plans');
  assert.equal(fs.statSync(path.join(ws.root, 'plans', 'keep.md')).mtimeMs, mtime);
  fs.writeFileSync(path.join(ws.root, 'afile'), '');
  await assert.rejects(act(ws, 'add-card', { kind: 'folder', name: 'afile' }), e => e.code === 'BOARD_BAD_INPUT');
});

test('a card lane and a surface must match', async t => {
  const ws = workspace(t);
  fs.mkdirSync(path.join(ws.root, 'hello'));
  const lane = await act(ws, 'add-lane', { surface: 'hello', name: 'task' });
  await assert.rejects(act(ws, 'add-card', { laneId: lane.lane_id, kind: 'note', ref: 'wrong surface' }), e => e.code === 'BOARD_BAD_INPUT');
  await assert.rejects(act(ws, 'add-lane', { name: 'inner', parentLaneId: lane.lane_id }), e => e.code === 'BOARD_BAD_INPUT');
  await assert.rejects(act(ws, 'tree', { surface: '../up' }), e => e.code === 'BOARD_BAD_INPUT');
});

test('color round-trips on file, link, and note cards; update-card validates the palette', async t => {
  const ws = workspace(t);
  const g = await act(ws, 'add-lane', { name: 'G' });
  const file = await act(ws, 'add-card', { laneId: g.lane_id, kind: 'file', name: 'plan.md', color: STICKY_COLORS[1] });
  const link = await act(ws, 'add-card', { laneId: g.lane_id, kind: 'link', ref: 'http://127.0.0.1:9', color: STICKY_COLORS[2] });
  const note = await act(ws, 'add-card', { laneId: g.lane_id, kind: 'note', ref: 'hello\nworld', color: STICKY_COLORS[3] });
  assert.deepEqual([file.color, link.color, note.color], [STICKY_COLORS[1], STICKY_COLORS[2], STICKY_COLORS[3]]);
  await act(ws, 'update-card', { cardId: file.card_id, color: STICKY_COLORS[4] });
  await act(ws, 'update-card', { cardId: note.card_id, color: null });
  const { lanes } = await act(ws, 'tree');
  const byKind = Object.fromEntries(lanes[0].cards.map(c => [c.kind, c.color]));
  assert.deepEqual(byKind, { file: STICKY_COLORS[4], link: STICKY_COLORS[2], note: null });
  await assert.rejects(act(ws, 'update-card', { cardId: note.card_id, color: '#123456' }), e => e.code === 'BOARD_BAD_INPUT');
  await assert.rejects(act(ws, 'add-card', { laneId: g.lane_id, kind: 'note', ref: 'nope', color: '#123456' }), e => e.code === 'BOARD_BAD_INPUT');
});

test('update-card writes color and text in one call', async t => {
  const ws = workspace(t);
  const note = await act(ws, 'add-card', { kind: 'note', ref: 'old' });
  const link = await act(ws, 'add-card', { kind: 'link', ref: 'http://127.0.0.1:9', title: 'old' });
  const file = await act(ws, 'add-card', { kind: 'file', name: 'README.md' });
  const noteOut = await act(ws, 'update-card', { cardId: note.card_id, color: STICKY_COLORS[1], text: 'hello\nworld' });
  assert.equal(noteOut.color, STICKY_COLORS[1]);
  assert.equal(noteOut.ref, 'hello\nworld');
  const linkOut = await act(ws, 'update-card', { cardId: link.card_id, color: STICKY_COLORS[2], name: 'renamed' });
  assert.equal(linkOut.title, 'renamed');
  const fileOut = await act(ws, 'update-card', { cardId: file.card_id, color: STICKY_COLORS[3] });
  assert.equal(fileOut.ref, 'README.md');
});

test('agent surface may read the tree but never mutate', async t => {
  const ws = workspace(t);
  const a = await act(ws, 'add-lane', { name: 'A' });
  const card = await act(ws, 'add-card', { laneId: a.lane_id, kind: 'note', ref: 'owner note' });
  const { lanes } = await act(ws, 'tree', {}, 'agent');
  assert.equal(lanes.length, 1);
  const mutations = [
    ['add-lane', { name: 'nope' }],
    ['add-card', { kind: 'folder', name: 'nope' }],
    ['add-card', { laneId: a.lane_id, kind: 'note', ref: 'nope' }],
    ['rename', { laneId: a.lane_id, name: 'nope' }],
    ['set-orientation', { laneId: a.lane_id, orientation: 'horizontal' }],
    ['update-card', { cardId: card.card_id, color: null, text: 'nope' }],
    ['move-card', { cardId: card.card_id, toLaneId: null, sortOrder: 5 }],
    ['move-lane', { laneId: a.lane_id, toParentLaneId: null, sortOrder: 5 }],
    ['remove', { cardId: card.card_id }],
    ['save-to-project', { destination: 'projects', name: 'nope', model: { lanes: [], cards: [] } }]
  ];
  for (const [action, payload] of mutations) {
    await assert.rejects(act(ws, action, payload, 'agent'), error => error.code === 'OWNER_SURFACE_ONLY');
  }
  const after = await act(ws, 'tree');
  assert.deepEqual(after.lanes[0].cards.map(c => c.ref), ['owner note']);
});

test('needName refuses a name that is not one path segment; existing file refused', async t => {
  const ws = workspace(t);
  for (const name of ['../esc', '/tmp/x', 'a/b', '.']) {
    await assert.rejects(act(ws, 'add-card', { kind: 'folder', name }), e => e.code === 'BOARD_BAD_INPUT' && /one path segment/.test(e.message));
    await assert.rejects(act(ws, 'add-card', { kind: 'file', name }), e => e.code === 'BOARD_BAD_INPUT' && /one path segment/.test(e.message));
  }
  assert.equal(fs.existsSync('/tmp/outside.md'), false);
  await act(ws, 'add-card', { kind: 'file', name: 'README.md', body: 'first' });
  await assert.rejects(
    act(ws, 'add-card', { kind: 'file', name: 'README.md', body: 'second' }),
    error => error.code === 'ALREADY_EXISTS' || /Already exists/.test(error.message)
  );
  assert.equal(fs.readFileSync(path.join(ws.root, 'README.md'), 'utf8'), 'first\n');
});

test('fields round-trip and a fifth field is refused', async t => {
  const ws = workspace(t);
  const fields = [{ label: 'owner', value: 'dan' }, { label: 'due', value: 'friday' }];
  const card = await act(ws, 'add-card', { kind: 'file', name: 'README.md', fields });
  assert.deepEqual(JSON.parse(card.fields_json), fields);
  const updated = await act(ws, 'update-card', { cardId: card.card_id, fields: [fields[0], { label: 'due', value: 'monday' }] });
  assert.deepEqual(JSON.parse(updated.fields_json)[1], { label: 'due', value: 'monday' });
  const five = ['a', 'b', 'c', 'd', 'e'].map(l => ({ label: l, value: l }));
  await assert.rejects(act(ws, 'add-card', { kind: 'note', ref: 'n', fields: five }), e => e.code === 'BOARD_BAD_INPUT');
  await assert.rejects(act(ws, 'update-card', { cardId: card.card_id, fields: five }), e => e.code === 'BOARD_BAD_INPUT');
});

test('face persists on file, note, and folder cards', async t => {
  const ws = workspace(t);
  const file = await act(ws, 'add-card', { kind: 'file', name: 'README.md' });
  assert.deepEqual([file.face, file.icon], ['card', 'file']);
  const note = await act(ws, 'add-card', { kind: 'note', ref: 'hello' });
  assert.deepEqual([note.face, note.icon], ['card', 'note']);
  const folder = await act(ws, 'add-card', { kind: 'folder', name: 'plans' });
  assert.deepEqual([folder.face, folder.icon], ['sticky', 'folder']);
  const flipped = await act(ws, 'update-card', { cardId: file.card_id, face: 'sticky', icon: 'P' });
  assert.deepEqual([flipped.face, flipped.icon], ['sticky', 'P']);
  const folderFlip = await act(ws, 'update-card', { cardId: folder.card_id, face: 'card' });
  assert.equal(folderFlip.face, 'card');
  const { cards } = await act(ws, 'tree');
  assert.deepEqual(cards.map(c => [c.kind, c.face]), [['file', 'sticky'], ['note', 'card'], ['folder', 'card']]);
  await assert.rejects(act(ws, 'update-card', { cardId: file.card_id, face: 'back' }), e => e.code === 'BOARD_BAD_INPUT');
  await assert.rejects(act(ws, 'update-card', { cardId: file.card_id, icon: 'xyz' }), e => e.code === 'BOARD_BAD_INPUT');
});
