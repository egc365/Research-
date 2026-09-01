// Contribution: the link hub. One card, three launch groups — enabled
// stations (activate in place), known workspaces (switch via the bus), and
// the fixed programs on this machine plus any workspace-preference links.
const PROGRAM_DEFAULTS = [
  { label: 'Extraction app', url: 'http://127.0.0.1:7860' },
  { label: 'EPUB extract', url: 'http://127.0.0.1:7861' },
  { label: 'Extraction review', url: 'http://127.0.0.1:7870' },
  { label: 'Promotion center', url: 'http://127.0.0.1:8860' },
  { label: 'Revision center', url: 'http://127.0.0.1:8880' }
];

export function mount(el, ctx) {
  function card(tag) {
    const node = document.createElement(tag);
    node.className = 'launch-card';
    return node;
  }

  function fill(node, icon, name, sub) {
    const ic = document.createElement('div');
    ic.className = 'ic';
    ic.textContent = icon;
    const label = document.createElement('div');
    label.textContent = name;
    const detail = document.createElement('div');
    detail.className = 'sub';
    detail.textContent = sub;
    node.append(ic, label, detail);
  }

  function heading(text) {
    const head = document.createElement('div');
    head.className = 'muted';
    head.textContent = text;
    return head;
  }

  function grid() {
    const g = document.createElement('div');
    g.className = 'launch-grid';
    return g;
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

    // 1) Stations
    host.append(heading('Stations'));
    const stationGrid = grid();
    const stations = (Array.isArray(composition.enabled) ? composition.enabled : [])
      .filter(row => row.plugin_kind === 'station');
    for (const row of stations) {
      let manifest = row.manifest || {};
      if (typeof manifest === 'string') { try { manifest = JSON.parse(manifest); } catch { manifest = {}; } }
      const node = card('div');
      fill(node, manifest.icon || '▦', row.label || row.plugin_id,
        String(manifest.description || '').slice(0, 60));
      node.onclick = () => ctx.activateStation(row.plugin_id);
      stationGrid.append(node);
    }
    if (!stations.length) stationGrid.append(heading('No stations enabled.'));
    host.append(stationGrid);

    // 2) Workspaces
    host.append(heading('Workspaces'));
    const wsGrid = grid();
    for (const ws of (Array.isArray(workspaces) ? workspaces : [])) {
      const isCurrent = ws.root_path === ctx.workspace?.root_path;
      const node = card('div');
      const name = ws.label || ws.root_path.split('/').filter(Boolean).pop() || ws.root_path;
      fill(node, '🗂', name, ws.root_path + (isCurrent ? ' · current' : ''));
      if (!isCurrent) node.onclick = () => ctx.bus.emit('switch-workspace', { root: ws.root_path });
      wsGrid.append(node);
    }
    host.append(wsGrid);

    // 3) Programs on this machine
    host.append(heading('Programs on this machine'));
    const programGrid = grid();
    const extra = Array.isArray(prefs.workspace?.links) ? prefs.workspace.links : [];
    for (const link of [...PROGRAM_DEFAULTS, ...extra]) {
      if (!link || !link.url) continue;
      const node = card('a');
      node.href = link.url;
      node.target = '_blank';
      node.rel = 'noopener';
      fill(node, '↗', link.label || link.url, link.url);
      programGrid.append(node);
    }
    host.append(programGrid);
  }

  const repaint = () => paint().catch(e => ctx.notify(e.message, 'error'));
  ctx.bus.on('prefs-changed', repaint);
  ctx.bus.on('workspace', repaint);
  repaint();
}
