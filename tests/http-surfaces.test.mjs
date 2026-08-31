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
