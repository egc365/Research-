// Contribution: the label manager. Occupies no screen space — it mounts a
// hidden host holding a <dialog>, and opens when anything on the bus asks
// ('open-labels' with the invoked path, from the tree's 🏷 or Labels… buttons).
// Labels are reusable metadata for files AND folders, stored in the SQLite
// crosswalk (labels, path_labels). Writes are owner-surface only; disabling
// this contribution removes the UI while every stored label survives.
export function mount(el, ctx) {
  el.innerHTML = `<dialog class="plugin-manager label-dialog">
    <div class="pm-head"><strong>Labels</strong><button data-role="close" type="button">Close</button></div>
    <div class="pm-body" data-role="body"></div>
  </dialog>`;
  const dialog = el.querySelector('dialog');
  const body = el.querySelector('[data-role="body"]');
  let target = null; // absolute path the dialog was opened for, or null

  const write = (url, payload) =>
    ctx.request(url, { method: 'POST', body: JSON.stringify(payload) })
      .then(result => { ctx.bus.emit('labels-changed'); return result; })
      .catch(error => { ctx.notify(`${error.data?.error || 'ERROR'}: ${error.message}`, 'error'); });

  async function paint() {
    const schema = await ctx.request('/api/labels');
    const byPath = ctx.workspace
      ? await ctx.request(`/api/path-labels?root=${encodeURIComponent(ctx.workspace.root_path)}`).catch(() => ({}))
      : {};
    const assigned = target ? (byPath[target] || []) : [];
    const assignedNames = new Set(assigned.map(a => a.label));
    const options = schema.filter(l => !assignedNames.has(l.name));

    body.innerHTML = `
      ${target ? `
      <div class="card"><h3>${ctx.esc(target.split('/').pop())}</h3>
        <div class="mono muted" style="word-break:break-all">${ctx.esc(target)}</div>
        <div data-role="assigned" style="margin:8px 0"></div>
        <div style="display:flex;gap:6px">
          <select data-role="pick" style="flex:1" ${options.length ? '' : 'disabled'}>
            ${options.map(l => `<option value="${ctx.esc(l.name)}">${ctx.esc(l.name)}</option>`).join('') || '<option>every label is already on it</option>'}
          </select>
          <button data-role="assign" class="primary" ${options.length ? '' : 'disabled'}>Add label</button>
        </div>
      </div>` : `
      <div class="card muted">Opened without a file or folder — manage the schema below,
        or use the advanced path field to designate any path.</div>`}

      <div class="card"><h3>Label schema</h3>
        <div data-role="schema"></div>
        <div class="label-new">
          <input data-role="new-name" placeholder="new label name">
          <input data-role="new-color" type="color" value="#4fa3ff" title="Color">
          <input data-role="new-desc" placeholder="description (optional)">
          <button data-role="define">Create</button>
        </div>
      </div>

      <details class="card"><summary>Advanced: designate a typed path</summary>
        <div style="display:flex;gap:6px;margin-top:8px">
          <input data-role="adv-path" class="mono" style="flex:2" placeholder="/absolute/path inside the workspace" value="${ctx.esc(target || '')}">
          <select data-role="adv-pick" style="flex:1">${schema.map(l => `<option value="${ctx.esc(l.name)}">${ctx.esc(l.name)}</option>`).join('')}</select>
          <button data-role="adv-assign" ${schema.length ? '' : 'disabled'}>Assign</button>
        </div>
      </details>`;

    const assignedHost = body.querySelector('[data-role="assigned"]');
    if (assignedHost) {
      if (!assigned.length) assignedHost.innerHTML = '<span class="muted">No labels on this path yet.</span>';
      for (const a of assigned) {
        const chip = document.createElement('span');
        chip.className = 'label-chip';
        chip.style.borderColor = a.color; chip.style.color = a.color;
        chip.innerHTML = `${ctx.esc(a.label)} <span style="cursor:pointer" title="Remove from this path">✕</span>`;
        chip.querySelector('span').onclick = async () => {
          await write('/api/path-labels', { rootPath: ctx.workspace.root_path, path: target, label: a.label, remove: true });
          paint();
        };
        assignedHost.append(chip, ' ');
      }
      body.querySelector('[data-role="assign"]')?.addEventListener('click', async () => {
        await write('/api/path-labels', { rootPath: ctx.workspace.root_path, path: target, label: body.querySelector('[data-role="pick"]').value });
        paint();
      });
    }

    const schemaHost = body.querySelector('[data-role="schema"]');
    if (!schema.length) schemaHost.innerHTML = '<div class="muted">No labels yet. Create one below.</div>';
    for (const label of schema) {
      const row = document.createElement('div');
      row.className = 'label-row';
      row.innerHTML = `
        <span class="label-chip" style="border-color:${label.color};color:${label.color}">${ctx.esc(label.name)}</span>
        <span class="muted">${label.assigned} path(s)</span>
        <input data-edit="desc" placeholder="description" value="${ctx.esc(label.description || '')}" title="Description — saved on change">
        <input data-edit="color" type="color" value="${ctx.esc(label.color)}" title="Color — saved on change">
        <button data-edit="rename" title="Rename this label everywhere">rename</button>
        <button data-edit="delete" class="danger" title="Delete this label everywhere">✕</button>`;
      // Update the row in place: a full repaint here would rebuild the dialog
      // body and destroy focus while tabbing between fields.
      const save = () => write('/api/labels', {
        name: label.name,
        color: row.querySelector('[data-edit="color"]').value,
        description: row.querySelector('[data-edit="desc"]').value || null
      }).then(result => {
        if (!result) return;
        const color = row.querySelector('[data-edit="color"]').value;
        const chip = row.querySelector('.label-chip');
        chip.style.borderColor = color; chip.style.color = color;
      });
      row.querySelector('[data-edit="desc"]').onchange = save;
      row.querySelector('[data-edit="color"]').onchange = save;
      row.querySelector('[data-edit="rename"]').onclick = async () => {
        const newName = prompt(`Rename label '${label.name}' to:`, label.name);
        if (!newName || newName === label.name) return;
        await write('/api/labels', { name: label.name, rename: newName });
        paint();
      };
      row.querySelector('[data-edit="delete"]').onclick = async () => {
        if (!confirm(`Delete label '${label.name}' and remove it from ${label.assigned} path(s)? The files themselves are untouched.`)) return;
        await write('/api/labels', { name: label.name, remove: true });
        paint();
      };
      schemaHost.append(row);
    }

    body.querySelector('[data-role="define"]').onclick = async () => {
      const name = body.querySelector('[data-role="new-name"]').value.trim();
      if (!name) return ctx.notify('Give the label a name.', 'error');
      await write('/api/labels', {
        name,
        color: body.querySelector('[data-role="new-color"]').value,
        description: body.querySelector('[data-role="new-desc"]').value || null
      });
      paint();
    };
    body.querySelector('[data-role="adv-assign"]')?.addEventListener('click', async () => {
      const typed = body.querySelector('[data-role="adv-path"]').value.trim();
      if (!typed) return ctx.notify('Type a path or open Labels from the tree.', 'error');
      await write('/api/path-labels', { rootPath: ctx.workspace.root_path, path: typed, label: body.querySelector('[data-role="adv-pick"]').value });
      paint();
    });
  }

  el.querySelector('[data-role="close"]').onclick = () => dialog.close();
  ctx.bus.on('open-labels', ({ path } = {}) => {
    target = path || null;
    paint().catch(e => ctx.notify(e.message, 'error'));
    if (!dialog.open) dialog.showModal();
  });
  return () => { if (dialog.open) dialog.close(); };
}
