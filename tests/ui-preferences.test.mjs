import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ControlStore } from '../src/store.mjs';

function freshStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-ops-prefs-'));
  const store = new ControlStore(path.join(dir, 'control.sqlite3'));
  const ws = path.join(dir, 'workspace'); fs.mkdirSync(ws);
  store.addWorkspace(ws);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, ws };
}

test('preferences are validated JSON: unknown keys dropped, bad values refused', t => {
  const { store, ws } = freshStore(t);
  const saved = store.setUiPreferences({ rootPath: ws, patch: {
    theme: 'dark', sidebar: { width: 340, collapsed: true }, evilKey: 'x', favorites: ['/a/b.md']
  } });
  assert.deepEqual(saved, { theme: 'dark', sidebar: { width: 340, collapsed: true }, favorites: ['/a/b.md'] });
  assert.throws(() => store.setUiPreferences({ rootPath: ws, patch: { theme: 'neon' } }), /invalid value/);
  assert.throws(() => store.setUiPreferences({ rootPath: ws, patch: { sidebar: { width: 5000 } } }), /invalid value/);
  // user scope is separate; reset clears only the chosen scope
  store.setUiPreferences({ patch: { density: 'compact' } });
  store.setUiPreferences({ rootPath: ws, reset: true });
  assert.deepEqual(store.uiPreferences(ws), {});
  assert.deepEqual(store.uiPreferences(null), { density: 'compact' });
});

test('sidebar sections seed once, persist owner edits, order deterministically', t => {
  const { store, ws } = freshStore(t);
  const seeded = store.sidebarSections(ws, ['section-favorites', 'filesystem-tree', 'section-trash']);
  assert.deepEqual(seeded.map(r => r.section_id), ['section-favorites', 'filesystem-tree', 'section-trash']);
  store.setSidebarSection({ rootPath: ws, sectionId: 'section-trash', visible: false });
  store.setSidebarSection({ rootPath: ws, sectionId: 'section-favorites', sortOrder: 25 });
  const after = store.sidebarSections(ws, ['section-favorites', 'filesystem-tree', 'section-trash']); // reseed skips
  assert.deepEqual(after.map(r => [r.section_id, r.visible]), [
    ['filesystem-tree', 1], ['section-favorites', 1], ['section-trash', 0]
  ]);
});

test('trash lists entries with their origin and restore puts everything back', t => {
  const { store, ws } = freshStore(t);
  fs.mkdirSync(path.join(ws, 'box'));
  const doc = path.join(ws, 'box', 'a.md');
  store.writeFile({ rootPath: ws, filePath: doc, content: 'x\n', actor: 'human' });
  store.defineLabel({ name: 'draft' });
  store.assignLabel({ rootPath: ws, filePath: doc, label: 'draft' });
  const gone = store.deleteEntry({ rootPath: ws, filePath: path.join(ws, 'box') });
  const listed = store.listTrash(ws);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].from, path.join(ws, 'box'));
  const back = store.restoreEntry({ rootPath: ws, trashPath: gone.path });
  assert.equal(back.path, path.join(ws, 'box'));
  assert.ok(fs.existsSync(doc));
  assert.equal(store.getArtifact(doc).state, 'working');
  assert.deepEqual(store.pathLabels(ws)[doc].map(a => a.label), ['draft']);
  assert.equal(store.history(path.join(ws, 'box'))[0].event_type, 'RESTORE');
  assert.deepEqual(store.listTrash(ws), []);
});

test('recentActivity returns last-touched artifacts, trash excluded', t => {
  const { store, ws } = freshStore(t);
  const a = path.join(ws, 'a.md'), b = path.join(ws, 'b.md');
  store.writeFile({ rootPath: ws, filePath: a, content: '1\n', actor: 'human' });
  store.writeFile({ rootPath: ws, filePath: b, content: '2\n', actor: 'agent' });
  store.deleteEntry({ rootPath: ws, filePath: a });
  const recent = store.recentActivity(ws, 10);
  assert.deepEqual(recent.map(r => r.path), [b]);
});

test('removeWorkspace unregisters everything but leaves the disk alone', t => {
  const { store, ws } = freshStore(t);
  const doc = path.join(ws, 'keep.md');
  store.writeFile({ rootPath: ws, filePath: doc, content: 'x\n', actor: 'human' });
  store.defineLabel({ name: 'draft' });
  store.assignLabel({ rootPath: ws, filePath: doc, label: 'draft' });
  store.setUiPreferences({ rootPath: ws, patch: { theme: 'dark' } });
  store.sidebarSections(ws, ['filesystem-tree']);
  const gone = store.removeWorkspace(ws);
  assert.equal(gone.removed, ws);
  assert.ok(fs.existsSync(doc)); // bytes untouched
  assert.ok(!store.getWorkspace(ws));
  assert.ok(!store.getArtifact(doc));
  assert.deepEqual(store.uiPreferences(ws), {});
  assert.deepEqual(store.pathLabels(ws), {});
  assert.throws(() => store.removeWorkspace(ws), /not registered/);
});

test('first sidebar edit seeds the defaults instead of swallowing them', t => {
  const { store, ws } = freshStore(t);
  store.sidebarDefaults = ['section-favorites', 'filesystem-tree', 'section-trash'];
  store.setSidebarSection({ rootPath: ws, sectionId: 'section-trash', visible: false });
  const rows = store.sidebarSections(ws, store.sidebarDefaults);
  assert.deepEqual(rows.map(r => [r.section_id, r.visible]),
    [['section-favorites', 1], ['filesystem-tree', 1], ['section-trash', 0]]);
});
