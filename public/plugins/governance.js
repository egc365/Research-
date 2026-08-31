export async function render(ctx) {
  const panel = ctx.panel;
  if (!ctx.file) {
    panel.innerHTML = '<div class="empty">Select a file to inspect governance.</div>';
    return;
  }
  const card = await ctx.api('card', { path: ctx.file.path });
  const artifact = card.artifact || ctx.file.artifact;
  const state = artifact?.state || 'working';
  const next = {
    working:['candidate','archived'],
    candidate:['working','validated','archived'],
    validated:['candidate','promoted','archived'],
    promoted:['superseded','archived'],
    superseded:['archived'],
    archived:[]
  }[state] || [];

  const validation = card.validation;
  const checks = validation?.results?.flatMap(r => r.checks || []) || [];
  const passed = checks.filter(c => c.ok).length;
  const validationHtml = validation
    ? `<div class="keyval"><div class="key">Receipts</div><div>${passed} / ${checks.length} deterministic checks passed${card.validatedAt ? ` · ${escapeHtml(card.validatedAt)}` : ''}</div></div>
       <div class="keyval"><div class="key">On bytes</div><div>${escapeHtml((validation.checksum || '').slice(0,12))}…${validation.checksum && validation.checksum !== ctx.file.checksum ? ' <b>(current bytes differ — revalidate)</b>' : ''}</div></div>`
    : '<div class="muted">No validation receipts yet. Receipts are produced by server-side validators at the candidate → validated transition; they cannot be supplied by the caller.</div>';

  panel.innerHTML = `
    <div class="card">
      <h3>Artifact state</h3>
      <div class="keyval"><div class="key">Path</div><div>${escapeHtml(ctx.file.path)}</div></div>
      <div class="keyval"><div class="key">State</div><div>${escapeHtml(state)}</div></div>
      <div class="keyval"><div class="key">Checksum</div><div>${escapeHtml(ctx.file.checksum)}</div></div>
      <div class="keyval"><div class="key">Promoted</div><div>${escapeHtml(artifact?.promoted_checksum || '—')}</div></div>
      <div class="keyval"><div class="key">Run / span</div><div>${escapeHtml(artifact?.last_run_id || '—')}${artifact?.last_span_id ? ' · ' + escapeHtml(artifact.last_span_id) : ''}</div></div>
      <div class="keyval"><div class="key">Events</div><div>${card.eventCount ?? '—'}</div></div>
    </div>
    <div class="card">
      <h3>Validation</h3>
      ${validationHtml}
    </div>
    <div class="card">
      <h3>Promotion</h3>
      <div class="muted">Agents prepare and validate candidates on the agent surface. Promotion only exists here, on the owner surface, and freezes exact bytes.</div>
      <div class="actions" id="governanceActions"></div>
    </div>`;

  const actions = panel.querySelector('#governanceActions');
  for (const toState of next) {
    const button = document.createElement('button');
    button.textContent = toState === 'promoted' ? 'Promote' : toState[0].toUpperCase()+toState.slice(1);
    if (toState === 'promoted') button.classList.add('primary');
    if (toState === 'archived' || toState === 'superseded') button.classList.add('danger');
    button.onclick = async () => {
      if ((toState === 'promoted' || toState === 'archived') && !confirm(`${toState.toUpperCase()} ${ctx.file.path}?`)) return;
      try {
        await ctx.api('transition', { path:ctx.file.path, toState, actor:'human' });
        await ctx.refreshFile();
        ctx.notify(`Transitioned to ${toState}.`);
        await ctx.rerender();
      } catch (error) {
        const detail = error.data?.validation?.results?.find(r => r.ok === false)?.message;
        ctx.notify(detail ? `${error.message}: ${detail}` : error.message, 'error');
      }
    };
    actions.append(button);
  }
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
