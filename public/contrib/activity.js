// Contribution: workspace ledger activity, newest first. The list used to
// live in the inbox. Honors the shared actor-filter contribution.
export function mount(el, ctx) {
  let actor = null;
  async function paint() {
    if (!ctx.workspace) { el.innerHTML = '<div class="empty">No workspace.</div>'; return; }
    const rows = await ctx.action('registry', 'recent', {
      rootPath: ctx.workspace.root_path,
      limit: 40,
      actor
    });
    el.innerHTML = `<div class="card"><h3>Activity${actor ? ` — actor: ${ctx.esc(actor)}` : ''}</h3>
      <div data-role="items"></div></div>`;
    const host = el.querySelector('[data-role="items"]');
    if (!rows.length) {
      host.innerHTML = '<div class="muted">No activity yet.</div>';
      return;
    }
    for (const event of rows) {
      const item = document.createElement('div');
      item.className = 'side-row';
      item.innerHTML = `
        <span class="grow" title="${ctx.esc(event.path)}">${ctx.esc((event.path || '').split('/').pop())}</span>
        <span class="aux">${ctx.esc(event.event_type + ' · ' + event.actor)}</span>`;
      item.onclick = () => ctx.selectFile(event.path).catch(e => ctx.notify(e.message, 'error'));
      host.append(item);
    }
  }
  const repaint = () => paint().catch(e => ctx.notify(e.message, 'error'));
  ctx.bus.on('file-saved', repaint);
  ctx.bus.on('artifact-changed', repaint);
  ctx.bus.on('fs-changed', repaint);
  ctx.bus.on('workspace', repaint);
  ctx.bus.on('actor-filter', value => { actor = value; repaint(); });
  repaint();
}
