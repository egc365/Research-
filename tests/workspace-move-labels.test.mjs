import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ControlStore } from '../src/store.mjs';

function freshStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-ops-wsmove-'));
  const store = new ControlStore(path.join(dir, 'control.sqlite3'));
  const ws = path.join(dir, 'workspace'); fs.mkdirSync(ws);
  store.addWorkspace(ws);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, ws, dir };
}

test('createWorkspace makes the directory when asked and refuses a ghost otherwise', t => {
  const { store, dir } = freshStore(t);
  const fresh = path.join(dir, 'brand-new');
  assert.throws(() => store.createWorkspace({ rootPath: fresh }), /pass create/);
  const ws = store.createWorkspace({ rootPath: fresh, label: 'fresh', create: true });
  assert.ok(fs.statSync(fresh).isDirectory());
  assert.equal(ws.label, 'fresh');
  // a fresh workspace is a bare composition profile: nothing enabled
  assert.deepEqual(store.workspacePlugins(fresh), []);
});

test('retirePlugins removes a plugin from all three composition tables', t => {
  const { store, ws } = freshStore(t);
  store.syncCatalog([
    { plugin_id: 'old-station', plugin_kind: 'station', label: 'Old', version: '1', client_entry: null, server_entry: null, manifest_json: '{"slots":["main"]}' },
    { plugin_id: 'old-contrib', plugin_kind: 'contribution', label: 'OldC', version: '1', client_entry: '/x.js', server_entry: null, manifest_json: '{}' }
  ]);
  store.setWorkspacePlugin({ rootPath: ws, pluginId: 'old-station' });
  store.setStationContribution({ stationId: 'old-station', slotName: 'main', contributionId: 'old-contrib' });
  store.retirePlugins(['old-station', 'old-contrib']);
  assert.ok(!store.listCatalog().some(r => r.plugin_id.startsWith('old-')));
  assert.deepEqual(store.workspacePlugins(ws), []);
  assert.deepEqual(store.stationContributions('old-station'), []);
});

test('renameLabel carries designations and refuses collisions', t => {
  const { store, ws } = freshStore(t);
  const doc = path.join(ws, 'a.md'); fs.writeFileSync(doc, 'x\n');
  store.defineLabel({ name: 'evidence', color: '#4fc08d' });
  store.defineLabel({ name: 'draft' });
  store.assignLabel({ rootPath: ws, filePath: doc, label: 'evidence' });
  assert.throws(() => store.renameLabel({ name: 'evidence', newName: 'draft' }), /already exists/);
  assert.throws(() => store.renameLabel({ name: 'ghost', newName: 'anything' }), /Unknown label/);
  const renamed = store.renameLabel({ name: 'evidence', newName: 'source-backed' });
  assert.equal(renamed.color, '#4fc08d');
  assert.deepEqual(store.pathLabels(ws)[doc].map(a => a.label), ['source-backed']);
  assert.ok(!store.listLabels().some(l => l.name === 'evidence'));
});

test('moveEntry moves a registered file and its labels, amendments, versions', t => {
  const { store, ws } = freshStore(t);
  const from = path.join(ws, 'notes.md');
  store.writeFile({ rootPath: ws, filePath: from, content: '# notes\n', actor: 'human' });
  store.defineLabel({ name: 'evidence' });
  store.assignLabel({ rootPath: ws, filePath: from, label: 'evidence' });
  store.appendAmendment({ filePath: from, card: 'b1-abc', body: 'better text' });
  fs.mkdirSync(path.join(ws, 'shelf'));
  const to = path.join(ws, 'shelf', 'notes.md');
  const moved = store.moveEntry({ rootPath: ws, fromPath: from, toPath: to, actor: 'human' });
  assert.equal(moved.moved, true);
  assert.ok(fs.existsSync(to) && !fs.existsSync(from));
  assert.equal(store.getArtifact(to).state, 'working');
  assert.ok(!store.getArtifact(from));
  assert.deepEqual(store.pathLabels(ws)[to].map(a => a.label), ['evidence']);
  assert.equal(store.listAmendments(to).entries.length, 1);
  assert.equal(store.history(to)[0].event_type, 'MOVE');
  assert.throws(() => store.moveEntry({ rootPath: ws, fromPath: to, toPath: '/etc/x' }), /outside workspace/);
});

test('moveEntry moves a folder with everything under it', t => {
  const { store, ws } = freshStore(t);
  fs.mkdirSync(path.join(ws, 'box'));
  const inner = path.join(ws, 'box', 'doc.md');
  store.writeFile({ rootPath: ws, filePath: inner, content: 'x\n', actor: 'human' });
  store.defineLabel({ name: 'draft' });
  store.assignLabel({ rootPath: ws, filePath: path.join(ws, 'box'), label: 'draft' });
  const moved = store.moveEntry({ rootPath: ws, fromPath: path.join(ws, 'box'), toPath: path.join(ws, 'crate') });
  assert.equal(moved.kind, 'directory');
  assert.ok(fs.existsSync(path.join(ws, 'crate', 'doc.md')));
  assert.equal(store.getArtifact(path.join(ws, 'crate', 'doc.md')).state, 'working');
  assert.deepEqual(store.pathLabels(ws)[path.join(ws, 'crate')].map(a => a.label), ['draft']);
  assert.throws(() => store.moveEntry({ rootPath: ws, fromPath: path.join(ws, 'crate'), toPath: path.join(ws, 'crate', 'inside') }), /into itself/);
});
