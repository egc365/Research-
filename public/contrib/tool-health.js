// Contribution: tool / port health board. The probe list is the same list the
// launchpad renders — the built-in programs plus this workspace's `links`
// preference — so adding a link in one place adds it to both. Extra targets
// can also arrive through wiring config: { targets: [{label,url}] }.
const PROGRAM_DEFAULTS = [
  { label: 'Research Ops (owner)', url: 'http://127.0.0.1:8787/api/surface' },
  { label: 'Research Ops (agent)', url: 'http://127.0.0.1:8788/api/surface' },
  { label: 'Extraction app', url: 'http://127.0.0.1:7860' },
  { label: 'EPUB extract', url: 'http://127.0.0.1:7861' },
  { label: 'Extraction review', url: 'http://127.0.0.1:7870' },
  { label: 'Promotion center', url: 'http://127.0.0.1:8860' },
  { label: 'Revision center', url: 'http://127.0.0.1:8880' }
];

export function mount(el, ctx) {
  let timer = null;
  let disposed = false;

  async function targets() {
    const configured = Array.isArray(ctx.config?.targets) ? ctx.config.targets : [];
    let links = [];
    try {
      const root = ctx.workspace ? `?root=${encodeURIComponent(ctx.workspace.root_path)}` : '';
      const prefs = await ctx.request(`/api/ui-preferences${root}`);
      links = Array.isArray(prefs.workspace?.links) ? prefs.workspace.links : [];
    } catch { /* prefs are optional for probing */ }
    const seen = new Set();
    return [...configured, ...PROGRAM_DEFAULTS, ...links].filter(t => {
      if (!t?.url || seen.has(t.url)) return false;
      seen.add(t.url);
      return true;
    });
  }

  async function paint() {
    const list = await targets();
    const { checkedAt, results } = await ctx.action('tool-health', 'check', { targets: list });
    if (disposed) return;
    const chip = r => r.ok
      ? `<span class="state-badge" style="background:#1d3a24;color:#7fd794">up · ${r.status} · ${r.ms}ms</span>`
      : `<span class="state-badge" style="background:#3a1d1d;color:#e08f8f">down · ${ctx.esc(String(r.error))}</span>`;
    el.innerHTML = `
      <div class="card">
        <h3>Tool health <span class="muted" style="font-weight:normal">checked ${ctx.esc(checkedAt.slice(11, 19))}Z · <a href="#" data-role="refresh">refresh</a></span></h3>
        ${results.map(r => `
          <div class="keyval">
            <div class="key">${ctx.esc(r.label)}</div>
            <div><span class="mono muted">${ctx.esc(r.url)}</span> ${chip(r)}</div>
          </div>`).join('') || '<div class="muted">No targets. Add links in workspace preferences.</div>'}
        <div class="muted" style="margin-top:6px">Probe list = built-in programs + this workspace’s links preference. Loopback only.</div>
      </div>`;
    el.querySelector('[data-role="refresh"]').onclick = event => { event.preventDefault(); repaint(); };
  }

  const repaint = () => paint().catch(error => { if (!disposed) el.innerHTML = `<div class="muted">Tool health failed: ${ctx.esc(error.message)}</div>`; });
  timer = setInterval(repaint, 30000);
  repaint();
  return () => { disposed = true; clearInterval(timer); };
}
