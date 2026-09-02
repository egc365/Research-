import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ControlStore } from '../src/store.mjs';
import { PluginHost } from '../src/plugin-host.mjs';
import { createAppServer } from '../src/http.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-ops-http-'));
  const root = path.join(dir, 'workspace');
  fs.mkdirSync(path.join(root, 'research'), { recursive: true });
  const file = path.join(root, 'research', 'test.md');
  fs.writeFileSync(file, '# acceptance\n', 'utf8');
  const store = new ControlStore(path.join(dir, 'control.sqlite3'));
  store.addWorkspace(root, 'fixture');
  const plugins = new PluginHost({ store, pluginDir: path.join(here, '..', 'plugins', 'server') });
  await plugins.load();
  const owner = createAppServer({ store, plugins, surface: 'owner' });
  const agent = createAppServer({ store, plugins, surface: 'agent' });
  await new Promise(r => owner.listen(0, '127.0.0.1', r));
  await new Promise(r => agent.listen(0, '127.0.0.1', r));
  const ownerBase = `http://127.0.0.1:${owner.address().port}`;
  const agentBase = `http://127.0.0.1:${agent.address().port}`;
  const close = () => new Promise(r => owner.close(() => agent.close(() => { store.close(); fs.rmSync(dir, { recursive:true, force:true }); r(); })));
  return { root, file, store, ownerBase, agentBase, close };
}

const call = (base, method, pathName, body) => fetch(base + pathName, {
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body)
});

const transition = (base, payload) => call(base, 'POST', '/api/plugins/governance/action', { action: 'transition', payload });

test('acceptance: agent works the file up, only the owner surface can promote', async () => {
  const f = await fixture();
  try {
    // Agent edits the file through the agent surface.
    const opened = await (await fetch(`${f.agentBase}/api/file?root=${encodeURIComponent(f.root)}&path=${encodeURIComponent(f.file)}`)).json();
    assert.equal(opened.artifact.state, 'working');
    const written = await (await call(f.agentBase, 'PUT', '/api/file', {
      rootPath: f.root, path: f.file, content: '# acceptance v2\n',
      expectedChecksum: opened.checksum, actor: 'human', runId: 'run-1844', spanId: 'span-1844.12'
    })).json();
    assert.equal(written.artifact.state, 'working');

    // The agent surface recorded the write as agent no matter what it claimed.
    const writeEvent = f.store.history(f.file).find(e => e.event_type === 'WRITE');
    assert.equal(writeEvent.actor, 'agent');

    // working -> candidate -> validated from the agent surface.
    assert.equal((await transition(f.agentBase, { path: f.file, toState: 'candidate', runId: 'run-1844' })).status, 200);
    assert.equal((await transition(f.agentBase, { path: f.file, toState: 'validated', runId: 'run-1844' })).status, 200);

    // Promotion from the agent surface is refused even claiming actor=human.
    const refused = await transition(f.agentBase, { path: f.file, toState: 'promoted', actor: 'human' });
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).error, 'PROMOTION_REQUIRES_HUMAN_APPROVAL');

    // The owner surface promotes.
    const promoted = await transition(f.ownerBase, { path: f.file, toState: 'promoted', actor: 'human' });
    assert.equal(promoted.status, 200);
    assert.equal((await promoted.json()).state, 'promoted');

    // Complete transition history with run binding survives in the event log.
    const states = f.store.history(f.file).filter(e => e.event_type === 'STATE_TRANSITION').map(e => e.to_state).reverse();
    assert.deepEqual(states, ['candidate', 'validated', 'promoted']);
  } finally { await f.close(); }
});

test('agent surface cannot register workspaces', async () => {
  const f = await fixture();
  try {
    const res = await call(f.agentBase, 'POST', '/api/workspaces', { rootPath: f.root });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'OWNER_SURFACE_ONLY');
  } finally { await f.close(); }
});

test('agent surface cannot change validation policy', async () => {
  const f = await fixture();
  try {
    const add = await call(f.agentBase, 'POST', '/api/plugins/preflight/action', {
      action: 'add', payload: { scopePath: f.root, ruleType: 'forbid_text', rule: { text: 'x' } }
    });
    assert.equal(add.status, 403);
    assert.equal((await add.json()).error, 'OWNER_SURFACE_ONLY');
    const toggle = await call(f.agentBase, 'POST', '/api/plugins/preflight/action', {
      action: 'toggle', payload: { ruleId: 1, enabled: false }
    });
    assert.equal(toggle.status, 403);
    // list stays readable, and the owner surface can still add rules.
    assert.equal((await call(f.agentBase, 'POST', '/api/plugins/preflight/action', { action: 'list', payload: {} })).status, 200);
    assert.equal((await call(f.ownerBase, 'POST', '/api/plugins/preflight/action', {
      action: 'add', payload: { scopePath: f.root, ruleType: 'forbid_text', rule: { text: 'TODO-forbidden' } }
    })).status, 200);
  } finally { await f.close(); }
});

test('agent surface serves no UI', async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(`${f.agentBase}/`)).status, 404);
    assert.equal((await fetch(`${f.ownerBase}/`)).status, 200);
  } finally { await f.close(); }
});

// ---- composable-ui-v1: composition, amendments and decisions keep the same
// ---- surface discipline as promotion — owner-only writes are structural.

test('composition writes are unreachable from the agent surface', async () => {
  const f = await fixture();
  try {
    const { catalogRows, defaultWiring } = await import('../plugins/registry.mjs');
    f.store.syncCatalog(catalogRows([]));
    f.store.seedStationWiring(defaultWiring);

    for (const [pathName, body] of [
      ['/api/composition/workspace', { rootPath: f.root, pluginId: 'dashboard-viewer' }],
      ['/api/composition/station', { stationId: 'dashboard-viewer', slotName: 'main', contributionId: 'card-rail' }],
      ['/api/composition/station/move', { stationId: 'revision-center', contributionId: 'dual-document-view', fromSlot: 'main', toSlot: 'side' }]
    ]) {
      const denied = await call(f.agentBase, 'POST', pathName, body);
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).error, 'OWNER_SURFACE_ONLY');
    }
    // Nothing was enabled or rewired by the refused calls.
    assert.equal(f.store.composition(f.root).enabled.length, 0);
    assert.deepEqual(f.store.stationContributions('dashboard-viewer').map(r => r.contribution_id), ['board-view', 'apps-widget']);
    assert.equal(
      f.store.stationContributions('revision-center').find(r => r.contribution_id === 'dual-document-view').slot_name,
      'main'
    );

    // The owner surface can do both, and reading composition works on both surfaces.
    assert.equal((await call(f.ownerBase, 'POST', '/api/composition/workspace', { rootPath: f.root, pluginId: 'dashboard-viewer' })).status, 200);
    const seenByAgent = await (await fetch(`${f.agentBase}/api/composition?root=${encodeURIComponent(f.root)}`)).json();
    assert.equal(seenByAgent.enabled.length, 1);
    const moved = await call(f.ownerBase, 'POST', '/api/composition/station/move', {
      stationId: 'revision-center', contributionId: 'dual-document-view', fromSlot: 'main', toSlot: 'side',
      beforeContributionId: 'card-rail'
    });
    assert.equal(moved.status, 200);
    assert.equal(
      f.store.stationContributions('revision-center').find(r => r.contribution_id === 'dual-document-view').slot_name,
      'side'
    );
  } finally { await f.close(); }
});

test('agents may propose amendments (stamped agent); decisions are owner-only', async () => {
  const f = await fixture();
  try {
    const proposed = await call(f.agentBase, 'POST', '/api/amendments', {
      path: f.file, card: 'block-1', body: 'proposed rewording', actor: 'human' // claim is ignored
    });
    assert.equal(proposed.status, 201);
    assert.equal((await proposed.json()).actor, 'agent');

    const denied = await call(f.agentBase, 'POST', '/api/decision', { path: f.file, card: 'block-1', decision: 'accept' });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error, 'OWNER_SURFACE_ONLY');
    assert.equal(f.store.listDecisions(f.file).entries.length, 0);

    const recorded = await call(f.ownerBase, 'POST', '/api/decision', { path: f.file, card: 'block-1', decision: 'accept' });
    assert.equal(recorded.status, 200);
    assert.deepEqual((await recorded.json()).latestByCard, { 'block-1': 'accept' });
  } finally { await f.close(); }
});

test('label writes are owner-only; mkdir works on both surfaces with the actor stamped', async () => {
  const f = await fixture();
  try {
    for (const [pathName, body] of [
      ['/api/labels', { name: 'evidence' }],
      ['/api/path-labels', { rootPath: f.root, path: f.file, label: 'evidence' }]
    ]) {
      const denied = await call(f.agentBase, 'POST', pathName, body);
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).error, 'OWNER_SURFACE_ONLY');
    }
    assert.equal(f.store.listLabels().length, 0);

    assert.equal((await call(f.ownerBase, 'POST', '/api/labels', { name: 'evidence', color: '#4fc08d' })).status, 200);
    assert.equal((await call(f.ownerBase, 'POST', '/api/path-labels', { rootPath: f.root, path: f.file, label: 'evidence' })).status, 200);
    const seen = await (await fetch(`${f.agentBase}/api/path-labels?root=${encodeURIComponent(f.root)}`)).json();
    assert.deepEqual(seen[f.file].map(a => a.label), ['evidence']); // agents read designations

    const made = await call(f.agentBase, 'POST', '/api/fs/mkdir', { rootPath: f.root, path: `${f.root}/agent-made`, actor: 'human' });
    assert.equal(made.status, 201);
    const event = f.store.history(`${f.root}/agent-made`)[0];
    assert.equal(event.event_type, 'MKDIR');
    assert.equal(event.actor, 'agent'); // the claim was overridden at the boundary
  } finally { await f.close(); }
});

test('moves are governed on both surfaces with the actor stamped', async () => {
  const f = await fixture();
  try {
    fs.mkdirSync(path.join(f.root, 'shelf'));
    const to = path.join(f.root, 'shelf', 'test.md');
    const moved = await call(f.agentBase, 'POST', '/api/fs/move', { rootPath: f.root, from: f.file, to, actor: 'human' });
    assert.equal(moved.status, 200);
    const event = f.store.history(to).find(e => e.event_type === 'MOVE');
    assert.equal(event.actor, 'agent'); // the surface overrides the claimed identity
    const escape = await call(f.ownerBase, 'POST', '/api/fs/move', { rootPath: f.root, from: to, to: '/etc/escape' });
    assert.equal(escape.status, 400);
  } finally { await f.close(); }
});

test('workspace creation with create:true builds the folder, owner surface only', async () => {
  const f = await fixture();
  try {
    const fresh = path.join(f.root, '..', 'made-by-ui');
    const denied = await call(f.agentBase, 'POST', '/api/workspaces', { rootPath: fresh, create: true });
    assert.equal(denied.status, 403);
    assert.ok(!fs.existsSync(fresh));
    const made = await call(f.ownerBase, 'POST', '/api/workspaces', { rootPath: fresh, label: 'made', create: true });
    assert.equal(made.status, 201);
    assert.ok(fs.statSync(fresh).isDirectory());
    // fresh workspace = bare composition profile
    const composition = await (await fetch(`${f.ownerBase}/api/composition?root=${encodeURIComponent(fresh)}`)).json();
    assert.deepEqual(composition.enabled, []);
  } finally { await f.close(); }
});

test('station definition is owner-surface only', async () => {
  const f = await fixture();
  try {
    const denied = await call(f.agentBase, 'POST', '/api/stations', { id: 'agent-station', label: 'Nope' });
    assert.equal(denied.status, 403);
    const made = await call(f.ownerBase, 'POST', '/api/stations', { id: 'owner-station', label: 'Mine', layout: 'main' });
    assert.equal(made.status, 201);
  } finally { await f.close(); }
});

test('trash (delete) is owner-surface only', async () => {
  const f = await fixture();
  try {
    const denied = await call(f.agentBase, 'POST', '/api/fs/delete', { rootPath: f.root, path: f.file });
    assert.equal(denied.status, 403);
    assert.ok(fs.existsSync(f.file));
    const gone = await call(f.ownerBase, 'POST', '/api/fs/delete', { rootPath: f.root, path: f.file });
    assert.equal(gone.status, 200);
    const body = await gone.json();
    assert.ok(!fs.existsSync(f.file) && fs.existsSync(body.path));
  } finally { await f.close(); }
});
