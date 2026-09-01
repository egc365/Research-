// A workspace registration must follow the folder it names. Trashing or moving
// a folder that is (or contains) a registered workspace root through the
// governed tree must not leave ghost rows in workspace_roots — that ghost is
// what rendered a deleted workspace in the switcher and threw raw ENOENT
// (scandir) on the dashboard (observed 2026-09-01, demo-workspace/workspace-a).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ControlStore } from '../src/store.mjs';

function freshStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-ops-ws-'));
  const store = new ControlStore(path.join(dir, 'control.sqlite3'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store };
}

function registerNested(store, dir, name) {
  const outer = path.join(dir, 'outer');
  const inner = path.join(outer, name);
  fs.mkdirSync(inner, { recursive: true });
  store.addWorkspace(outer, 'outer');
  store.addWorkspace(inner, name);
  return { outer, inner };
}

test('listWorkspaces reports whether each root still exists on disk', t => {
  const { dir, store } = freshStore(t);
  const alive = path.join(dir, 'alive');
  const gone = path.join(dir, 'gone');
  fs.mkdirSync(alive); fs.mkdirSync(gone);
  store.addWorkspace(alive); store.addWorkspace(gone);
  fs.rmSync(gone, { recursive: true });
  const byPath = Object.fromEntries(store.listWorkspaces().map(ws => [ws.root_path, ws]));
  assert.equal(byPath[alive].exists, true);
  assert.equal(byPath[gone].exists, false);
});

test('trashing a registered workspace root unregisters it', t => {
  const { dir, store } = freshStore(t);
  const { outer, inner } = registerNested(store, dir, 'ws-a');
  const result = store.deleteEntry({ rootPath: outer, filePath: inner });
  assert.equal(result.trashed, true);
  assert.deepEqual(result.unregisteredWorkspaces, [inner]);
  assert.equal(store.getWorkspace(inner), undefined);
  assert.ok(store.getWorkspace(outer), 'the containing workspace stays registered');
});

test('trashing a folder that contains a registered root unregisters the nested root too', t => {
  const { dir, store } = freshStore(t);
  const outer = path.join(dir, 'outer');
  const parent = path.join(outer, 'shelf');
  const inner = path.join(parent, 'ws-b');
  fs.mkdirSync(inner, { recursive: true });
  store.addWorkspace(outer, 'outer');
  store.addWorkspace(inner, 'ws-b');
  const result = store.deleteEntry({ rootPath: outer, filePath: parent });
  assert.deepEqual(result.unregisteredWorkspaces, [inner]);
  assert.equal(store.getWorkspace(inner), undefined);
});

test('moving a registered workspace root re-points its registration and composition', t => {
  const { dir, store } = freshStore(t);
  const { outer, inner } = registerNested(store, dir, 'ws-c');
  store.defineStation({ id: 'test-station', label: 'Test station', layout: 'main' });
  store.setWorkspacePlugin({ rootPath: inner, pluginId: 'test-station' });
  const to = path.join(outer, 'ws-c-renamed');
  store.moveEntry({ rootPath: outer, fromPath: inner, toPath: to });
  assert.equal(store.getWorkspace(inner), undefined);
  const moved = store.getWorkspace(to);
  assert.ok(moved, 'the registration follows the folder');
  assert.equal(moved.label, 'ws-c');
  const enabled = store.workspacePlugins(to).map(row => row.plugin_id);
  assert.deepEqual(enabled, ['test-station'], 'workspace composition follows the folder');
});

test('listDirectory on a missing workspace root throws a coded error, not raw ENOENT', t => {
  const { dir, store } = freshStore(t);
  const gone = path.join(dir, 'gone');
  fs.mkdirSync(gone);
  store.addWorkspace(gone);
  fs.rmSync(gone, { recursive: true });
  assert.throws(() => store.listDirectory(gone, '.'), err => err.code === 'WORKSPACE_ROOT_MISSING');
});
