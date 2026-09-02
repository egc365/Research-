import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ControlStore } from '../src/store.mjs';
import { catalogRows, defaultWiring, retired, stations, contributions, wiringRemovals } from '../plugins/registry.mjs';

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

test('every catalog contribution carries manifest.description', t => {
  const { store } = freshStore(t);
  const catalog = store.syncCatalog(catalogRows([]));
  const missing = catalog.filter(r => r.plugin_kind === 'contribution' && !String(r.manifest?.description || '').trim());
  assert.deepEqual(missing.map(r => r.plugin_id), []);
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
  for (const id of ['launchpad', 'board-view', 'inbox', 'statistics-view']) {
    store.setStationContribution({ stationId: 'dashboard-viewer', slotName: 'main', contributionId: id, remove: true });
  }
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

test('a wiring row can be disabled and restored without touching its neighbors', t => {
  const { store, dir } = freshStore(t);
  store.syncCatalog(catalogRows([]));
  store.seedStationWiring(defaultWiring);
  const ws = path.join(dir, 'ws2'); fs.mkdirSync(ws);
  store.addWorkspace(ws);
  store.setWorkspacePlugin({ rootPath: ws, pluginId: 'revision-center' });
  const before = store.stationContributions('revision-center').map(r => r.contribution_id);
  assert.ok(before.includes('card-rail') && before.includes('dual-document-view'));
  store.setStationContribution({ stationId: 'revision-center', slotName: 'side', contributionId: 'card-rail', sortOrder: 10, config: { source: 'transcript' }, enabled: false });
  const disabled = store.stationContributions('revision-center').map(r => r.contribution_id);
  assert.ok(!disabled.includes('card-rail'));
  assert.ok(disabled.includes('dual-document-view')); // cards gone, dual view intact
  store.setStationContribution({ stationId: 'revision-center', slotName: 'side', contributionId: 'card-rail', sortOrder: 10, config: { source: 'transcript' }, enabled: true });
  const restored = store.stationContributions('revision-center').find(r => r.contribution_id === 'card-rail');
  assert.equal(restored.config.source, 'transcript');
});

test('validation-center replaces governance-center with shared components configured per station', t => {
  const { store } = freshStore(t);
  store.syncCatalog(catalogRows([]));
  store.retirePlugins(['governance-center']);
  store.seedStationWiring(defaultWiring);
  assert.ok(!store.listCatalog().some(r => r.plugin_id === 'governance-center'));
  const wired = store.stationContributions('validation-center');
  const main = wired.filter(r => r.slot_name === 'main');
  assert.deepEqual(main.map(r => r.contribution_id), ['dual-document-view', 'diff-renderer', 'validation-result']);
  assert.equal(main[0].config.base, 'promoted'); // the frozen bytes, not git
  assert.equal(main[1].config.base, 'promoted');
  const side = wired.filter(r => r.slot_name === 'side').map(r => r.contribution_id);
  assert.deepEqual(side, ['state-badge', 'provenance-block', 'promotion-control']);
  // one diff renderer, one dual view, one provenance renderer in the catalog
  const catalog = store.listCatalog().filter(r => r.plugin_kind === 'contribution').map(r => r.plugin_id);
  for (const id of ['diff-renderer', 'dual-document-view', 'provenance-block']) {
    assert.equal(catalog.filter(x => x === id).length, 1);
  }
});

test('owner-defined stations render like shipped ones and survive catalog sync', t => {
  const { store, dir } = freshStore(t);
  store.syncCatalog(catalogRows([]));
  store.seedStationWiring(defaultWiring);
  const made = store.defineStation({ id: 'reading-room', label: 'Reading room', layout: 'rail-main' });
  assert.equal(made.plugin_kind, 'station');
  assert.deepEqual(JSON.parse(made.manifest_json).slots, ['rail', 'main']);
  assert.throws(() => store.defineStation({ id: 'card-rail', label: 'x' }), /already names a contribution/);
  assert.throws(() => store.defineStation({ id: 'Bad Id', label: 'x' }), /Station ids/);
  store.setStationContribution({ stationId: 'reading-room', slotName: 'main', contributionId: 'dual-document-view', sortOrder: 10 });
  const ws = path.join(dir, 'ws3'); fs.mkdirSync(ws);
  store.addWorkspace(ws);
  store.setWorkspacePlugin({ rootPath: ws, pluginId: 'reading-room' });
  store.syncCatalog(catalogRows([])); // a restart never erases owner stations
  const composition = store.composition(ws);
  assert.ok(composition.enabled.some(r => r.plugin_id === 'reading-room'));
  assert.deepEqual(composition.stations['reading-room'].map(r => r.contribution_id), ['dual-document-view']);
});

test('wiring additions apply exactly once — an owner unwire is never fought', t => {
  const { store } = freshStore(t);
  store.syncCatalog(catalogRows([]));
  // The dashboard already has owner wiring rows, so the seeder skips it.
  store.setStationContribution({ stationId: 'dashboard-viewer', slotName: 'main', contributionId: 'launchpad', sortOrder: 10 });
  const additions = [{ id: 'test-add-board', stationId: 'dashboard-viewer', slotName: 'main', contributionId: 'board-view', sortOrder: 15 }];
  store.applyWiringAdditions(additions);
  const wired = () => store.db.prepare(
    "SELECT contribution_id FROM station_contributions WHERE station_id='dashboard-viewer' ORDER BY sort_order"
  ).all().map(r => r.contribution_id);
  assert.deepEqual(wired(), ['launchpad', 'board-view']);
  // Owner removes it; a restart re-applies additions — the row must stay gone.
  store.db.prepare("DELETE FROM station_contributions WHERE contribution_id='board-view'").run();
  store.applyWiringAdditions(additions);
  assert.deepEqual(wired(), ['launchpad']);
});

test('wiring removals apply exactly once — an owner re-wire is never fought', t => {
  const { store } = freshStore(t);
  store.syncCatalog(catalogRows([]));
  // Existing owner DB: dashboard already has launchpad + folder-cards.
  store.setStationContribution({ stationId: 'dashboard-viewer', slotName: 'main', contributionId: 'launchpad', sortOrder: 10 });
  store.setStationContribution({ stationId: 'dashboard-viewer', slotName: 'main', contributionId: 'folder-cards', sortOrder: 20 });
  const removals = [{ id: 'test-remove-folder-cards', stationId: 'dashboard-viewer', slotName: 'main', contributionId: 'folder-cards' }];
  store.applyWiringRemovals(removals);
  const wired = () => store.db.prepare(
    "SELECT contribution_id FROM station_contributions WHERE station_id='dashboard-viewer' ORDER BY sort_order"
  ).all().map(r => r.contribution_id);
  assert.deepEqual(wired(), ['launchpad']);
  store.setStationContribution({ stationId: 'dashboard-viewer', slotName: 'main', contributionId: 'folder-cards', sortOrder: 20 });
  store.applyWiringRemovals(removals);
  assert.ok(wired().includes('folder-cards'));
  const meta = store.db.prepare("SELECT value FROM app_meta WHERE key=?").get('wiring-removal:test-remove-folder-cards');
  assert.ok(meta);
});

test('file-workbench is retired: no station row, no wiring, category on every survivor', t => {
  const { store } = freshStore(t);
  store.syncCatalog(catalogRows([]));
  store.retirePlugins(retired);
  store.seedStationWiring(defaultWiring);
  const catalog = store.listCatalog();
  assert.equal(catalog.some(r => r.plugin_id === 'file-workbench'), false);
  for (const row of catalog.filter(r => r.plugin_kind === 'station')) {
    assert.ok(row.manifest.category, `${row.plugin_id} has a nav category`);
  }
  assert.equal(defaultWiring['file-workbench'], undefined);
  assert.ok(defaultWiring['dashboard-viewer'].main.includes('board-view'));
  assert.ok(!defaultWiring['dashboard-viewer'].main.includes('folder-cards'));
  assert.ok(!defaultWiring['dashboard-viewer'].main.includes('launchpad'));
});

test('seeded dashboard is board, inbox, statistics; launchpad stays a wireable catalog contribution', t => {
  const { store } = freshStore(t);
  store.syncCatalog(catalogRows([]));
  store.seedStationWiring(defaultWiring);
  const wired = store.stationContributions('dashboard-viewer').map(r => r.contribution_id);
  assert.deepEqual(wired, ['board-view', 'inbox', 'statistics-view']);
  const catalog = store.listCatalog();
  const launchpad = catalog.find(r => r.plugin_id === 'launchpad');
  assert.ok(launchpad);
  assert.equal(launchpad.plugin_kind, 'contribution');
  const desc = String(launchpad.manifest?.description || contributions.find(c => c.id === 'launchpad')?.description || '');
  assert.match(desc, /before a workspace|no-workspace/i);
  assert.ok(stations.some(s => s.id === 'planning-board'));
  assert.deepEqual(defaultWiring['planning-board'].main, ['board-view']);
  assert.ok(!retired.includes('launchpad'));
});

test('catalog launchpad removal applies exactly once — an owner re-wire is never fought', t => {
  const { store } = freshStore(t);
  store.syncCatalog(catalogRows([]));
  store.setStationContribution({ stationId: 'dashboard-viewer', slotName: 'main', contributionId: 'launchpad', sortOrder: 10 });
  store.setStationContribution({ stationId: 'dashboard-viewer', slotName: 'main', contributionId: 'board-view', sortOrder: 20 });
  const launchpadRemoval = wiringRemovals.find(r =>
    r.stationId === 'dashboard-viewer' && r.slotName === 'main' && r.contributionId === 'launchpad');
  assert.ok(launchpadRemoval, 'catalog exports a launchpad wiringRemovals row');
  store.applyWiringRemovals(wiringRemovals);
  const wired = () => store.db.prepare(
    "SELECT contribution_id FROM station_contributions WHERE station_id='dashboard-viewer' ORDER BY sort_order"
  ).all().map(r => r.contribution_id);
  assert.ok(!wired().includes('launchpad'));
  assert.ok(wired().includes('board-view'));
  const meta = store.db.prepare("SELECT value FROM app_meta WHERE key=?").get(`wiring-removal:${launchpadRemoval.id}`);
  assert.ok(meta);
  store.setStationContribution({ stationId: 'dashboard-viewer', slotName: 'main', contributionId: 'launchpad', sortOrder: 10 });
  store.applyWiringRemovals(wiringRemovals);
  assert.ok(wired().includes('launchpad'));
});
