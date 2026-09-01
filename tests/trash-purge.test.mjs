import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ControlStore } from '../src/store.mjs';
import { PluginHost } from '../src/plugin-host.mjs';
import { createAppServer } from '../src/http.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);

function storeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-ops-purge-'));
  const root = path.join(dir, 'workspace');
  fs.mkdirSync(root, { recursive: true });
  const store = new ControlStore(path.join(dir, 'control.sqlite3'));
  store.addWorkspace(root, 'fixture');
  const close = () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { dir, root, store, close };
}

function rowCount(store, table, p) {
  return store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE path=? OR path LIKE ? || '/%'`).get(p, p).n;
}

test('purgeTrashEntry removes bytes and rows and appends a PURGE event', () => {
  const f = storeFixture();
  try {
    // A directory with registered content: writeFile registers, assignLabel labels.
    const dirPath = path.join(f.root, 'notes');
    const filePath = path.join(dirPath, 'a.md');
    f.store.writeFile({ rootPath: f.root, filePath, content: '# a\n' });
    f.store.defineLabel({ name: 'keep' });
    f.store.assignLabel({ rootPath: f.root, filePath, label: 'keep' });

    const trashed = f.store.deleteEntry({ rootPath: f.root, filePath: dirPath });
    assert.equal(fs.existsSync(trashed.path), true);
    assert.ok(rowCount(f.store, 'artifact_registry', trashed.path) > 0);
    assert.ok(rowCount(f.store, 'path_labels', trashed.path) > 0);

    const result = f.store.purgeTrashEntry({ rootPath: f.root, trashPath: trashed.path });
    assert.deepEqual(result, { purged: true, path: trashed.path });

    // Bytes gone.
    assert.equal(fs.existsSync(trashed.path), false);
    // Rows for the path and everything under it gone from every path-keyed table.
    for (const table of ['artifact_registry', 'path_labels', 'amendments', 'artifact_versions']) {
      assert.equal(rowCount(f.store, table, trashed.path), 0, table + ' still has rows');
    }
    // The ledger keeps history: PURGE event with permanent:true.
    const purge = f.store.db.prepare(
      "SELECT * FROM artifact_events WHERE path=? AND event_type='PURGE'"
    ).get(trashed.path);
    assert.ok(purge, 'no PURGE event appended');
    assert.equal(JSON.parse(purge.metadata_json).permanent, true);
  } finally { f.close(); }
});

test('emptyTrash purges every trash entry', () => {
  const f = storeFixture();
  try {
    for (const name of ['one.md', 'two.md', 'three.md']) {
      const p = path.join(f.root, name);
      fs.writeFileSync(p, name + '\n', 'utf8');
      f.store.deleteEntry({ rootPath: f.root, filePath: p });
    }
    assert.equal(f.store.listTrash(f.root).length, 3);
    const result = f.store.emptyTrash({ rootPath: f.root });
    assert.equal(result.purged, 3);
    assert.equal(f.store.listTrash(f.root).length, 0);
    // Empty again is a no-op, not an error.
    assert.equal(f.store.emptyTrash({ rootPath: f.root }).purged, 0);
  } finally { f.close(); }
});

test('purging a path outside the trash dir throws and touches nothing', () => {
  const f = storeFixture();
  try {
    const p = path.join(f.root, 'live.md');
    fs.writeFileSync(p, 'live\n', 'utf8');
    assert.throws(() => f.store.purgeTrashEntry({ rootPath: f.root, trashPath: p }), /trash/i);
    assert.equal(fs.existsSync(p), true);
    // Escaping the workspace entirely is refused too.
    assert.throws(() => f.store.purgeTrashEntry({ rootPath: f.root, trashPath: path.join(f.dir, 'elsewhere') }));
  } finally { f.close(); }
});

test('agent surface gets 403 OWNER_SURFACE_ONLY for purge and empty-trash', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-ops-purge-http-'));
  const root = path.join(dir, 'workspace');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'doomed.md');
  fs.writeFileSync(file, 'doomed\n', 'utf8');
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
  const call = (base, pathName, body) => fetch(base + pathName, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  try {
    const trashed = store.deleteEntry({ rootPath: root, filePath: file });

    for (const [pathName, body] of [
      ['/api/fs/purge', { rootPath: root, path: trashed.path }],
      ['/api/fs/empty-trash', { rootPath: root }]
    ]) {
      const denied = await call(agentBase, pathName, body);
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).error, 'OWNER_SURFACE_ONLY');
    }
    assert.equal(fs.existsSync(trashed.path), true, 'agent surface must not purge');

    // The owner surface purges for real.
    const purged = await call(ownerBase, '/api/fs/purge', { rootPath: root, path: trashed.path });
    assert.equal(purged.status, 200);
    assert.deepEqual(await purged.json(), { purged: true, path: trashed.path });
    assert.equal(fs.existsSync(trashed.path), false);

    const emptied = await call(ownerBase, '/api/fs/empty-trash', { rootPath: root });
    assert.equal(emptied.status, 200);
    assert.deepEqual(await emptied.json(), { purged: 0 });
  } finally {
    await new Promise(r => owner.close(() => agent.close(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); r(); })));
  }
});
