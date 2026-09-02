import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ControlStore } from '../src/store.mjs';
import { PluginHost } from '../src/plugin-host.mjs';
import { createAppServer } from '../src/http.mjs';
import { catalogRows, defaultWiring, wiringAdditions, contributions } from '../plugins/registry.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);

function storeFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-ops-inbox-'));
  const root = path.join(dir, 'workspace');
  fs.mkdirSync(path.join(root, 'outputs'), { recursive: true });
  const report = path.join(root, 'outputs', 'report.md');
  const draft = path.join(root, 'outputs', 'draft.md');
  fs.writeFileSync(report, '# report\n', 'utf8');
  fs.writeFileSync(draft, '# draft\n', 'utf8');
  const store = new ControlStore(path.join(dir, 'control.sqlite3'));
  store.addWorkspace(root, 'DEMO');
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, root, report, draft, store };
}

async function httpFixture(t) {
  const { dir, root, report, draft, store } = storeFixture(t);
  const plugins = new PluginHost({ store, pluginDir: path.join(here, '..', 'plugins', 'server') });
  await plugins.load();
  const owner = createAppServer({ store, plugins, surface: 'owner' });
  await new Promise(r => owner.listen(0, '127.0.0.1', r));
  const ownerBase = `http://127.0.0.1:${owner.address().port}`;
  t.after(() => new Promise(r => owner.close(() => r())));
  return { dir, root, report, draft, store, ownerBase };
}

test('inbox count endpoint is 0 then 1 after a candidate (red before the change)', async t => {
  const f = await httpFixture(t);
  const counted = await fetch(`${f.ownerBase}/api/inbox/count`);
  assert.equal(counted.status, 200);
  assert.equal((await counted.json()).count, 0);

  f.store.readFile(f.root, f.report);
  f.store.transition({ filePath: f.report, toState: 'candidate', actor: 'human' });

  const after = await (await fetch(`${f.ownerBase}/api/inbox/count`)).json();
  assert.equal(after.count, 1);

  const scoped = await (await fetch(`${f.ownerBase}/api/inbox/count?root=${encodeURIComponent(f.root)}`)).json();
  assert.equal(scoped.count, 1);
});

test('verdict query lists candidate and validated only, grouped by workspace', t => {
  const f = storeFixture(t);
  f.store.readFile(f.root, f.report);
  f.store.readFile(f.root, f.draft);
  f.store.transition({ filePath: f.report, toState: 'candidate', actor: 'human' });
  assert.equal(f.store.verdictCount(), 1);
  f.store.transition({ filePath: f.report, toState: 'validated', actor: 'human', metadata: { validation: { ok: true } } });
  f.store.transition({ filePath: f.draft, toState: 'candidate', actor: 'human' });
  assert.equal(f.store.verdictCount(f.root), 2);
  const rows = f.store.listVerdicts();
  assert.deepEqual(rows.map(r => r.state).sort(), ['candidate', 'validated']);
  assert.ok(rows.every(r => r.workspace_label === 'DEMO'));
  assert.ok(rows.every(r => r.workspace_root === f.root));
});

test('watch folder lists files that are not yet registered', t => {
  const f = storeFixture(t);
  assert.deepEqual(f.store.listUnregisteredWatch(f.root, null), []);
  assert.deepEqual(f.store.listUnregisteredWatch(f.root, ''), []);
  const unseen = f.store.listUnregisteredWatch(f.root, 'outputs');
  assert.equal(unseen.length, 2);
  assert.ok(unseen.every(row => row.relativePath.startsWith('outputs/')));
  f.store.readFile(f.root, f.report);
  const leftover = f.store.listUnregisteredWatch(f.root, 'outputs');
  assert.equal(leftover.length, 1);
  assert.equal(leftover[0].relativePath, 'outputs/draft.md');
});

test('watch folder lists files two levels deep, never deeper', t => {
  const f = storeFixture(t);
  const notes = path.join(f.root, 'outputs', 'notes.md');
  const nested = path.join(f.root, 'outputs', 'paper-1', 'draft.md');
  const tooDeep = path.join(f.root, 'outputs', 'paper-1', 'sub', 'hidden.md');
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  fs.mkdirSync(path.dirname(tooDeep), { recursive: true });
  fs.writeFileSync(notes, '# notes\n', 'utf8');
  fs.writeFileSync(nested, '# nested\n', 'utf8');
  fs.writeFileSync(tooDeep, '# hidden\n', 'utf8');
  const rels = f.store.listUnregisteredWatch(f.root, 'outputs').map(row => row.relativePath).sort();
  assert.deepEqual(rels, [
    'outputs/draft.md',
    'outputs/notes.md',
    'outputs/paper-1/draft.md',
    'outputs/report.md'
  ]);
  f.store.readFile(f.root, nested);
  const leftover = f.store.listUnregisteredWatch(f.root, 'outputs').map(row => row.relativePath).sort();
  assert.ok(!leftover.includes('outputs/paper-1/draft.md'));
  assert.ok(!leftover.includes('outputs/paper-1/sub/hidden.md'));
  assert.ok(leftover.includes('outputs/notes.md'));
});

test('GET /api/inbox returns verdicts and unregistered watch files', async t => {
  const f = await httpFixture(t);
  f.store.readFile(f.root, f.report);
  f.store.transition({ filePath: f.report, toState: 'candidate', actor: 'human' });
  const emptyWatch = await (await fetch(`${f.ownerBase}/api/inbox?root=${encodeURIComponent(f.root)}`)).json();
  assert.equal(emptyWatch.verdicts.length, 1);
  assert.equal(emptyWatch.unregistered.length, 0);
  const watched = await (await fetch(
    `${f.ownerBase}/api/inbox?root=${encodeURIComponent(f.root)}&watch=outputs`
  )).json();
  assert.equal(watched.verdicts[0].state, 'candidate');
  assert.equal(watched.unregistered.length, 1);
  assert.equal(watched.unregistered[0].relativePath, 'outputs/draft.md');
});

test('activity-view is catalogued and seeds on provenance after the timeline', t => {
  const activity = contributions.find(c => c.id === 'activity-view');
  assert.ok(activity);
  assert.equal(activity.entry, '/contrib/activity.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-ops-inbox-wire-'));
  const store = new ControlStore(path.join(dir, 'control.sqlite3'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  store.syncCatalog(catalogRows([]));
  store.seedStationWiring(defaultWiring);
  assert.deepEqual(
    store.stationContributions('provenance-viewer').map(r => r.contribution_id),
    ['revision-timeline', 'activity-view', 'actor-filter', 'provenance-block']
  );
  const addition = wiringAdditions.find(r => r.id === '20260902-activity-on-provenance');
  assert.ok(addition);
  assert.equal(addition.stationId, 'provenance-viewer');
  assert.equal(addition.slotName, 'main');
  assert.equal(addition.contributionId, 'activity-view');
  store.db.prepare("DELETE FROM station_contributions WHERE station_id='provenance-viewer'").run();
  store.setStationContribution({
    stationId: 'provenance-viewer', slotName: 'main', contributionId: 'revision-timeline', sortOrder: 10
  });
  store.applyWiringAdditions(wiringAdditions);
  const wired = store.stationContributions('provenance-viewer').map(r => r.contribution_id);
  assert.ok(wired.includes('activity-view'));
});
