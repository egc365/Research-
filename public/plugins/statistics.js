export async function render(ctx) {
  const panel = ctx.panel;
  if (!ctx.rootPath) {
    panel.innerHTML = '<div class="empty">Add a workspace to see statistics.</div>';
    return;
  }
  const s = await ctx.api('workspace-summary', { rootPath: ctx.rootPath });
  const table = (title, rows, cols) => `
    <div class="card">
      <h3>${escapeHtml(title)}</h3>
      ${rows.length ? rows.map(row => `<div class="keyval"><div class="key">${escapeHtml(String(row[cols[0]]))}</div><div>${escapeHtml(String(row[cols[1]]))}</div></div>`).join('') : '<div class="muted">Nothing recorded yet.</div>'}
    </div>`;
  panel.innerHTML =
    table('Artifacts by state', s.byState, ['state','count']) +
    table('Events by type', s.events, ['event_type','count']) +
    table('Events by actor', s.actors, ['actor','count']) +
    `<div class="card"><h3>Recent promotions</h3>${s.promotions.length ? s.promotions.map(p => `<div class="keyval"><div class="key">${escapeHtml(p.created_at.slice(0,19))}</div><div>${escapeHtml(p.path)}</div></div>`).join('') : '<div class="muted">None yet.</div>'}</div>`;
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
