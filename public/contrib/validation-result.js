// Contribution: deterministic validator results for the selected file, check
// by check, plus the receipts frozen at its last validation.
export function mount(el, ctx) {
  async function paint() {
    const f = ctx.selection;
    if (!f) { el.innerHTML = '<div class="empty">Select a file to see its validation.</div>'; return; }
    const card = await ctx.action('governance', 'card', { path: f.path });
    const rules = await ctx.action('preflight', 'list', {});
    el.innerHTML = `
      <div class="card"><h3>Validation receipts</h3>
        ${card.validation
          ? `<div class="keyval"><div class="key">Result</div><div>${card.validation.ok ? '✓ passed' : '✗ failed'}</div></div>
             <div class="keyval"><div class="key">At bytes</div><div class="mono">${ctx.esc(card.validation.checksum || '—')}</div></div>
             <div data-role="checks"></div>`
          : '<div class="muted">Not validated yet. Receipts are minted by deterministic validators when a candidate is validated — never supplied by the caller.</div>'}
      </div>
      <div class="card"><h3>Active policy rules (${rules.filter(r => r.enabled).length})</h3>
        <div data-role="rules"></div>
      </div>`;
    const checks = el.querySelector('[data-role="checks"]');
    if (checks && card.validation?.results) {
      for (const result of card.validation.results) {
        const div = document.createElement('div');
        div.className = 'keyval';
        div.innerHTML = `<div class="key">${ctx.esc(result.plugin)}</div>
          <div>${result.ok ? '✓' : '✗'} ${(result.checks || []).length} check(s)${result.message ? ` — ${ctx.esc(result.message)}` : ''}</div>`;
        checks.append(div);
      }
    }
    const rulesHost = el.querySelector('[data-role="rules"]');
    for (const rule of rules) {
      const div = document.createElement('div');
      div.className = 'keyval';
      div.innerHTML = `<div class="key">${ctx.esc(rule.rule_type)}</div>
        <div class="mono ${rule.enabled ? '' : 'muted'}">${ctx.esc(rule.scope_path)}${rule.enabled ? '' : ' (off)'}</div>`;
      rulesHost.append(div);
    }
    if (!rules.length) rulesHost.innerHTML = '<div class="muted">No policy rules configured.</div>';
  }
  const repaint = () => paint().catch(e => ctx.notify(e.message, 'error'));
  ctx.bus.on('selection', repaint);
  ctx.bus.on('file-saved', repaint);
  ctx.bus.on('artifact-changed', repaint);
  return repaint();
}
