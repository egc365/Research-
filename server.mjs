import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore } from './src/store.mjs';
import { PluginHost } from './src/plugin-host.mjs';
import { createAppServer } from './src/http.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.RESEARCH_OPS_DB || path.join(here, '.research-ops', 'control.sqlite3');
const host = process.env.HOST || '127.0.0.1';
const ownerPort = Number(process.env.PORT || 8787);
const agentPort = Number(process.env.AGENT_PORT || 8788);

const store = new ControlStore(dbPath);
const plugins = new PluginHost({ store, pluginDir: path.join(here, 'plugins', 'server') });
await plugins.load();

// Sync the declared catalog into the SQLite crosswalk. Owner state survives:
// enabled flags are never overwritten, and default station wiring is seeded
// only for stations with no wiring rows at all.
const { catalogRows, defaultWiring, retired, sidebarDefaults, wiringAdditions, wiringRemovals, wiringConfigSeeds, stationEnables } = await import('./plugins/registry.mjs');
store.sidebarDefaults = sidebarDefaults;
store.syncCatalog(catalogRows(plugins.manifest()));
store.applyStationEnables(stationEnables);
store.retirePlugins(retired);
store.seedStationWiring(defaultWiring);
store.applyWiringAdditions(wiringAdditions);
store.applyWiringRemovals(wiringRemovals);
store.applyWiringConfigSeeds(wiringConfigSeeds);

// Two surfaces, one store. The owner port serves the UI and honors the request's
// actor. The agent port is API-only and forces actor=agent at the boundary, so
// promotion (human-only in the store) is structurally unreachable from it.
const ownerServer = createAppServer({ store, plugins, surface: 'owner' });
const agentServer = createAppServer({ store, plugins, surface: 'agent' });

ownerServer.listen(ownerPort, host, () => {
  console.log(`Research Operations owner surface on http://${host}:${ownerPort}`);
  console.log(`Control DB: ${dbPath}`);
  console.log(`Plugins: ${plugins.manifest().map(x => x.id).join(', ')}`);
});
agentServer.listen(agentPort, host, () => {
  console.log(`Research Operations agent surface on http://${host}:${agentPort} (actor forced to 'agent')`);
});

for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => {
  ownerServer.close(() => agentServer.close(() => { store.close(); process.exit(0); }));
});
