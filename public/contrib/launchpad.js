// Contribution: the link hub. Home is the no-workspace kernel frame
// (before a workspace is chosen); still wireable into any station.
// With a workspace, Stations activate in place. Workspaces switch via
// the bus. Programs are the machine list plus workspace-preference links.
const PROGRAM_DEFAULTS = [
  { label: 'Extraction app', url: 'http://127.0.0.1:7860' },
  { label: 'EPUB extract', url: 'http://127.0.0.1:7861' },
  { label: 'Extraction review', url: 'http://127.0.0.1:7870' },
  { label: 'Promotion center', url: 'http://127.0.0.1:8860' },
  { label: 'Revision center', url: 'http://127.0.0.1:8880' }
];

export function mount(el, ctx) {
  function chip(tag, icon, name, title) {
    const node = document.createElement(tag);
    node.className = 'launch-chip';
    if (title) node.title = title;
    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.textContent = icon;
    const label = document.createElement('span');
    label.textContent = name;
    node.append(ic, label);
    return node;
  }

  function group(title, open) {
    const details = document.createElement('details');
    details.className = 'launch-group';
    if (open) details.open = true;
    const summary = document.createElement('summary');
    summary.textContent = title;
    const row = document.createElement('div');
    row.className = 'launch-row';
    details.append(summary, row);
    return { details, row };
  }

  async function paint() {
    const root = ctx.workspace?.root_path || '';
    const [composition, workspaces, prefs] = await Promise.all([
      root
        ? ctx.request(`/api/composition?root=${encodeURIComponent(root)}`).catch(() => ({ enabled: [] }))
        : Promise.resolve({ enabled: [] }),
      ctx.request('/api/workspaces').catch(() => []),
      root
        ? ctx.request(`/api/ui-preferences?root=${encodeURIComponent(root)}`).catch(() => ({}))
        : Promise.resolve({})
    ]);

    el.innerHTML = '<div class="card"><h3>Launchpad</h3></div>';
    const host = el.querySelector('.card');

    if (ctx.workspace) {
      const stationsGroup = group('Stations', true);
      const stations = (Array.isArray(composition.enabled) ? composition.enabled : [])
        .filter(row => row.plugin_kind === 'station');
      for (const row of stations) {
        let manifest = row.manifest || {};
        if (typeof manifest === 'string') { try { manifest = JSON.parse(manifest); } catch { manifest = {}; } }
        const node = chip('div', manifest.icon || '▦', row.label || row.plugin_id, row.plugin_id);
        node.onclick = () => ctx.activateStation(row.plugin_id);
        stationsGroup.row.append(node);
      }
      host.append(stationsGroup.details);
    }

    const wsGroup = group('Workspaces', !ctx.workspace);
    for (const ws of (Array.isArray(workspaces) ? workspaces : [])) {
      const isCurrent = ws.root_path === ctx.workspace?.root_path;
      const name = ws.label || ws.root_path.split('/').filter(Boolean).pop() || ws.root_path;
      const missing = ws.exists === false;
      const title = missing ? `${ws.root_path} (missing on disk)` : ws.root_path;
      const node = chip('div', missing ? '⚠' : '🗂', name, title);
      if (!isCurrent) node.onclick = () => ctx.bus.emit('switch-workspace', { root: ws.root_path });
      wsGroup.row.append(node);
    }
    host.append(wsGroup.details);

    const programGroup = group('Programs on this machine', !ctx.workspace);
    const extra = Array.isArray(prefs.workspace?.links) ? prefs.workspace.links : [];
    for (const link of [...PROGRAM_DEFAULTS, ...extra]) {
      if (!link || !link.url) continue;
      const node = chip('a', '↗', link.label || link.url, link.url);
      node.href = link.url;
      node.target = '_blank';
      node.rel = 'noopener';
      programGroup.row.append(node);
    }
    host.append(programGroup.details);
  }

  const repaint = () => paint().catch(e => ctx.notify(e.message, 'error'));
  ctx.bus.on('prefs-changed', repaint);
  ctx.bus.on('workspace', repaint);
  repaint();
}
