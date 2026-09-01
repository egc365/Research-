import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ControlStore } from '../src/store.mjs';
import { PluginHost } from '../src/plugin-host.mjs';

// Point the adapter at a dead port: transcript answers must degrade to empty
// lists with a note, never a thrown error — the suite runs without :8880.
process.env.REVISION_CENTER_BASE = 'http://127.0.0.1:1';

const here = path.dirname(new URL(import.meta.url).pathname);

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-ops-revision-'));
  const ws = path.join(dir, 'workspace'); fs.mkdirSync(ws);
  const store = new ControlStore(path.join(dir, 'control.sqlite3'));
  store.addWorkspace(ws);
  const plugins = new PluginHost({ store, pluginDir: path.join(here, '..', 'plugins', 'server') });
  await plugins.load();
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, plugins, ws, dir };
}

test('revision open: git HEAD is the base for a tracked file', async t => {
  const { plugins, dir } = await fixture(t);
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  const run = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  run(['init', '-q']);
  const doc = path.join(repo, 'doc.md');
  fs.writeFileSync(doc, '# one\n\ncommitted text\n');
  run(['add', 'doc.md']); run(['commit', '-qm', 'base']);
  fs.writeFileSync(doc, '# one\n\nworking text\n');
  const opened = await plugins.action('revision', 'open', { path: doc });
  assert.equal(opened.supported, true);
  assert.equal(opened.hasBase, true);
  assert.match(opened.base.from, /git HEAD/);
  assert.match(opened.base.text, /committed text/);
  assert.match(opened.working.text, /working text/);
});

test('revision open: promoted bytes are the base outside git; candidate wins the working side', async t => {
  const { store, plugins, ws } = await fixture(t);
  const doc = path.join(ws, 'notes.md');
  store.writeFile({ rootPath: ws, filePath: doc, content: 'v1\n', actor: 'human' });
  store.transition({ rootPath: ws, filePath: doc, toState: 'candidate', actor: 'human' });
  store.transition({ rootPath: ws, filePath: doc, toState: 'validated', actor: 'human', metadata: { validation: { ok: true } } });
  store.transition({ rootPath: ws, filePath: doc, toState: 'promoted', actor: 'human' });
  fs.writeFileSync(doc + '.candidate', 'v2 proposed\n');
  const opened = await plugins.action('revision', 'open', { path: doc, rootPath: ws });
  assert.equal(opened.hasBase, true);
  assert.match(opened.base.from, /promoted version/);
  assert.equal(opened.base.text, 'v1\n');
  assert.equal(opened.working.text, 'v2 proposed\n');
  assert.match(opened.working.from, /candidate/);
});

test('revision open: unsupported and missing files answer honestly', async t => {
  const { plugins, ws } = await fixture(t);
  const binary = path.join(ws, 'blob.bin');
  fs.writeFileSync(binary, Buffer.from([0xff, 0xfe, 0x00, 0x81, 0x99]));
  const openedBinary = await plugins.action('revision', 'open', { path: binary });
  assert.equal(openedBinary.supported, false);
  assert.match(openedBinary.note, /not UTF-8/);
  const openedGhost = await plugins.action('revision', 'open', { path: path.join(ws, 'ghost.md') });
  assert.equal(openedGhost.supported, false);
  assert.match(openedGhost.note, /does not exist/);
});

test('revision transcript actions degrade to empty answers when :8880 is unreachable', async t => {
  const { plugins, ws } = await fixture(t);
  const doc = path.join(ws, 'a.md'); fs.writeFileSync(doc, 'x\n');
  const sessions = await plugins.action('revision', 'sessions', { path: doc });
  assert.deepEqual(sessions.sessions, []);
  assert.match(sessions.note, /not reachable/);
  const cards = await plugins.action('revision', 'cards', { session: 'nope', path: doc });
  assert.deepEqual(cards.cards, []);
  const events = await plugins.action('revision', 'events', { session: 'nope', path: doc });
  assert.deepEqual(events.events, []);
});

test('seedStationWiring writes per-station config for shared contributions', async t => {
  const { store } = await fixture(t);
  const { catalogRows, defaultWiring } = await import('../plugins/registry.mjs');
  store.syncCatalog(catalogRows([]));
  store.seedStationWiring(defaultWiring);
  const side = store.stationContributions('revision-center').filter(r => r.slot_name === 'side');
  const rail = side.find(r => r.contribution_id === 'card-rail');
  assert.equal(rail.config.source, 'transcript');
  assert.ok(side.some(r => r.contribution_id === 'decision-controls'));
});
