import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { plugin } from '../plugins/server/board.mjs';
import { ControlStore } from '../src/store.mjs';
import { boardStore, emptyModel, parseModel, serializeModel } from '../public/contrib/lib/board-store.js';
import { contributions, defaultWiring, stations } from '../plugins/registry.mjs';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;

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
      { lane_id: 1, surface: '', parent_lane_id: null, name: 'plans', orientation: 'horizontal', sort_order: 100 },
      { lane_id: 2, surface: '', parent_lane_id: 1, name: 'q3', orientation: 'vertical', sort_order: 100 },
      { lane_id: 3, surface: 'howdy', parent_lane_id: null, name: 'inside', orientation: 'vertical', sort_order: 100 }
    ],
    cards: [
      { card_id: 1, surface: '', lane_id: 1, kind: 'file', ref: 'README.md', title: 'README.md', body: 'the name given', sort_order: 100 },
      { card_id: 2, surface: '', lane_id: 1, kind: 'note', ref: 'first words', title: 'first words', sort_order: 110 },
      { card_id: 3, surface: '', lane_id: 1, kind: 'image', ref: DATA_URL, title: 'sketch.png', sort_order: 120 },
      { card_id: 4, surface: '', lane_id: 2, kind: 'note', ref: 'notes', title: 'notes', sort_order: 100 },
      { card_id: 5, surface: '', lane_id: 2, kind: 'note', ref: 'notes', title: 'notes', sort_order: 110 },
      { card_id: 6, surface: '', lane_id: null, kind: 'folder', ref: 'howdy', title: 'howdy', sort_order: 100 },
      { card_id: 7, surface: 'howdy', lane_id: 3, kind: 'file', ref: 'howdy/deep.md', title: 'deep', body: 'deep', sort_order: 100 }
    ]
  };
}

test('whiteboard-view is board-view mounted with mode whiteboard', () => {
  const station = stations.find(s => s.id === 'whiteboard');
  assert.ok(station);
  assert.equal(station.label, 'Whiteboard');
  assert.equal(station.manifest.category, undefined);
  const contrib = contributions.find(c => c.id === 'whiteboard-view');
  assert.equal(contrib.entry, '/contrib/board-view.js');
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
      body: 'the name given', color: null, face: 'card', icon: 'file',
      fields_json: '[]', sort_order: 100, created_at: '2026-09-02T00:00:00.000Z'
    },
    {
      card_id: 2, surface: '', lane_id: 1, kind: 'image', ref: DATA_URL, title: 'sketch.png',
      color: null, face: 'card', icon: 'image', fields_json: '[]', sort_order: 120,
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

test('Save writes files flat under the destination, lanes into the board, and LANES.json', async t => {
  const ws = workspace(t);
  const saved = await act(ws, 'save-to-project', { destination: 'projects', name: 'Q3 plan', model: sketchModel() });
  assert.equal(saved.destination, 'projects');
  assert.equal(saved.surface, 'projects');
  const dest = path.join(ws.root, 'projects');
  const found = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      found.push(path.relative(dest, abs).split(path.sep).join('/'));
      if (fs.statSync(abs).isDirectory()) walk(abs);
    }
  }
  walk(dest);
  assert.deepEqual(found, ['LANES.json', 'README.md', 'first-words.md', 'howdy', 'howdy/deep.md', 'notes-2.md', 'notes.md', 'sketch.png']);
  assert.equal(fs.readFileSync(path.join(dest, 'README.md'), 'utf8'), 'the name given\n');
  assert.equal(fs.readFileSync(path.join(dest, 'first-words.md'), 'utf8'), 'first words\n');
  assert.equal(fs.readFileSync(path.join(dest, 'sketch.png')).equals(PNG), true);
  assert.equal(fs.readFileSync(path.join(dest, 'howdy', 'deep.md'), 'utf8'), 'deep\n');
  const { lanes, cards } = await act(ws, 'tree', { surface: 'projects' });
  assert.deepEqual(lanes.map(l => [l.name, l.orientation, l.cards.map(c => c.ref), l.lanes.map(i => [i.name, i.cards.map(c => c.ref)])]), [
    ['plans', 'horizontal', ['projects/README.md', 'projects/first-words.md', 'projects/sketch.png'], [['q3', ['projects/notes.md', 'projects/notes-2.md']]]]
  ]);
  assert.deepEqual(cards.map(c => [c.kind, c.ref]), [['folder', 'projects/howdy']]);
  const inside = await act(ws, 'tree', { surface: 'projects/howdy' });
  assert.deepEqual(inside.lanes.map(l => [l.name, l.cards.map(c => c.ref)]), [['inside', ['projects/howdy/deep.md']]]);
  const outline = JSON.parse(fs.readFileSync(path.join(dest, 'LANES.json'), 'utf8'));
  assert.deepEqual(outline[''].lanes[0].lanes[0], { name: 'q3', orientation: 'vertical', cards: ['projects/notes.md', 'projects/notes-2.md'], lanes: [] });
  assert.deepEqual(outline[''].cards, ['projects/howdy']);
  assert.deepEqual(outline.howdy.lanes[0].cards, ['projects/howdy/deep.md']);
  assert.ok(ws.store.getArtifact(path.join(dest, 'README.md')));
  assert.ok(ws.store.getArtifact(path.join(dest, 'sketch.png')));
  assert.ok(ws.store.getArtifact(path.join(dest, 'LANES.json')));
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
  const result = await access.call('save-to-project', { destination: 'projects', name: 'P' });
  assert.deepEqual(result.lanes.map(l => [l.name, l.cards.map(c => c.ref)]), [['task 1', ['projects/plan.md']]]);
  assert.equal(fs.existsSync(path.join(ws.root, 'projects', 'task 1')), false);
  assert.equal(fs.readFileSync(path.join(ws.root, 'projects', 'plan.md'), 'utf8'), 'plan\n');
  assert.deepEqual(parseModel(bag.get(`ro.whiteboard.${ws.root}`)), emptyModel());
});

test('Save refuses a non-empty destination', async t => {
  const ws = workspace(t);
  fs.mkdirSync(path.join(ws.root, 'projects'));
  fs.writeFileSync(path.join(ws.root, 'projects', 'already.md'), 'nope\n');
  await assert.rejects(
    act(ws, 'save-to-project', { destination: 'projects', name: 'Q3 plan', model: sketchModel() }),
    error => error.code === 'BOARD_NONEMPTY'
  );
  assert.equal(fs.readFileSync(path.join(ws.root, 'projects', 'already.md'), 'utf8'), 'nope\n');
  assert.equal(fs.existsSync(path.join(ws.root, 'projects', 'README.md')), false);
  const { lanes } = await act(ws, 'tree', { surface: 'projects' });
  assert.deepEqual(lanes, []);
});
