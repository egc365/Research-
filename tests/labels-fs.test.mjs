import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ControlStore } from '../src/store.mjs';

function freshStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-ops-labels-'));
  const store = new ControlStore(path.join(dir, 'control.sqlite3'));
  const ws = path.join(dir, 'workspace'); fs.mkdirSync(ws);
  store.addWorkspace(ws);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, ws };
}

test('createDirectory stays inside the workspace and appends a MKDIR event', t => {
  const { store, ws } = freshStore(t);
  const made = store.createDirectory({ rootPath: ws, dirPath: path.join(ws, 'projects/alpha'), actor: 'human' });
  assert.ok(fs.statSync(made.path).isDirectory());
  assert.equal(store.history(made.path)[0].event_type, 'MKDIR');
  assert.throws(() => store.createDirectory({ rootPath: ws, dirPath: '/etc/research-ops-escape' }), /outside workspace/);
  assert.throws(() => store.createDirectory({ rootPath: ws, dirPath: made.path }), /Already exists/);
});

test('label schema: define, assign to file and folder, remove, delete cascades', t => {
  const { store, ws } = freshStore(t);
  const doc = path.join(ws, 'notes.md'); fs.writeFileSync(doc, 'x\n');
  const folder = path.join(ws, 'shelf'); fs.mkdirSync(folder);
  store.defineLabel({ name: 'evidence', color: '#4fc08d', description: 'source-backed' });
  store.defineLabel({ name: 'draft' });
  assert.throws(() => store.assignLabel({ rootPath: ws, filePath: doc, label: 'nope' }), /Unknown label/);
  assert.throws(() => store.assignLabel({ rootPath: ws, filePath: path.join(ws, 'ghost.md'), label: 'draft' }), /No such file/);
  store.assignLabel({ rootPath: ws, filePath: doc, label: 'evidence' });
  store.assignLabel({ rootPath: ws, filePath: doc, label: 'draft' });
  store.assignLabel({ rootPath: ws, filePath: folder, label: 'evidence' });
  const byPath = store.pathLabels(ws);
  assert.deepEqual(byPath[doc].map(a => a.label), ['draft', 'evidence']);
  assert.deepEqual(byPath[folder].map(a => a.label), ['evidence']);
  assert.equal(store.listLabels().find(l => l.name === 'evidence').assigned, 2);
  store.assignLabel({ rootPath: ws, filePath: doc, label: 'draft', remove: true });
  assert.deepEqual(store.pathLabels(ws)[doc].map(a => a.label), ['evidence']);
  store.deleteLabel('evidence');
  assert.equal(store.pathLabels(ws)[doc], undefined);
  assert.equal(store.listLabels().length, 1);
});
