export async function render(ctx) {
  if (!ctx.file) { ctx.panel.innerHTML = '<div class="empty">Select a file to compare versions.</div>'; return; }
  const result = await ctx.api('promoted-vs-current', { path:ctx.file.path, rootPath:ctx.rootPath });
  if (!result.promoted) {
    ctx.panel.innerHTML = '<div class="card"><h3>Promoted snapshot</h3><div class="muted">No promoted version exists yet.</div></div>';
    return;
  }
  ctx.panel.innerHTML = `
    <div class="card"><h3>Promoted → working</h3>
      <div class="keyval"><div class="key">Promoted</div><div>${result.promoted.checksum.slice(0,16)}…</div></div>
      <div class="keyval"><div class="key">Working</div><div>${result.current.checksum.slice(0,16)}…</div></div>
    </div>
    <div class="card">${result.rows.map(row => `<div class="diff-row ${row.type}"><span class="mark">${row.type === 'add' ? '+' : row.type === 'remove' ? '−' : ' '}</span><span>${row.line}</span><span>${escapeHtml(row.text)}</span></div>`).join('')}</div>`;
}
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
