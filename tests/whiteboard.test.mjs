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

function sketchModel() {
  return {
    groups: [
      {
        title: 'plans',
        orientation: 'vertical',
        cards: [
          { kind: 'file', ref: 'README.md', title: 'README.md', body: 'the name given' },
          { kind: 'note', ref: 'first words', title: 'first words' },
          { kind: 'image', ref: DATA_URL, title: 'sketch.png' }
        ],
        groups: []
      },
      {
        title: 'q3',
        orientation: 'vertical',
        cards: [{ kind: 'note', ref: 'notes', title: 'notes' }],
        groups: []
      }
    ],
    cards: []
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

test('in-memory model round-trips through its serializer', () => {
  const model = emptyModel();
  model.groups.push({
    group_id: 1, parent_id: null, title: 'plans', orientation: 'vertical',
    sort_order: 100, folder_path: null, color: null, face: 'sticky', icon: 'folder',
    fields_json: '[]', created_at: '2026-09-02T00:00:00.000Z'
  });
  model.cards.push(
    {
      card_id: 1, group_id: 1, kind: 'file', ref: 'README.md', title: 'README.md',
      body: 'the name given', color: null, face: 'card', icon: 'file',
      fields_json: '[]', sort_order: 100, created_at: '2026-09-02T00:00:00.000Z'
    },
    {
      card_id: 2, group_id: 1, kind: 'note', ref: 'first words', title: 'first words',
      color: null, face: 'card', icon: 'note', fields_json: '[]', sort_order: 110,
      created_at: '2026-09-02T00:00:00.000Z'
    },
    {
      card_id: 3, group_id: 1, kind: 'image', ref: DATA_URL, title: 'sketch.png',
      color: null, face: 'card', icon: 'image', fields_json: '[]', sort_order: 120,
      width: 180, created_at: '2026-09-02T00:00:00.000Z'
    }
  );
  model.nextGroup = 2;
  model.nextCard = 4;
  const back = parseModel(serializeModel(model));
  assert.equal(back.groups[0].title, 'plans');
  assert.equal(back.cards[0].kind, 'file');
  assert.equal(back.cards[0].body, 'the name given');
  assert.equal(back.cards[1].ref, 'first words');
  assert.equal(back.cards[2].kind, 'image');
  assert.equal(back.cards[2].ref, DATA_URL);
  assert.equal(back.cards[2].width, 180);
  assert.equal(back.nextGroup, 2);
  assert.equal(back.nextCard, 4);
  assert.deepEqual(parseModel(serializeModel(emptyModel())), emptyModel());
});

test('whiteboard store never calls the board service or the filesystem', async t => {
  const ws = workspace(t);
  const bag = new Map();
  const prev = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: k => bag.get(k) ?? null,
    setItem: (k, v) => bag.set(k, v),
    removeItem: k => bag.delete(k)
  };
  t.after(() => { globalThis.localStorage = prev; });
  const ctx = {
    workspace: { root_path: ws.root },
    action() { throw new Error('board service should not be called'); }
  };
  const access = boardStore(ctx, { mode: 'whiteboard' });
  const plans = await access.call('add-card', { kind: 'folder', name: 'plans' });
  await access.call('add-card', { groupId: plans.group_id, kind: 'note', ref: 'first words' });
  await access.call('add-card', { groupId: plans.group_id, kind: 'image', ref: DATA_URL, title: 'sketch.png' });
  const tree = await access.call('tree');
  assert.equal(tree.groups[0].title, 'plans');
  assert.equal(tree.groups[0].cards[1].kind, 'image');
  assert.equal(fs.existsSync(path.join(ws.root, 'plans')), false);
  assert.equal(fs.existsSync(path.join(ws.root, '.research-ops', 'board.sqlite3')), false);
  const stored = parseModel(bag.get(`ro.whiteboard.${ws.root}`));
  assert.equal(stored.groups[0].title, 'plans');
});

test('Save writes the tree and binds rows', async t => {
  const ws = workspace(t);
  const saved = await act(ws, 'save-to-project', {
    destination: 'projects',
    name: 'Q3 plan',
    model: sketchModel()
  });
  assert.equal(saved.label, 'Q3 plan');
  assert.equal(saved.destination, 'projects');
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
  assert.deepEqual(found, [
    'plans',
    'plans/README.md',
    'plans/first-words.md',
    'plans/sketch.png',
    'q3',
    'q3/notes.md'
  ]);
  assert.equal(fs.readFileSync(path.join(dest, 'plans', 'README.md'), 'utf8'), 'the name given\n');
  assert.equal(fs.readFileSync(path.join(dest, 'plans', 'first-words.md'), 'utf8'), 'first words\n');
  assert.equal(fs.readFileSync(path.join(dest, 'q3', 'notes.md'), 'utf8'), 'notes\n');
  assert.equal(fs.readFileSync(path.join(dest, 'plans', 'sketch.png')).equals(PNG), true);
  const { groups } = await act(ws, 'tree');
  assert.deepEqual(groups.map(g => g.title).sort(), ['plans', 'q3']);
  const plans = groups.find(g => g.title === 'plans');
  assert.equal(plans.folder_path, 'projects/plans');
  const byRef = Object.fromEntries(plans.cards.map(c => [path.basename(c.ref), c]));
  assert.equal(byRef['README.md'].kind, 'file');
  assert.equal(byRef['README.md'].ref, 'projects/plans/README.md');
  assert.equal(byRef['first-words.md'].kind, 'file');
  assert.equal(byRef['sketch.png'].kind, 'file');
  assert.equal(byRef['sketch.png'].ref, 'projects/plans/sketch.png');
  const q3 = groups.find(g => g.title === 'q3');
  assert.equal(q3.folder_path, 'projects/q3');
  assert.equal(q3.cards[0].ref, 'projects/q3/notes.md');
  assert.ok(ws.store.getArtifact(path.join(dest, 'plans', 'README.md')));
  assert.ok(ws.store.getArtifact(path.join(dest, 'plans', 'sketch.png')));
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
  assert.equal(fs.existsSync(path.join(ws.root, 'projects', 'plans')), false);
  const { groups } = await act(ws, 'tree');
  assert.deepEqual(groups, []);
});
