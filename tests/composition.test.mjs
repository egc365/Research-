import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ControlStore } from '../src/store.mjs';
import { catalogRows, defaultWiring, stations, contributions } from '../plugins/registry.mjs';

function freshStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-ops-comp-'));
  const store = new ControlStore(path.join(dir, 'control.sqlite3'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, dir };
}

test('catalog sync upserts stations, contributions and services', t => {
  const { store } = freshStore(t);
  const services = [{ id: 'diff', label: 'Diff', description: 'x' }];
  const catalog = store.syncCatalog(catalogRows(services));
  assert.equal(catalog.filter(r => r.plugin_kind === 'station').length, stations.length);
  assert.equal(catalog.filter(r => r.plugin_kind === 'contribution').length, contributions.length);
  assert.equal(catalog.filter(r => r.plugin_kind === 'service').length, 1);
});

test('owner disable survives a catalog re-sync (restart)', t => {
  const { store } = freshStore(t);
  store.syncCatalog(catalogRows([]));
  store.db.prepare("UPDATE ui_plugins SET enabled=0 WHERE plugin_id='revision-center'").run();
  store.syncCatalog(catalogRows([]));
  const row = store.db.prepare("SELECT enabled FROM ui_plugins WHERE plugin_id='revision-center'").get();
  assert.equal(row.enabled, 0);
});

test('a fresh workspace has zero enabled plugins — the empty frame', t => {
  const { store, dir } = freshStore(t);
  store.syncCatalog(catalogRows([]));
  store.seedStationWiring(defaultWiring);
  const ws = path.join(dir, 'workspace'); fs.mkdirSync(ws);
  store.addWorkspace(ws);
  const composition = store.composition(ws);
  assert.equal(composition.enabled.length, 0);
  assert.deepEqual(composition.stations, {});
});

test('enabling a station exposes its default wiring, per slot in sort order', t => {
  const { store, dir } = freshStore(t);
  store.syncCatalog(catalogRows([]));
  store.seedStationWiring(defaultWiring);
  const ws = path.join(dir, 'workspace'); fs.mkdirSync(ws);
  store.addWorkspace(ws);
  store.setWorkspacePlugin({ rootPath: ws, pluginId: 'revision-center' });
  const composition = store.composition(ws);
  assert.equal(composition.enabled.length, 1);
  const wired = composition.stations['revision-center'];
  const bySlot = {};
  for (const row of wired) (bySlot[row.slot_name] ??= []).push(row.contribution_id);
  assert.deepEqual(bySlot.main, ['dual-document-view']);
  assert.deepEqual(bySlot.side, ['card-rail', 'amendment-editor', 'decision-controls', 'revision-timeline']);
});

test('owner wiring edits survive a reseed', t => {
  const { store } = freshStore(t);
  store.syncCatalog(catalogRows([]));
  store.seedStationWiring(defaultWiring);
  store.setStationContribution({ stationId: 'dashboard-viewer', slotName: 'main', contributionId: 'statistics-view', remove: true });
  store.setStationContribution({ stationId: 'dashboard-viewer', slotName: 'main', contributionId: 'candidate-list', sortOrder: 10 });
  store.seedStationWiring(defaultWiring); // a restart
  const wired = store.stationContributions('dashboard-viewer').map(r => r.contribution_id);
  assert.deepEqual(wired, ['candidate-list']);
});

test('wiring validates station, slot and contribution existence', t => {
  const { store } = freshStore(t);
  store.syncCatalog(catalogRows([]));
  assert.throws(() => store.setStationContribution({ stationId: 'nope', slotName: 'main', contributionId: 'card-rail' }), /Unknown station/);
  assert.throws(() => store.setStationContribution({ stationId: 'dashboard-viewer', slotName: 'attic', contributionId: 'card-rail' }), /no slot 'attic'/);
  assert.throws(() => store.setStationContribution({ stationId: 'dashboard-viewer', slotName: 'main', contributionId: 'nope' }), /Unknown contribution/);
});

test('disabling a station for a workspace removes it from the composition', t => {
  const { store, dir } = freshStore(t);
  store.syncCatalog(catalogRows([]));
  store.seedStationWiring(defaultWiring);
  const ws = path.join(dir, 'workspace'); fs.mkdirSync(ws);
  store.addWorkspace(ws);
  store.setWorkspacePlugin({ rootPath: ws, pluginId: 'dashboard-viewer' });
  store.setWorkspacePlugin({ rootPath: ws, pluginId: 'dashboard-viewer', enabled: false });
  assert.equal(store.composition(ws).enabled.length, 0);
});
