// Contribution: the no-workspace frame. Workspaces to enter; still
// wireable into a station, where it also lists Stations as chips the
// owner can drag into an apps widget.
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

  function dragApp(node, payload) {
    node.draggable = true;
    node.addEventListener('dragstart', event => {
      const json = JSON.stringify(payload);
      event.dataTransfer.setData('application/x-ro-app', json);
      event.dataTransfer.setData('text/plain', 'ro-app:' + json);
      event.dataTransfer.effectAllowed = 'copy';
    });
  }

  async function paint() {
    const root = ctx.workspace?.root_path || '';
    const [composition, workspaces] = await Promise.all([
      root
        ? ctx.request(`/api/composition?root=${encodeURIComponent(root)}`).catch(() => ({ enabled: [] }))
        : Promise.resolve({ enabled: [] }),
      ctx.request('/api/workspaces').catch(() => [])
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
        dragApp(node, { kind: 'app', station: row.plugin_id, label: row.label || row.plugin_id });
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
  }

  const repaint = () => paint().catch(e => ctx.notify(e.message, 'error'));
  ctx.bus.on('workspace', repaint);
  repaint();
}
