// Contribution: Notion-style card view of one folder. The folder comes from
// the contribution config (`path`, relative to the workspace root, default '.').
// Each entry is a .folder-card: name with a folder/file glyph, that path's
// label chips from the SQLite crosswalk, and the relative path when it adds
// information. Clicking a directory asks the tree to reveal it; clicking a
// file broadcasts the kernel selection.
export async function mount(el, ctx) {
  async function paint() {
    if (!ctx.workspace) { el.innerHTML = '<div class="empty">No workspace.</div>'; return; }
    const folder = ctx.config?.path || '.';
    const root = ctx.workspace.root_path;
    const [entries, labels] = await Promise.all([
      ctx.request(`/api/tree?root=${encodeURIComponent(root)}&path=${encodeURIComponent(folder)}`),
      ctx.request(`/api/path-labels?root=${encodeURIComponent(root)}`).catch(() => ({}))
    ]);
    el.innerHTML = `
      <div class="card"><h3>${ctx.esc(ctx.workspace.label || 'Workspace')}</h3>
        <div class="folder-cards" data-role="grid"></div>
      </div>`;
    const grid = el.querySelector('[data-role="grid"]');
    if (!entries.length) { grid.innerHTML = '<div class="muted">This folder is empty.</div>'; return; }
    for (const entry of entries) {
      const isDir = entry.type === 'directory';
      const card = document.createElement('div');
      card.className = 'folder-card';
      const chips = (labels[entry.path] || []).map(a =>
        `<span class="label-chip" style="border-color:${a.color};color:${a.color}">${ctx.esc(a.label)}</span>`).join('');
      const showPath = entry.relativePath && entry.relativePath !== entry.name;
      card.innerHTML = `
        <div class="name">${isDir ? '📁 ' : '📄 '}${ctx.esc(entry.name)}</div>
        ${chips}
        ${showPath ? `<div class="muted mono">${ctx.esc(entry.relativePath)}</div>` : ''}`;
      card.onclick = () => {
        if (isDir) ctx.bus.emit('reveal-path', { path: entry.path });
        else ctx.selectFile(entry.path).catch(e => ctx.notify(e.message, 'error'));
      };
      grid.append(card);
    }
  }
  const repaint = () => paint().catch(e => ctx.notify(e.message, 'error'));
  ctx.bus.on('fs-changed', repaint);
  ctx.bus.on('labels-changed', repaint);
  ctx.bus.on('workspace', repaint);
  await paint();
}
