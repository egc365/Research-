export async function render(ctx) {
  if (!ctx.file) { ctx.panel.innerHTML = '<div class="empty">Select a file to bind provenance.</div>'; return; }
  const artifact = await ctx.api('current', { path:ctx.file.path });
  ctx.panel.innerHTML = `
    <div class="card">
      <h3>Harness provenance</h3>
      <div class="keyval"><div class="key">Run</div><div>${escapeHtml(artifact?.last_run_id || '—')}</div></div>
      <div class="keyval"><div class="key">Span</div><div>${escapeHtml(artifact?.last_span_id || '—')}</div></div>
      <div class="muted">This stores only locators. DeepSeek Harness remains the authoritative trajectory/session record.</div>
    </div>
    <div class="card">
      <h3>Bind run/span</h3>
      <div class="field"><label>Run or session ID</label><input id="runId" value="${escapeAttr(artifact?.last_run_id || '')}"></div>
      <div class="field"><label>Span / block ID</label><input id="spanId" value="${escapeAttr(artifact?.last_span_id || '')}"></div>
      <button id="bindTrace">Bind</button>
    </div>`;
  ctx.panel.querySelector('#bindTrace').onclick = async () => {
    const runId = ctx.panel.querySelector('#runId').value.trim();
    if (!runId) { ctx.notify('Run/session ID is required.', 'error'); return; }
    await ctx.api('bind', { path:ctx.file.path, runId, spanId:ctx.panel.querySelector('#spanId').value.trim() || null, actor:'human' });
    await ctx.refreshFile();
    ctx.notify('Trajectory locator bound.');
    await ctx.rerender();
  };
}
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const escapeAttr = value => escapeHtml(value).replace(/`/g,'&#96;');
