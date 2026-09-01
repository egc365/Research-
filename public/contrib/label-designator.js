// Contribution: the owner's designation panel. Define the label schema
// (name + color), then assign labels to any file or folder path. Both live
// in the SQLite crosswalk (labels, path_labels); writes are owner-surface
// only — agents can read designations, never make them.
export function mount(el, ctx) {
  async function paint() {
    const schema = await ctx.request('/api/labels');
    const target = ctx.selection?.path || '';
    const assigned = target && ctx.workspace
      ? ((await ctx.request(`/api/path-labels?root=${encodeURIComponent(ctx.workspace.root_path)}`))[target] || [])
      : [];
    el.innerHTML = `
      <div class="card"><h3>Label schema</h3>
        <div data-role="schema"></div>
        <div style="display:flex;gap:6px;margin-top:8px">
          <input data-role="new-name" placeholder="new label" style="flex:1">
          <input data-role="new-color" type="color" value="#4fa3ff" title="Label color" style="padding:2px;width:42px">
          <button data-role="define">Define</button>
        </div>
      </div>
      <div class="card"><h3>Designate</h3>
        <input data-role="target" style="width:100%" class="mono" placeholder="file or folder path (select a file to prefill)" value="${ctx.esc(target)}">
        <div style="display:flex;gap:6px;margin-top:6px">
          <select data-role="pick" style="flex:1">${schema.map(l => `<option value="${ctx.esc(l.name)}">${ctx.esc(l.name)}</option>`).join('')}</select>
          <button data-role="assign" class="primary" ${schema.length ? '' : 'disabled'}>Assign</button>
        </div>
        <div data-role="assigned" style="margin-top:8px"></div>
      </div>`;

    const schemaHost = el.querySelector('[data-role="schema"]');
    if (!schema.length) schemaHost.innerHTML = '<div class="muted">No labels defined yet. Define one below, then assign it to files or folders.</div>';
    for (const label of schema) {
      const row = document.createElement('div');
      row.className = 'pm-wire-row';
      row.innerHTML = `<span class="label-chip" style="border-color:${label.color};color:${label.color}">${ctx.esc(label.name)}</span>
        <span class="muted">${label.assigned} assigned</span>
        <button class="danger" title="Delete this label everywhere">✕</button>`;
      row.querySelector('button').onclick = async () => {
        if (!confirm(`Delete label '${label.name}' and remove it from ${label.assigned} path(s)?`)) return;
        await ctx.request('/api/labels', { method: 'POST', body: JSON.stringify({ name: label.name, remove: true }) })
          .catch(e => ctx.notify(e.message, 'error'));
        ctx.bus.emit('labels-changed');
        paint();
      };
      schemaHost.append(row);
    }

    const assignedHost = el.querySelector('[data-role="assigned"]');
    for (const a of assigned) {
      const chip = document.createElement('span');
      chip.className = 'label-chip';
      chip.style.borderColor = a.color; chip.style.color = a.color;
      chip.innerHTML = `${ctx.esc(a.label)} <span style="cursor:pointer" title="Remove">✕</span>`;
      chip.querySelector('span').onclick = async () => {
        await ctx.request('/api/path-labels', { method: 'POST',
          body: JSON.stringify({ rootPath: ctx.workspace.root_path, path: target, label: a.label, remove: true }) })
          .catch(e => ctx.notify(e.message, 'error'));
        ctx.bus.emit('labels-changed');
        paint();
      };
      assignedHost.append(chip, ' ');
    }

    el.querySelector('[data-role="define"]').onclick = async () => {
      const name = el.querySelector('[data-role="new-name"]').value.trim();
      if (!name) return;
      await ctx.request('/api/labels', { method: 'POST',
        body: JSON.stringify({ name, color: el.querySelector('[data-role="new-color"]').value }) })
        .catch(e => ctx.notify(e.message, 'error'));
      ctx.bus.emit('labels-changed');
      paint();
    };
    el.querySelector('[data-role="assign"]').onclick = async () => {
      const pathValue = el.querySelector('[data-role="target"]').value.trim();
      if (!pathValue) return ctx.notify('Pick a file in the tree or type a path.', 'error');
      try {
        await ctx.request('/api/path-labels', { method: 'POST',
          body: JSON.stringify({ rootPath: ctx.workspace.root_path, path: pathValue, label: el.querySelector('[data-role="pick"]').value }) });
        ctx.notify('Labeled.', 'ok');
        ctx.bus.emit('labels-changed');
        paint();
      } catch (error) { ctx.notify(`${error.data?.error || 'ERROR'}: ${error.message}`, 'error'); }
    };
  }
  const repaint = () => paint().catch(e => ctx.notify(e.message, 'error'));
  ctx.bus.on('selection', repaint);
  return repaint();
}
