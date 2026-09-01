// Contribution: workspace counts and recent activity, computed from the
// ledger by the statistics service — never by re-reading files.
export function mount(el, ctx) {
  async function paint() {
    if (!ctx.workspace) { el.innerHTML = '<div class="empty">No workspace.</div>'; return; }
    const s = await ctx.action('statistics', 'workspace-summary', { rootPath: ctx.workspace.root_path });
    const table = (rows, keyName, countName = 'count') => rows.length
      ? rows.map(row => `<div class="keyval"><div class="key">${ctx.esc(row[keyName])}</div><div>${row[countName]}</div></div>`).join('')
      : '<div class="muted">Nothing yet.</div>';
    el.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px">
        <div class="card"><h3>Artifacts by state</h3>${table(s.byState, 'state')}</div>
        <div class="card"><h3>Events by type</h3>${table(s.events, 'event_type')}</div>
        <div class="card"><h3>Events by actor</h3>${table(s.actors, 'actor')}</div>
        <div class="card"><h3>Last promotions</h3>
          ${s.promotions.length ? s.promotions.map(p =>
            `<div class="keyval"><div class="key mono">${ctx.esc(p.created_at.slice(0, 16))}</div>
             <div class="mono">${ctx.esc(p.path.replace(ctx.workspace.root_path + '/', ''))}</div></div>`).join('')
          : '<div class="muted">No promotions yet.</div>'}
        </div>
      </div>`;
  }
  const repaint = () => paint().catch(e => ctx.notify(e.message, 'error'));
  ctx.bus.on('file-saved', repaint);
  ctx.bus.on('artifact-changed', repaint);
  return repaint();
}
