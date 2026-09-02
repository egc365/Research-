// One card view: four registered sources behind /contrib/card-view.js, each
// yielding the same card record. The board source needs a DOM and is proven
// by the Chromium probes; the other three load under Node with a stub ctx.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { contributions, defaultWiring, catalogRows } from '../plugins/registry.mjs';
import { open as openFolder } from '../public/contrib/sources/folder.js';
import { open as openBlocks } from '../public/contrib/sources/blocks.js';
import { open as openQueue } from '../public/contrib/sources/queue.js';

const ROOT = path.join(import.meta.dirname, '..');
const CARD_KEYS = ['id', 'kind', 'ref', 'path', 'head', 'title', 'body', 'text', 'color', 'face', 'icon',
  'fields', 'tags', 'image', 'width', 'missing', 'badges', 'foot'].sort();
const SOURCES = { 'board-view': 'board', 'whiteboard-view': 'board', 'folder-cards': 'folder', 'card-rail': 'blocks', 'candidate-list': 'queue' };

test('the five card ids are one entry with a source preset, and every catalog entry is a file', () => {
  for (const [id, view] of Object.entries(SOURCES)) {
    const c = contributions.find(x => x.id === id);
    assert.equal(c.entry, '/contrib/card-view.js', id);
    assert.equal(c.config.view, view, id);
    assert.ok(fs.existsSync(path.join(ROOT, 'public/contrib/sources', `${view}.js`)), `sources/${view}.js`);
  }
  for (const c of contributions) assert.ok(fs.existsSync(path.join(ROOT, 'public', c.entry.slice(1))), c.entry);
  for (const gone of ['board-view', 'folder-cards', 'card-rail', 'candidate-list']) {
    assert.equal(fs.existsSync(path.join(ROOT, 'public/contrib', `${gone}.js`)), false, `${gone}.js still exists`);
  }
});

test('the preset rides in manifest_json and never changes a wiring row key', () => {
  const rows = catalogRows([]);
  const presetOf = id => JSON.parse(rows.find(r => r.plugin_id === id).manifest_json).config;
  assert.deepEqual(presetOf('card-rail'), { view: 'blocks' });
  assert.equal(presetOf('filesystem-tree'), undefined);
  for (const slots of Object.values(defaultWiring)) {
    for (const entries of Object.values(slots)) {
      for (const entry of entries) {
        if (typeof entry === 'string' || !entry.config) continue;
        const preset = presetOf(entry.id) || {};
        for (const key of Object.keys(entry.config)) {
          if (key in preset) assert.equal(preset[key], entry.config[key], `${entry.id}.${key}`);
        }
      }
    }
  }
  const revisionSide = defaultWiring['revision-center'].side[0];
  assert.deepEqual(revisionSide, { id: 'card-rail', config: { source: 'transcript' } });
  assert.deepEqual({ ...presetOf('card-rail'), ...revisionSide.config }, { view: 'blocks', source: 'transcript' });
});

function stubCtx({ selection = null, card = null, request = {}, actions = {} } = {}) {
  const emitted = [];
  const calls = [];
  return {
    workspace: { root_path: '/ws' },
    selection, card,
    setCard(id) { calls.push(['setCard', id]); },
    selectFile: async p => { calls.push(['selectFile', p]); },
    async request(url) {
      const hit = Object.entries(request).find(([prefix]) => url.startsWith(prefix));
      if (!hit) throw new Error(`no stub for ${url}`);
      return hit[1];
    },
    async action(service, action, payload) {
      calls.push([service, action, payload]);
      const fn = actions[`${service}.${action}`];
      if (!fn) throw new Error(`no stub for ${service}.${action}`);
      return fn(payload);
    },
    bus: { on() {}, emit(event, msg) { emitted.push([event, msg]); } },
    emitted, calls
  };
}

test('folder source: one card per entry with labels and sticky, folders reveal, files select', async () => {
  const ctx = stubCtx({
    request: {
      '/api/tree?': [
        { name: 'plans', type: 'directory', path: '/ws/plans', relativePath: 'plans' },
        { name: 'README.md', type: 'file', path: '/ws/README.md', relativePath: 'README.md' }
      ],
      '/api/path-labels?': { '/ws/plans': [{ label: 'project', color: '#123' }] }
    },
    actions: {
      'stickies.list': () => ({ notes: { plans: { text: 'plans live here', color: '#ffb8b8' } } }),
      'stickies.set': p => p
    }
  });
  const source = openFolder(ctx, { path: '.' });
  const { groups } = await source.load();
  const [folder, file] = groups[0].cards;
  for (const c of groups[0].cards) assert.deepEqual(Object.keys(c).sort(), CARD_KEYS);
  assert.equal(folder.kind, 'folder');
  assert.equal(folder.text, 'plans live here');
  assert.equal(folder.color, '#ffb8b8');
  assert.deepEqual(folder.tags, [{ label: 'project', color: '#123' }]);
  assert.equal(file.kind, 'file');
  assert.equal(file.body, '', 'no preview read: a folder view registers nothing');
  assert.equal(file.title, 'README.md');
  await source.select(folder);
  assert.deepEqual(ctx.emitted.at(-1), ['reveal-path', { path: '/ws/plans' }]);
  await source.select(file);
  assert.deepEqual(ctx.calls.at(-1), ['selectFile', '/ws/README.md']);
  await source.text(file, 'read me', undefined);
  assert.deepEqual(ctx.calls.at(-1), ['stickies', 'set', { rootPath: '/ws', path: 'README.md', text: 'read me', color: '#f6e58d' }]);
});

test('blocks source: content-addressed block cards, decisions as badges, the open filter', async () => {
  const ctx = stubCtx({
    selection: { path: '/ws/doc.md', content: '# one\n\ntwo\n\nthree' },
    request: {
      '/api/decisions?': { latestByCard: {} },
      '/api/amendments?': { latestRevByCard: {}, entries: [] }
    }
  });
  const source = openBlocks(ctx, {});
  const first = await source.load();
  assert.equal(first.groups[0].cards.length, 3);
  for (const c of first.groups[0].cards) assert.deepEqual(Object.keys(c).sort(), CARD_KEYS);
  const card = first.groups[0].cards[0];
  assert.match(card.id, /^b1-[0-9a-f]{12}$/);
  assert.equal(card.kind, 'block');
  assert.equal(card.title, '#1 block');
  assert.deepEqual(card.badges, [{ text: 'open', cls: '' }]);
  assert.deepEqual(first.chips.map(c => c.id), ['all', 'open']);
  assert.equal(first.note, '3 of 3');
  ctx.request = async url => url.startsWith('/api/decisions')
    ? { latestByCard: { [card.id]: 'accept' } }
    : { latestRevByCard: { [card.id]: 2 }, entries: [{ card: card.id, rev: 2, body: 'amended', created_at: 't', sha256: 'abcdef0123456789', note: '' }] };
  const second = await source.load();
  assert.equal(second.groups[0].cards.length, 3);
  const refiltered = source.filter('open');
  assert.equal(refiltered.groups[0].cards.length, 2, 'a chip refilters the loaded rows without a reload');
  assert.equal(refiltered.note, '2 of 3');
  assert.deepEqual(refiltered.chips.map(c => c.active), [false, true]);
  source.filter('all');
  const third = await source.load();
  const decided = third.groups[0].cards[0];
  assert.equal(decided.title, '#1 block · rev 2');
  assert.deepEqual(decided.badges, [{ text: 'accept', cls: 'validated' }]);
  assert.equal(decided.body, 'amended');
  assert.deepEqual(decided.foot, ['revision log, append only', 'rev 2 · t · abcdef012345']);
  source.select(decided);
  assert.deepEqual(ctx.calls.at(-1), ['setCard', card.id]);
  assert.deepEqual(ctx.emitted.at(-1), ['card-text', { card: card.id, text: 'amended', original: '# one' }]);
});

test('blocks source with source transcript: owner and agent cards, the goto link', async () => {
  const ctx = stubCtx({
    selection: { path: '/ws/doc.md', content: '' },
    request: { '/api/decisions?': { latestByCard: {} }, '/api/amendments?': { latestRevByCard: {}, entries: [] } },
    actions: {
      'revision.sessions': () => ({ sessions: [{ session: 's1' }] }),
      'revision.cards': () => ({ cards: [
        { card: 'c1', kind: 'user', n: 1, text: 'do it', line: 4, ts: '2026', sha256: 'aa', tags: ['ask'], wrote: false },
        { card: 'c2', kind: 'write', n: 2, text: 'did it', line: 9, ts: '2026', sha256: 'bb', tags: [], wrote: true }
      ] })
    }
  });
  const source = openBlocks(ctx, { source: 'transcript' });
  const { groups, chips } = await source.load();
  assert.deepEqual(chips.map(c => c.id), ['all', 'owner', 'agent', 'wrote', 'open']);
  const [owner, agent] = groups[0].cards;
  assert.equal(owner.icon, 'O');
  assert.equal(agent.icon, 'A');
  assert.deepEqual(owner.tags, [{ label: 'ask', color: null }]);
  assert.equal(owner.foot[0], 'line 4 · 2026 · sha aa');
  owner.foot[1].act();
  assert.deepEqual(ctx.emitted.at(-1), ['goto-event', { n: 1 }]);
  source.filter('wrote');
  assert.deepEqual((await source.load()).groups[0].cards.map(c => c.id), ['c2']);
});

test('queue source: groups by lifecycle state in order, drift badge, selection mark', async () => {
  const ctx = stubCtx({
    selection: { path: '/ws/b.md' },
    actions: {
      'registry.list': () => [
        { path: '/ws/a.md', state: 'validated', checksum: 'a'.repeat(64), promoted_checksum: null, last_run_id: 'r1', last_span_id: null, updated_at: 'u1' },
        { path: '/ws/b.md', state: 'candidate', checksum: 'b'.repeat(64), promoted_checksum: 'c'.repeat(64), last_run_id: null, last_span_id: 'sp', updated_at: 'u2' }
      ],
      'stickies.list': () => ({ notes: {} })
    }
  });
  const source = openQueue(ctx, {});
  const { groups } = await source.load();
  assert.deepEqual(groups.map(g => g.title), ['candidate · 1', 'validated · 1', 'working · 0', 'promoted · 0', 'superseded · 0', 'archived · 0']);
  const b = groups[0].cards[0];
  assert.deepEqual(Object.keys(b).sort(), CARD_KEYS);
  assert.equal(b.id, '/ws/b.md');
  assert.equal(b.ref, 'b.md');
  assert.deepEqual(b.badges, [{ text: 'drifted', cls: 'working' }]);
  assert.deepEqual(b.fields, [{ label: 'sha', value: 'bbbbbbbbbbbb' }, { label: 'promoted', value: 'cccccccccccc' }, { label: 'span', value: 'sp' }]);
  assert.equal(source.selected(), '/ws/b.md');
  await source.select(groups[1].cards[0]);
  assert.deepEqual(ctx.calls.at(-1), ['selectFile', '/ws/a.md']);
});
