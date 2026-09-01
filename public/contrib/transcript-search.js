// Contribution: transcript deep search — the pre-trace block-review spec.
// Pick a bot first (that cuts the session list to that provider), optionally a
// session, then filter by text, role, kind and local date range.
export function mount(el, ctx) {
  let catalog = null;
  let provider = null;

  el.innerHTML = `
    <div class="card">
      <h3>Transcript search</h3>
      <div data-role="bots" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:6px;margin-bottom:8px">
        <select data-f="session"><option value="">— all recent sessions —</option></select>
        <input data-f="query" placeholder="search text…">
        <input data-f="role" placeholder="role (user/assistant)">
        <input data-f="kind" placeholder="kind (type field)">
        <input data-f="dateFrom" type="date" title="date from">
        <input data-f="dateTo" type="date" title="date to">
        <input data-f="limit" type="number" value="50" min="1" max="200" title="per page">
        <button data-role="go" class="primary">search</button>
      </div>
      <div data-role="status" class="muted">Pick a bot first — that cuts the session list to that provider.</div>
      <div data-role="results"></div>
    </div>`;

  const $$ = sel => el.querySelector(sel);
  const field = name => $$(`[data-f="${name}"]`).value.trim();

  function paintBots() {
    const bar = $$('[data-role="bots"]');
    bar.replaceChildren();
    for (const p of catalog.providers) {
      const button = document.createElement('button');
      button.textContent = `${p.provider} (${p.rootExists ? p.sessionCount : 'no root'})`;
      button.className = p.provider === provider ? 'primary' : '';
      button.disabled = !p.rootExists;
      button.onclick = () => { provider = p.provider; paintBots(); paintSessions(); };
      bar.append(button);
    }
  }

  function paintSessions() {
    const select = $$('[data-f="session"]');
    select.length = 1;
    const rows = catalog.providers.find(p => p.provider === provider)?.sessions || [];
    for (const s of rows) {
      const option = document.createElement('option');
      option.value = s.path;
      option.textContent = `${s.name} · ${new Date(s.mtimeMs).toISOString().slice(0, 16)}`;
      select.append(option);
    }
    $$('[data-role="status"]').textContent = `${rows.length} sessions listed for ${provider}.`;
  }

  async function search() {
    if (!provider) return ctx.notify('Pick a bot first.', 'error');
    $$('[data-role="status"]').textContent = 'Searching…';
    const payload = {
      provider, session: field('session') || null, query: field('query'),
      role: field('role') || null, kind: field('kind') || null,
      dateFrom: field('dateFrom') || null, dateTo: field('dateTo') || null,
      limit: Number(field('limit')) || 50
    };
    const { results, scanned } = await ctx.action('transcript-search', 'search', payload);
    $$('[data-role="status"]').textContent = `${results.length} hits across ${scanned} session file(s). Unselected-session scans cover only the newest 12 — the FTS index is a deferred extension.`;
    $$('[data-role="results"]').innerHTML = results.map(r => `
      <div class="keyval" style="align-items:start">
        <div class="key mono" style="min-width:180px">${ctx.esc(r.session)}<br>
          <span class="muted">${ctx.esc(String(r.timestamp || '').slice(0, 19))} · ${ctx.esc(r.role || '?')} · ${ctx.esc(r.kind || '?')} · L${r.line}</span></div>
        <div class="mono" style="white-space:pre-wrap;word-break:break-word">${ctx.esc(r.snippet)}</div>
      </div>`).join('') || '<div class="muted">No hits.</div>';
  }

  $$('[data-role="go"]').onclick = () => search().catch(error => ctx.notify(error.message, 'error'));
  ctx.action('transcript-search', 'catalog', {})
    .then(data => { catalog = data; paintBots(); })
    .catch(error => { $$('[data-role="status"]').textContent = `Catalog failed: ${error.message}`; });
}
