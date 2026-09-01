// Contribution: governed lifecycle controls. Validated requires deterministic
// validator receipts (the server mints them); promoted requires a human and
// freezes the exact bytes. Errors surface verbatim — no state is faked.
export function mount(el, ctx) {
  async function paint() {
    const f = ctx.selection;
    if (!f) { el.innerHTML = '<div class="empty">Select a file to govern it.</div>'; return; }
    const card = await ctx.action('governance', 'card', { path: f.path });
    const state = card.artifact?.state || 'working';
    const next = {
      working: [['candidate', 'Make candidate']],
      candidate: [['validated', 'Validate (mints receipts)'], ['working', 'Back to working']],
      validated: [['promoted', 'Promote (human, freezes bytes)'], ['candidate', 'Back to candidate']],
      promoted: [['superseded', 'Mark superseded']],
      superseded: [['archived', 'Archive']],
      archived: []
    }[state] || [];
    el.innerHTML = `
      <div class="card"><h3>Promotion</h3>
        <div class="muted" style="margin-bottom:6px">Governs this app's own artifact registry. The book promotion center at :8860 is a separate system.</div>
        <div class="keyval"><div class="key">State</div><div><span class="badge ${ctx.esc(state)}">${ctx.esc(state)}</span></div></div>
        ${card.promoted ? `<div class="keyval"><div class="key">Frozen</div><div class="mono">${ctx.esc(card.promoted.checksum.slice(0, 16))}… · ${ctx.esc(card.promoted.created_at)}</div></div>` : ''}
        ${card.validatedAt ? `<div class="keyval"><div class="key">Validated</div><div class="mono">${ctx.esc(card.validatedAt)}</div></div>` : ''}
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px" data-role="buttons"></div>
        <div data-role="result" class="muted" style="margin-top:6px"></div>
      </div>`;
    const buttons = el.querySelector('[data-role="buttons"]');
    for (const [toState, label] of next) {
      const button = document.createElement('button');
      if (toState === 'promoted') button.className = 'primary';
      button.textContent = label;
      button.onclick = async () => {
        try {
          await ctx.action('governance', 'transition', { path: f.path, toState, actor: 'human' });
          ctx.notify(`Now ${toState}.`, 'ok');
          await ctx.refreshSelection();
          ctx.bus.emit('artifact-changed', { path: f.path, state: toState });
          paint();
        } catch (error) {
          el.querySelector('[data-role="result"]').textContent = `${error.data?.error || 'ERROR'}: ${error.message}`;
          ctx.notify(`${error.data?.error || 'ERROR'}: ${error.message}`, 'error');
        }
      };
      buttons.append(button);
    }
    if (!next.length) buttons.innerHTML = '<span class="muted">Terminal state.</span>';
  }
  const repaint = () => paint().catch(e => ctx.notify(e.message, 'error'));
  ctx.bus.on('selection', repaint);
  ctx.bus.on('file-saved', repaint);
  ctx.bus.on('artifact-changed', repaint);
  return repaint();
}
