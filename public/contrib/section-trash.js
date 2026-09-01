// Contribution: sidebar Trash section. Lists what /api/fs/delete moved into the
// workspace trash and restores an entry to its original spot through the
// governed restore path. Rows show the original basename; hover reveals where
// the entry came from.
export function mount(el, ctx) {
  async function paint() {
    if (!ctx.workspace) { el.innerHTML = '<div class="muted">No workspace.</div>'; return; }
    const entries = await ctx.request(`/api/fs/trash?root=${encodeURIComponent(ctx.workspace.root_path)}`);
    el.replaceChildren();
    if (!entries.length) {
      el.innerHTML = '<div class="muted">Trash is empty.</div>';
      return;
    }
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'side-row';
      const displayName = entry.from
        ? entry.from.split('/').pop()
        : entry.name.replace(/^[0-9TZ-]+-/, '');
      const name = document.createElement('span');
      name.className = 'grow';
      name.title = 'was: ' + (entry.from || 'unknown origin');
      name.textContent = `🗑 ${displayName}`;
      row.append(name);

      const restore = document.createElement('button');
      restore.className = 'tree-add';
      restore.style.visibility = 'visible';
      restore.textContent = 'restore';
      restore.title = `Restore ${displayName} to its original path`;
      restore.onclick = async () => {
        try {
          const result = await ctx.request('/api/fs/restore', {
            method: 'POST',
            body: JSON.stringify({ rootPath: ctx.workspace.root_path, path: entry.path })
          });
          ctx.notify(`Restored: ${result.path}`, 'ok');
          ctx.bus.emit('fs-changed', { path: result.path, kind: 'restore' });
        } catch (e) {
          ctx.notify(e.data?.message || e.message, 'error');
        }
      };
      row.append(restore);
      el.append(row);
    }
  }
  const repaint = () => paint().catch(e => ctx.notify(e.message, 'error'));
  ctx.bus.on('fs-changed', repaint);
  ctx.bus.on('workspace', repaint);
  repaint();
}
