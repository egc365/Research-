// Contribution: sidebar section listing the last touched artifacts from the
// registry event log. Each row is the basename (full path in the tooltip) with
// the event type and a trimmed timestamp; clicking selects the file.
export function mount(el, ctx) {
  async function paint() {
    if (!ctx.workspace) { el.innerHTML = '<div class="empty">No workspace.</div>'; return; }
    const rows = await ctx.action('registry', 'recent', { rootPath: ctx.workspace.root_path, limit: 8 });
    if (!rows.length) { el.innerHTML = '<div class="muted">No activity yet.</div>'; return; }
    el.replaceChildren();
    for (const row of rows) {
      const item = document.createElement('div');
      item.className = 'side-row';
      const name = row.path.split('/').pop();
      const stamp = (row.created_at || '').slice(5, 16).replace('T', ' ');
      item.innerHTML = `
        <span class="grow" title="${ctx.esc(row.path)}">${ctx.esc(name)}</span>
        <span class="aux">${ctx.esc((row.event_type || '').toLowerCase())} ${ctx.esc(stamp)}</span>`;
      item.onclick = () => ctx.selectFile(row.path).catch(e => ctx.notify(e.message, 'error'));
      el.append(item);
    }
  }
  const repaint = () => paint().catch(e => ctx.notify(e.message, 'error'));
  ctx.bus.on('file-saved', repaint);
  ctx.bus.on('artifact-changed', repaint);
  ctx.bus.on('fs-changed', repaint);
  ctx.bus.on('workspace', repaint);
  repaint();
}
