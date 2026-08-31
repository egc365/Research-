import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export class PluginHost {
  constructor({ store, pluginDir }) {
    this.store = store;
    this.pluginDir = pluginDir;
    this.plugins = new Map();
  }

  async load() {
    this.plugins.clear();
    if (!fs.existsSync(this.pluginDir)) return;
    const entries = fs.readdirSync(this.pluginDir).filter(name => name.endsWith('.mjs')).sort();
    for (const name of entries) {
      const moduleUrl = pathToFileURL(path.join(this.pluginDir, name));
      moduleUrl.searchParams.set('v', String(Date.now()));
      const mod = await import(moduleUrl.href);
      if (!mod.plugin?.id) throw new Error(`${name} does not export plugin.id`);
      this.plugins.set(mod.plugin.id, mod.plugin);
    }
  }

  manifest() {
    return [...this.plugins.values()].map(plugin => ({
      id: plugin.id,
      label: plugin.label || plugin.id,
      order: plugin.order ?? 100,
      clientModule: plugin.clientModule || null,
      description: plugin.description || ''
    })).sort((a,b) => a.order - b.order || a.label.localeCompare(b.label));
  }

  async beforeWrite(context) {
    const results = [];
    for (const plugin of this.plugins.values()) {
      if (!plugin.beforeWrite) continue;
      const result = await plugin.beforeWrite({ ...context, store: this.store });
      if (result) results.push({ plugin: plugin.id, ...result });
      if (result?.ok === false) {
        const error = new Error(result.message || `Write blocked by ${plugin.id}`);
        error.code = 'PREFLIGHT_BLOCKED';
        error.preflight = results;
        throw error;
      }
    }
    return results;
  }

  async runValidators(context) {
    const results = [];
    let ok = true;
    for (const plugin of this.plugins.values()) {
      if (!plugin.validate) continue;
      const result = await plugin.validate({ ...context, store: this.store });
      if (!result) continue;
      results.push({ plugin: plugin.id, ...result });
      if (result.ok === false) ok = false;
    }
    return { ok, results };
  }

  async action(pluginId, action, payload, context = {}) {
    const plugin = this.plugins.get(pluginId);
    if (!plugin?.action) throw new Error(`Plugin has no action handler: ${pluginId}`);
    return plugin.action({ action, payload, store: this.store, ...context });
  }
}
