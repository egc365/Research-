import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { plugin } from '../plugins/server/board.mjs';
import { ControlStore } from '../src/store.mjs';
import { plugin as stickies } from '../plugins/server/stickies.mjs';
import { boardStore, emptyModel, parseModel, serializeModel } from '../public/contrib/lib/board-store.js';
import { contributions, defaultWiring, stations } from '../plugins/registry.mjs';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;
// A 1x1 JPEG: the bytes must come back under a .jpg name, untouched.
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=',
  'base64'
);
const JPEG_URL = `data:image/jpeg;base64,${JPEG.toString('base64')}`;

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-ops-whiteboard-'));
  const root = path.join(dir, 'ws');
  fs.mkdirSync(root);
  const store = new ControlStore(path.join(dir, 'control.sqlite3'));
  store.addWorkspace(root, 'whiteboard-test');
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { root, store, dir };
}

function act(ws, action, payload = {}, surface = 'owner') {
  return plugin.action({ action, payload: { rootPath: ws.root, ...payload }, surface, store: ws.store });
}

function fakeStorage(t) {
  const bag = new Map();
  const prev = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: k => bag.get(k) ?? null,
    setItem: (k, v) => bag.set(k, v),
    removeItem: k => bag.delete(k)
  };
  t.after(() => { globalThis.localStorage = prev; });
  return bag;
}

function sketchModel() {
  return {
    lanes: [
      { lane_id: 1, surface: '', parent_lane_id: null, name: 'plans', slug: 'plans', orientation: 'horizontal', x: 24, y: 80, w: 560, sort_order: 100 },
      { lane_id: 2, surface: '', parent_lane_id: 1, name: 'q3', orientation: 'vertical', sort_order: 100 },
      { lane_id: 3, surface: 'howdy', parent_lane_id: null, name: 'inside', orientation: 'vertical', sort_order: 100 }
    ],
    cards: [
      { card_id: 1, surface: '', lane_id: 1, kind: 'file', ref: 'README.md', title: 'README.md', body: 'the name given', text: 'sticky words', sort_order: 100 },
      { card_id: 2, surface: '', lane_id: 1, kind: 'note', ref: 'first words', title: 'first words', sort_order: 110 },
      { card_id: 3, surface: '', lane_id: 1, kind: 'image', ref: DATA_URL, title: 'sketch.png', width: 240, sort_order: 120 },
      { card_id: 8, surface: '', lane_id: 1, kind: 'image', ref: JPEG_URL, title: 'photo.jpg', sort_order: 125 },
      { card_id: 4, surface: '', lane_id: 2, kind: 'note', ref: 'notes', title: 'notes', sort_order: 100 },
      { card_id: 5, surface: '', lane_id: 2, kind: 'note', ref: 'notes', title: 'notes', sort_order: 110 },
      { card_id: 6, surface: '', lane_id: null, kind: 'folder', ref: 'howdy', title: 'howdy', sort_order: 100 },
      { card_id: 7, surface: 'howdy', lane_id: 3, kind: 'file', ref: 'howdy/deep.md', title: 'deep', body: 'deep', sort_order: 100 }
    ]
  };
}

test('whiteboard-view is the card view on the board source, mounted with mode whiteboard', () => {
  const station = stations.find(s => s.id === 'whiteboard');
  assert.ok(station);
  assert.equal(station.label, 'Whiteboard');
  assert.equal(station.manifest.category, undefined);
  const contrib = contributions.find(c => c.id === 'whiteboard-view');
  assert.equal(contrib.entry, '/contrib/card-view.js');
  assert.deepEqual(contrib.config, { view: 'board', mode: 'whiteboard' });
  assert.deepEqual(defaultWiring.whiteboard.main, [
    { id: 'whiteboard-view', config: { mode: 'whiteboard' } }
  ]);
});

test('in-memory model round-trips through its serializer; a v1 blob is refused', () => {
  const model = emptyModel();
  model.lanes.push({
    lane_id: 1, surface: '', parent_lane_id: null, name: 'plans', orientation: 'vertical',
    sort_order: 100, created_at: '2026-09-02T00:00:00.000Z'
  });
  model.cards.push(
    {
      card_id: 1, surface: '', lane_id: 1, kind: 'file', ref: 'README.md', title: 'README.md',
      body: 'the name given', color: null, face: null, icon: 'file',
      fields_json: '[]', sort_order: 100, created_at: '2026-09-02T00:00:00.000Z'
    },
    {
      card_id: 2, surface: '', lane_id: 1, kind: 'image', ref: DATA_URL, title: 'sketch.png',
      color: null, face: null, icon: 'image', fields_json: '[]', sort_order: 120,
      width: 180, created_at: '2026-09-02T00:00:00.000Z'
    }
  );
  model.nextLane = 2;
  model.nextCard = 3;
  const back = parseModel(serializeModel(model));
  assert.equal(back.lanes[0].name, 'plans');
  assert.equal(back.cards[0].body, 'the name given');
  assert.equal(back.cards[1].width, 180);
  assert.equal(back.nextLane, 2);
  assert.equal(back.nextCard, 3);
  assert.deepEqual(parseModel(serializeModel(emptyModel())), emptyModel());
  assert.throws(() => parseModel(JSON.stringify({ v: 1, groups: [], cards: [] })), /version/);
});

test('whiteboard store never calls the board service or the filesystem', async t => {
  const ws = workspace(t);
  const bag = fakeStorage(t);
  const ctx = {
    workspace: { root_path: ws.root },
    action() { throw new Error('board service should not be called'); }
  };
  const access = boardStore(ctx, { mode: 'whiteboard' });
  const plans = await access.call('add-lane', { name: 'plans' });
  await access.call('add-card', { laneId: plans.lane_id, kind: 'note', ref: 'first words' });
  await access.call('add-card', { laneId: plans.lane_id, kind: 'image', ref: DATA_URL, title: 'sketch.png' });
  const file = await access.call('add-card', { laneId: plans.lane_id, kind: 'file', name: 'plan.md', body: 'plan' });
  const howdy = await access.call('add-card', { kind: 'folder', name: 'howdy' });
  const inside = await access.call('add-lane', { surface: 'howdy', name: 'inside' });
  await access.call('add-card', { surface: 'howdy', laneId: inside.lane_id, kind: 'file', name: 'deep.md' });
  await access.call('move-card', { cardId: file.card_id, toLaneId: null, sortOrder: 200 });
  const doomed = await access.call('add-lane', { name: 'doomed' });
  const survivor = await access.call('add-card', { laneId: doomed.lane_id, kind: 'note', ref: 'survivor' });
  assert.equal((await access.call('remove', { laneId: doomed.lane_id })).cards, 'floor');
  const tree = await access.call('tree');
  assert.equal(tree.lanes[0].name, 'plans');
  assert.deepEqual(tree.lanes[0].cards.map(c => c.kind), ['note', 'image']);
  assert.deepEqual(tree.cards.map(c => [c.kind, c.ref]), [['folder', 'howdy'], ['file', 'plan.md'], ['note', 'survivor']]);
  assert.equal(tree.lanes.length, 1);
  assert.equal(survivor.lane_id, doomed.lane_id);
  const deeper = await access.call('tree', { surface: 'howdy' });
  assert.deepEqual(deeper.lanes[0].cards.map(c => c.ref), ['howdy/deep.md']);
  assert.equal(howdy.ref, 'howdy');
  assert.equal(fs.existsSync(path.join(ws.root, 'howdy')), false);
  assert.equal(fs.existsSync(path.join(ws.root, 'plan.md')), false);
  assert.equal(fs.existsSync(path.join(ws.root, '.research-ops', 'board.sqlite3')), false);
  const stored = parseModel(bag.get(`ro.whiteboard.${ws.root}`));
  assert.equal(stored.lanes[0].name, 'plans');
  assert.equal(stored.cards.length, 6);
});

test('Save creates <parent>/<name>, writes files flat inside it, lanes into the board, and LANES.json', async t => {
  const ws = workspace(t);
  const saved = await act(ws, 'save-to-project', { parent: 'projects', name: 'Q3 plan', model: sketchModel() });
  assert.equal(saved.destination, 'projects/Q3 plan');
  assert.equal(saved.surface, 'projects/Q3 plan');
  const dest = path.join(ws.root, 'projects', 'Q3 plan');
  const found = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      found.push(path.relative(dest, abs).split(path.sep).join('/'));
      if (fs.statSync(abs).isDirectory()) walk(abs);
    }
  }
  walk(dest);
  assert.deepEqual(found, ['LANES.json', 'README.md', 'first-words.md', 'howdy', 'howdy/deep.md', 'notes-2.md', 'notes.md', 'photo.jpg', 'sketch.png']);
  assert.equal(fs.readFileSync(path.join(dest, 'README.md'), 'utf8'), 'the name given\n');
  assert.equal(fs.readFileSync(path.join(dest, 'first-words.md'), 'utf8'), 'first words\n');
  assert.equal(fs.readFileSync(path.join(dest, 'sketch.png')).equals(PNG), true);
  assert.equal(fs.readFileSync(path.join(dest, 'photo.jpg')).equals(JPEG), true);
  assert.equal(fs.readFileSync(path.join(dest, 'howdy', 'deep.md'), 'utf8'), 'deep\n');
  const p = 'projects/Q3 plan';
  const { lanes, cards } = await act(ws, 'tree', { surface: p });
  assert.deepEqual(lanes.map(l => [l.name, l.orientation, l.cards.map(c => c.ref), l.lanes.map(i => [i.name, i.cards.map(c => c.ref)])]), [
    ['plans', 'horizontal', [`${p}/README.md`, `${p}/first-words.md`, `${p}/sketch.png`, `${p}/photo.jpg`], [['q3', [`${p}/notes.md`, `${p}/notes-2.md`]]]]
  ]);
  // Image width survives save; the sticky text typed on the sketch is the file's sticky note.
  assert.deepEqual(lanes[0].cards.map(c => c.width), [null, null, 240, null]);
  const { notes } = await stickies.action({ action: 'list', payload: { rootPath: ws.root }, surface: 'owner' });
  assert.equal(notes[`${p}/README.md`].text, 'sticky words');
  assert.deepEqual(cards.map(c => [c.kind, c.ref]), [['folder', `${p}/howdy`]]);
  const inside = await act(ws, 'tree', { surface: `${p}/howdy` });
  assert.deepEqual(inside.lanes.map(l => [l.name, l.cards.map(c => c.ref)]), [['inside', [`${p}/howdy/deep.md`]]]);
  const outline = JSON.parse(fs.readFileSync(path.join(dest, 'LANES.json'), 'utf8'));
  assert.deepEqual(outline[''].lanes[0].lanes[0], { name: 'q3', slug: 'q3', orientation: 'vertical', x: null, y: null, w: null, cards: [`${p}/notes.md`, `${p}/notes-2.md`], lanes: [] });
  assert.deepEqual([outline[''].lanes[0].slug, outline[''].lanes[0].x, outline[''].lanes[0].y, outline[''].lanes[0].w], ['plans', 24, 80, 560]);
  assert.deepEqual([lanes[0].slug, lanes[0].x, lanes[0].y, lanes[0].w], ['plans', 24, 80, 560], 'the destination rows carry the sketch positions');
  assert.deepEqual([inside.lanes[0].x, inside.lanes[0].y], [24, 24], 'a sketch lane without a position takes the next spot');
  assert.deepEqual(outline[''].cards, [`${p}/howdy`]);
  assert.deepEqual(outline.howdy.lanes[0].cards, [`${p}/howdy/deep.md`]);
  assert.ok(ws.store.getArtifact(path.join(dest, 'README.md')));
  assert.ok(ws.store.getArtifact(path.join(dest, 'sketch.png')));
  assert.ok(ws.store.getArtifact(path.join(dest, 'LANES.json')));
});

test('Save refuses a project folder that exists, and a name that is not one segment', async t => {
  const ws = workspace(t);
  fs.mkdirSync(path.join(ws.root, 'projects', 'Q3 plan'), { recursive: true });
  fs.writeFileSync(path.join(ws.root, 'projects', 'Q3 plan', 'already.md'), 'nope\n');
  await assert.rejects(
    act(ws, 'save-to-project', { parent: 'projects', name: 'Q3 plan', model: sketchModel() }),
    error => error.code === 'BOARD_EXISTS' && error.message === 'projects/Q3 plan exists'
  );
  assert.deepEqual(fs.readdirSync(path.join(ws.root, 'projects', 'Q3 plan')), ['already.md']);
  await assert.rejects(
    act(ws, 'save-to-project', { parent: 'projects', name: 'a/b', model: sketchModel() }),
    error => error.code === 'BOARD_BAD_INPUT' && /one path segment/.test(error.message)
  );
  const { lanes } = await act(ws, 'tree', { surface: 'projects/Q3 plan' });
  assert.deepEqual(lanes, []);
});

test('whiteboard sticky text lives on the memory row; width and duplicate lane names are the store\'s rules', async t => {
  const ws = workspace(t);
  fakeStorage(t);
  const ctx = {
    workspace: { root_path: ws.root },
    action() { throw new Error('no service is called while sketching'); }
  };
  const access = boardStore(ctx, { mode: 'whiteboard' });
  const plans = await access.call('add-lane', { name: 'plans' });
  const file = await access.call('add-card', { laneId: plans.lane_id, kind: 'file', name: 'README.md', body: 'first line' });
  const typed = await access.call('update-card', { cardId: file.card_id, text: 'sticky words' });
  assert.equal(typed.text, 'sticky words');
  assert.equal(typed.body, 'first line');
  assert.equal((await access.call('tree')).lanes[0].cards[0].text, 'sticky words');
  assert.equal((await access.call('update-card', { cardId: file.card_id, text: '' })).text, '');
  assert.equal(fs.existsSync(path.join(ws.root, '.research-ops')), false);

  const photo = await access.call('add-card', { laneId: plans.lane_id, kind: 'image', ref: JPEG_URL, title: 'photo.png' });
  assert.equal(photo.title, 'photo.jpg');
  assert.equal(photo.width, null);
  assert.equal((await access.call('update-card', { cardId: photo.card_id, width: 240 })).width, 240);
  await assert.rejects(access.call('update-card', { cardId: photo.card_id, width: -3 }), e => e.code === 'BOARD_BAD_INPUT');
  await assert.rejects(access.call('add-card', { laneId: plans.lane_id, kind: 'image', ref: 'data:image/png;base64,' + 'A'.repeat(2800000), title: 'big.png' }),
    e => e.code === 'BOARD_BAD_INPUT' && /2 MB/.test(e.message));

  await assert.rejects(access.call('add-lane', { name: 'plans' }), e => e.code === 'BOARD_BAD_INPUT' && /already here/.test(e.message));
  const q3 = await access.call('add-lane', { name: 'q3' });
  await assert.rejects(access.call('rename', { laneId: q3.lane_id, name: 'plans' }), e => /already here/.test(e.message));
  await access.call('add-lane', { parentLaneId: plans.lane_id, name: 'q3' });
  await assert.rejects(access.call('move-lane', { laneId: q3.lane_id, parentLaneId: plans.lane_id, sortOrder: 200 }), e => /already here/.test(e.message));
  await access.call('add-lane', { surface: 'elsewhere', name: 'plans' });
  assert.equal((await access.call('tree')).lanes.length, 2);
});

test('Save from the memory store sends its rows and empties the sketch', async t => {
  const ws = workspace(t);
  const bag = fakeStorage(t);
  const ctx = {
    workspace: { root_path: ws.root },
    action: (id, action, payload) => plugin.action({ action, payload, surface: 'owner', store: ws.store })
  };
  const access = boardStore(ctx, { mode: 'whiteboard' });
  const lane = await access.call('add-lane', { name: 'task 1' });
  await access.call('add-card', { laneId: lane.lane_id, kind: 'file', name: 'plan.md', body: 'plan' });
  const result = await access.call('save-to-project', { parent: 'projects', name: 'P' });
  assert.equal(result.destination, 'projects/P');
  assert.deepEqual(result.lanes.map(l => [l.name, l.cards.map(c => c.ref)]), [['task 1', ['projects/P/plan.md']]]);
  assert.equal(fs.existsSync(path.join(ws.root, 'projects', 'P', 'task 1')), false);
  assert.equal(fs.readFileSync(path.join(ws.root, 'projects', 'P', 'plan.md'), 'utf8'), 'plan\n');
  assert.deepEqual(parseModel(bag.get(`ro.whiteboard.${ws.root}`)), emptyModel());
});

test('the memory store refuses a second file of the same name on a surface, as the server does', async t => {
  const ws = workspace(t);
  fakeStorage(t);
  const ctx = {
    workspace: { root_path: ws.root },
    action: (id, action, payload) => plugin.action({ action, payload, surface: 'owner', store: ws.store })
  };
  const access = boardStore(ctx, { mode: 'whiteboard' });
  const lane = await access.call('add-lane', { name: 'task 1' });
  await access.call('add-card', { laneId: lane.lane_id, kind: 'file', name: 'plan.md', body: 'plan' });
  await access.call('add-card', { kind: 'file', name: 'README.md' });
  await assert.rejects(access.call('add-card', { kind: 'file', name: 'plan.md' }),
    e => e.code === 'BOARD_DUPLICATE' && e.message === 'plan.md is already on this surface, in lane task 1');
  await assert.rejects(access.call('add-card', { laneId: lane.lane_id, kind: 'file', name: 'README.md' }),
    e => e.code === 'BOARD_DUPLICATE' && e.message === 'README.md is already on this surface, on the floor');
  await access.call('add-card', { surface: 'elsewhere', kind: 'file', name: 'plan.md' });
  const { lanes, cards } = await access.call('tree');
  assert.deepEqual([cards.length, lanes[0].cards.length], [1, 1]);
});

test('whiteboard rows carry position and slug; a sketch from before the canvas is laid out on load, once', async t => {
  const ws = workspace(t);
  const bag = fakeStorage(t);
  const ctx = { workspace: { root_path: ws.root }, action() { throw new Error('board service should not be called'); } };
  bag.set(`ro.whiteboard.${ws.root}`, JSON.stringify({ v: 2, nextLane: 3, nextCard: 1, cards: [], lanes: [
    { lane_id: 1, surface: '', parent_lane_id: null, name: 'Task 1', orientation: 'vertical', sort_order: 100, created_at: '2026-01-01' },
    { lane_id: 2, surface: '', parent_lane_id: null, name: 'Task 2', orientation: 'vertical', sort_order: 110, created_at: '2026-01-01' }
  ] }));
  const access = boardStore(ctx, { mode: 'whiteboard' });
  const { lanes } = await access.call('tree');
  assert.deepEqual(lanes.map(l => [l.slug, l.x, l.y, l.w]), [['task-1', 24, 24, null], ['task-2', 328, 24, null]]);
  assert.deepEqual(parseModel(bag.get(`ro.whiteboard.${ws.root}`)).lanes.map(l => [l.slug, l.x]), [['task-1', 24], ['task-2', 328]], 'written once');
  const hello = await access.call('add-lane', { name: 'hello', x: 24, y: 80, w: 300 });
  assert.deepEqual([hello.slug, hello.x, hello.y, hello.w], ['hello', 24, 80, 300]);
  const inside = await access.call('move-lane', { laneId: hello.lane_id, parentLaneId: 1 });
  assert.deepEqual([inside.parent_lane_id, inside.x, inside.y, inside.w], [1, null, null, 300], 'w rides along through nesting');
  const out = await access.call('move-lane', { laneId: hello.lane_id, parentLaneId: null, x: 24, y: 420 });
  assert.deepEqual([out.parent_lane_id, out.x, out.y, out.sort_order], [null, 24, 420, 120]);
  assert.equal((await access.call('set-width', { laneId: hello.lane_id, w: 560 })).w, 560);
  await assert.rejects(access.call('set-width', { laneId: hello.lane_id, w: -1 }), e => e.code === 'BOARD_BAD_INPUT');
  assert.equal((await access.call('rename', { laneId: hello.lane_id, name: 'Task 1 again' })).slug, 'task-1-again');
  assert.equal((await access.call('add-lane', { name: 'task 2' })).slug, 'task-2-2', 'the name differs by case, the slug takes a suffix');
  const stored = parseModel(bag.get(`ro.whiteboard.${ws.root}`));
  assert.deepEqual(stored.lanes.find(l => l.lane_id === hello.lane_id), { ...out, name: 'Task 1 again', slug: 'task-1-again', w: 560 });
});

test('the whiteboard refuses run-lane: nothing on it is real', async t => {
  const ws = workspace(t);
  fakeStorage(t);
  const ctx = {
    workspace: { root_path: ws.root },
    action: (id, action, payload) => plugin.action({ action, payload, surface: 'owner', store: ws.store })
  };
  const access = boardStore(ctx, { mode: 'whiteboard' });
  const lane = await access.call('add-lane', { name: 'sketch' });
  for (const verb of ['run-lane', 'lane-run-state']) {
    await assert.rejects(access.call(verb, { laneId: lane.lane_id }),
      e => e.code === 'BOARD_BAD_INPUT' && e.message === 'The whiteboard has no runs; save it to a project first');
  }
  assert.equal(ws.store.db.prepare('SELECT COUNT(*) AS n FROM execution_state').get().n, 0);
  assert.equal((await access.call('tree', {})).lanes[0].run_id, undefined, 'memory rows never carry a run id');
});
