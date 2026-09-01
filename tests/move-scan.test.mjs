import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ControlStore } from '../src/store.mjs';
import { PluginHost } from '../src/plugin-host.mjs';
import { createAppServer } from '../src/http.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);

async function fixture({ dirs = 25, filesPerDir = 40 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-ops-scan-'));
  const root = path.join(dir, 'workspace');
  fs.mkdirSync(root);
  for (let d = 0; d < dirs; d++) {
    const sub = path.join(root, `dir-${d}`);
    fs.mkdirSync(sub);
    for (let f = 0; f < filesPerDir; f++) fs.writeFileSync(path.join(sub, `f-${f}.md`), `content ${d}-${f}\n`);
  }
  const tracked = path.join(root, 'tracked.md');
  fs.writeFileSync(tracked, '# tracked\n');
  const store = new ControlStore(path.join(dir, 'control.sqlite3'));
  store.addWorkspace(root, 'fixture');
  store.readFile(root, tracked);
  const plugins = new PluginHost({ store, pluginDir: path.join(here, '..', 'plugins', 'server') });
  await plugins.load();
  const server = createAppServer({ store, plugins, surface: 'owner' });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise(r => server.close(() => { store.close(); fs.rmSync(dir, { recursive:true, force:true }); r(); }));
  return { root, tracked, store, base, close };
}

const act = (base, action, payload) => fetch(`${base}/api/plugins/moves/action`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action, payload })
}).then(r => r.json());

test('server answers /api/tree and /api/file while a move scan runs', async () => {
  const f = await fixture();
  try {
    // Make the tracked file "missing" so the scan has real work to do.
    const moved = path.join(f.root, 'dir-0', 'tracked-moved.md');
    fs.renameSync(f.tracked, moved);
    const job = await act(f.base, 'scan-start', { rootPath: f.root, options: { yieldDelayMs: 15 } });
    assert.equal(job.state, 'running');

    const t0 = Date.now();
    const tree = await fetch(`${f.base}/api/tree?root=${encodeURIComponent(f.root)}&path=.`);
    const file = await fetch(`${f.base}/api/file?root=${encodeURIComponent(f.root)}&path=${encodeURIComponent(moved)}`);
    const elapsed = Date.now() - t0;
    assert.equal(tree.status, 200);
    assert.equal(file.status, 200);
    assert.ok(elapsed < 2000, `requests took ${elapsed}ms during scan`);

    const during = await act(f.base, 'scan-status', { jobId: job.jobId });
    assert.equal(during.state, 'running', 'scan should still be running when interleaved requests completed');

    // Wait for completion and check the proposal was found.
    let status = during;
    for (let i = 0; i < 200 && status.state === 'running'; i++) {
      await new Promise(r => setTimeout(r, 25));
      status = await act(f.base, 'scan-status', { jobId: job.jobId });
    }
    assert.equal(status.state, 'done');
    assert.equal(status.proposals.length, 1);
    assert.equal(status.proposals[0].toPath, moved);
  } finally { await f.close(); }
});

test('a running scan can be cancelled', async () => {
  const f = await fixture();
  try {
    fs.renameSync(f.tracked, path.join(f.root, 'gone.md'));
    const job = await act(f.base, 'scan-start', { rootPath: f.root, options: { yieldDelayMs: 30 } });
    const cancelled = await act(f.base, 'scan-cancel', { jobId: job.jobId });
    assert.ok(['running', 'cancelled'].includes(cancelled.state));
    let status = cancelled;
    for (let i = 0; i < 100 && status.state === 'running'; i++) {
      await new Promise(r => setTimeout(r, 20));
      status = await act(f.base, 'scan-status', { jobId: job.jobId });
    }
    assert.equal(status.state, 'cancelled');
  } finally { await f.close(); }
});

test('scan skips oversized files and reports it', async () => {
  const f = await fixture({ dirs: 1, filesPerDir: 2 });
  try {
    fs.renameSync(f.tracked, path.join(f.root, 'gone.md'));
    fs.writeFileSync(path.join(f.root, 'huge.bin'), Buffer.alloc(2048));
    const job = await act(f.base, 'scan-start', { rootPath: f.root, options: { maxFileBytes: 1024 } });
    let status = job;
    for (let i = 0; i < 100 && status.state === 'running'; i++) {
      await new Promise(r => setTimeout(r, 10));
      status = await act(f.base, 'scan-status', { jobId: job.jobId });
    }
    assert.equal(status.state, 'done');
    assert.ok(status.skippedLarge >= 1);
  } finally { await f.close(); }
});
