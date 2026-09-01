// Contribution: registered artifacts grouped by lifecycle state, straight
// from the registry service. Clicking a row selects the file everywhere.
const order = ['candidate', 'validated', 'working', 'promoted', 'superseded', 'archived'];

export function mount(el, ctx) {
  async function paint() {
    if (!ctx.workspace) { el.innerHTML = '<div class="empty">No workspace.</div>'; return; }
    const rows = await ctx.action('registry', 'list', { rootPath: ctx.workspace.root_path });
    el.innerHTML = '<div class="card"><h3>Registered artifacts</h3><div data-role="list"></div></div>';
    const host = el.querySelector('[data-role="list"]');
    if (!rows.length) { host.innerHTML = '<div class="muted">Nothing registered yet — open a file once to register it.</div>'; return; }
    for (const state of order) {
      const group = rows.filter(row => row.state === state);
      if (!group.length) continue;
      const head = document.createElement('div');
      head.innerHTML = `<span class="badge ${ctx.esc(state)}" style="margin:6px 0">${ctx.esc(state)} · ${group.length}</span>`;
      host.append(head);
      for (const row of group) {
        const item = document.createElement('div');
        item.className = 'tree-row' + (ctx.selection?.path === row.path ? ' selected' : '');
        item.dataset.path = row.path;
        item.textContent = row.path.replace(ctx.workspace.root_path + '/', '');
        item.title = `${row.path}\nsha256 ${row.checksum || '—'}`;
        item.onclick = () => ctx.selectFile(row.path).catch(e => ctx.notify(e.message, 'error'));
        host.append(item);
      }
    }
  }
  const repaint = () => paint().catch(e => ctx.notify(e.message, 'error'));
  ctx.bus.on('selection', () => {
    el.querySelectorAll('.tree-row').forEach(node =>
      node.classList.toggle('selected', node.dataset.path === ctx.selection?.path));
  });
  ctx.bus.on('file-saved', repaint);
  ctx.bus.on('artifact-changed', repaint);
  return repaint();
}
