// Sidebar section: Favorites — files and folders starred in the tree, pinned
// here for one-click access. The list lives in workspace-scope ui-preferences
// (workspace.favorites, absolute paths). Removing a star merge-patches the
// list back and announces 'prefs-changed'; clicking a row selects the file,
// or reveals it in the tree when selection fails (folders).
export async function mount(el, ctx) {
  async function paint() {
    if (!ctx.workspace) { el.innerHTML = '<div class="muted">No workspace.</div>'; return; }
    const prefs = await ctx.request(`/api/ui-preferences?root=${encodeURIComponent(ctx.workspace.root_path)}`);
    const favorites = Array.isArray(prefs?.workspace?.favorites) ? prefs.workspace.favorites : [];
    el.replaceChildren();
    if (!favorites.length) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.textContent = 'Star files or folders in the tree (☆) to pin them here.';
      el.append(empty);
      return;
    }
    for (const path of favorites) {
      const row = document.createElement('div');
      row.className = 'side-row';
      row.title = path;
      row.innerHTML = `<span>★</span><span class="grow">${ctx.esc(path.split('/').pop() || path)}</span>`;
      const remove = document.createElement('button');
      remove.className = 'tree-add';
      remove.textContent = '✕';
      remove.title = `Unstar ${path}`;
      remove.onclick = async event => {
        event.stopPropagation();
        try {
          await ctx.request('/api/ui-preferences', {
            method: 'POST',
            body: JSON.stringify({
              rootPath: ctx.workspace.root_path,
              patch: { favorites: favorites.filter(p => p !== path) }
            })
          });
          ctx.bus.emit('prefs-changed');
        } catch (error) {
          ctx.notify(`${error.data?.error || 'ERROR'}: ${error.message}`, 'error');
        }
      };
      row.append(remove);
      row.onclick = () => ctx.selectFile(path).catch(() => ctx.bus.emit('reveal-path', { path }));
      el.append(row);
    }
  }
  const repaint = () => paint().catch(e => ctx.notify(e.message, 'error'));
  ctx.bus.on('prefs-changed', repaint);
  ctx.bus.on('workspace', repaint);
  await paint();
}
