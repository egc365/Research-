export async function render(ctx) {
  const panel = ctx.panel;
  if (!ctx.file) {
    panel.innerHTML = '<div class="empty">Select a file to inspect governance.</div>';
    return;
  }
  const artifact = ctx.file.artifact;
  const state = artifact?.state || 'working';
  const next = {
    working:['candidate','archived'],
    candidate:['working','validated','archived'],
    validated:['candidate','promoted','archived'],
    promoted:['superseded','archived'],
    superseded:['archived'],
    archived:[]
  }[state] || [];
  panel.innerHTML = `
    <div class="card">
      <h3>Artifact state</h3>
      <div class="keyval"><div class="key">Path</div><div>${escapeHtml(ctx.file.path)}</div></div>
      <div class="keyval"><div class="key">State</div><div>${escapeHtml(state)}</div></div>
      <div class="keyval"><div class="key">Checksum</div><div>${escapeHtml(ctx.file.checksum)}</div></div>
      <div class="keyval"><div class="key">Promoted</div><div>${escapeHtml(artifact?.promoted_checksum || '—')}</div></div>
      <div class="actions" id="governanceActions"></div>
    </div>
    <div class="card">
      <h3>Promotion rule</h3>
      <div class="muted">Agents may prepare and validate candidates. The API rejects promotion unless actor = human.</div>
    </div>`;
  const actions = panel.querySelector('#governanceActions');
  for (const toState of next) {
    const button = document.createElement('button');
    button.textContent = toState === 'promoted' ? 'Promote' : toState[0].toUpperCase()+toState.slice(1);
    if (toState === 'archived' || toState === 'superseded') button.classList.add('danger');
    button.onclick = async () => {
      if ((toState === 'promoted' || toState === 'archived') && !confirm(`${toState.toUpperCase()} ${ctx.file.path}?`)) return;
      try {
        await ctx.api('transition', { path:ctx.file.path, toState, actor:'human' });
        await ctx.refreshFile();
        ctx.notify(`Transitioned to ${toState}.`);
        await ctx.rerender();
      } catch (error) { ctx.notify(error.message, 'error'); }
    };
    actions.append(button);
  }
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
