// Sidebar section: Projects — folders (or files) carrying the label 'project'.
// Reads the path-label crosswalk, keeps entries labeled 'project', and renders
// one compact .side-row per path, indented by depth. Clicking a row asks the
// tree to reveal that path.
export function mount(el, ctx) {
  async function paint() {
    if (!ctx.workspace) { el.innerHTML = '<div class="muted">No workspace.</div>'; return; }
    const root = ctx.workspace.root_path;
    const labels = await ctx.request(`/api/path-labels?root=${encodeURIComponent(root)}`).catch(() => ({}));
    const paths = Object.keys(labels)
      .filter(path => (labels[path] || []).some(a => a.label === 'project'))
      .sort();
    el.replaceChildren();
    if (!paths.length) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.textContent = "Label a folder 'project' (tree 🏷) to pin it here.";
      el.append(empty);
      return;
    }
    for (const path of paths) {
      const rel = path.slice(root.length + 1);
      const depth = rel.split('/').length - 1;
      const row = document.createElement('div');
      row.className = 'side-row';
      row.style.paddingLeft = (6 + depth * 12) + 'px';
      row.title = path;
      row.innerHTML = `<span class="grow">📁 ${ctx.esc(rel.split('/').pop())}</span>`;
      row.onclick = () => ctx.bus.emit('reveal-path', { path });
      el.append(row);
    }
  }
  const repaint = () => paint().catch(e => ctx.notify(e.message, 'error'));
  ctx.bus.on('labels-changed', repaint);
  ctx.bus.on('fs-changed', repaint);
  ctx.bus.on('workspace', repaint);
  repaint();
}
