// Contribution: Tempo span lanes from :8885. Iframe of the live app by default;
// URL overridable via wiring config { url }. Up/down via the tool-health service.
export function mount(el, ctx) {
  let timer = null;
  let disposed = false;
  const url = String(ctx.config?.url || 'http://127.0.0.1:8885/');

  const chip = r => r.ok
    ? `<span class="state-badge" style="background:#1d3a24;color:#7fd794">up · ${r.status} · ${r.ms}ms</span>`
    : `<span class="state-badge" style="background:#3a1d1d;color:#e08f8f">down · ${ctx.esc(String(r.error))}</span>`;

  el.innerHTML = `
    <div class="card">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px">
        <a href="${ctx.esc(url)}" target="_blank" rel="noopener">Trace lanes</a>
        <span data-role="chip">${chip({ ok: false, error: 'checking' })}</span>
      </div>
      <iframe src="${ctx.esc(url)}" title="Trace lanes" style="width:100%;min-height:70vh;border:0" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>
    </div>`;

  async function paint() {
    let probe = { ok: false, error: 'unchecked' };
    try {
      const { results } = await ctx.action('tool-health', 'check', { targets: [{ label: 'Trace lanes', url }] });
      probe = results?.[0] || { ok: false, error: 'no result' };
    } catch (error) {
      probe = { ok: false, error: error.message };
    }
    if (disposed) return;
    const slot = el.querySelector('[data-role="chip"]');
    if (slot) slot.innerHTML = chip(probe);
  }

  const repaint = () => paint().catch(error => {
    if (disposed) return;
    const slot = el.querySelector('[data-role="chip"]');
    if (slot) slot.innerHTML = chip({ ok: false, error: error.message });
  });
  timer = setInterval(repaint, 30000);
  repaint();
  return () => { disposed = true; clearInterval(timer); };
}
