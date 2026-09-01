// Contribution: expandable workspace tree. Selecting a file broadcasts the
// kernel selection every other contribution listens to.
export async function mount(el, ctx) {
  el.innerHTML = '<div class="card"><h3>Workspace</h3><div data-role="tree"></div></div>';
  const tree = el.querySelector('[data-role="tree"]');

  async function loadDirectory(relativePath, container) {
    const entries = await ctx.request(`/api/tree?root=${encodeURIComponent(ctx.workspace.root_path)}&path=${encodeURIComponent(relativePath)}`);
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'tree-row';
      row.dataset.path = entry.path;
      row.textContent = (entry.type === 'directory' ? '▸ ' : '· ') + entry.name;
      container.append(row);
      if (entry.type === 'directory') {
        let child = null;
        row.onclick = async event => {
          event.stopPropagation();
          if (child) { child.remove(); child = null; row.textContent = '▸ ' + entry.name; return; }
          child = document.createElement('div');
          child.className = 'tree-children';
          row.after(child);
          row.textContent = '⌄ ' + entry.name;
          await loadDirectory(entry.relativePath, child).catch(e => ctx.notify(e.message, 'error'));
        };
      } else {
        row.onclick = event => {
          event.stopPropagation();
          ctx.selectFile(entry.path).catch(e => ctx.notify(e.message, 'error'));
        };
      }
    }
  }

  function markSelected() {
    el.querySelectorAll('.tree-row.selected').forEach(n => n.classList.remove('selected'));
    if (ctx.selection) el.querySelector(`.tree-row[data-path="${CSS.escape(ctx.selection.path)}"]`)?.classList.add('selected');
  }

  if (!ctx.workspace) { tree.innerHTML = '<div class="empty">No workspace.</div>'; return; }
  await loadDirectory('.', tree);
  markSelected();
  ctx.bus.on('selection', markSelected);
}
