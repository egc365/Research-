// Contribution: write an amendment against the selected card. Every save is
// rev N+1 in an append-only log; the document itself is never touched here.
// Decisions (accept | needs-more-work) are record-only owner verdicts.
export function mount(el, ctx) {
  function paint() {
    if (!ctx.selection) { el.innerHTML = '<div class="empty">Select a file, then a block card.</div>'; return; }
    if (!ctx.card) { el.innerHTML = '<div class="card"><h3>Amendment</h3><div class="muted">Pick a block card to amend it.</div></div>'; return; }
    el.innerHTML = `
      <div class="card"><h3>Amendment — <span class="mono">${ctx.esc(ctx.card)}</span></h3>
        <textarea data-role="body" rows="6" style="width:100%" placeholder="Amended text for this block…"></textarea>
        <input data-role="note" style="width:100%;margin-top:6px" placeholder="Why (optional note)">
        <div style="display:flex;gap:6px;margin-top:8px">
          <button data-role="save" class="primary">Save amendment</button>
          <button data-role="accept">Accept</button>
          <button data-role="needs">Needs more work</button>
        </div>
        <div class="muted" style="margin-top:6px">Amendments append rev N+1 and never rewrite. Decisions record only — they move and change nothing.</div>
      </div>`;
    el.querySelector('[data-role="save"]').onclick = async () => {
      const body = el.querySelector('[data-role="body"]').value;
      if (!body) return ctx.notify('Amendment body is empty.', 'error');
      const saved = await ctx.request('/api/amendments', {
        method: 'POST',
        body: JSON.stringify({ path: ctx.selection.path, card: ctx.card, body,
          note: el.querySelector('[data-role="note"]').value || null, actor: 'human' })
      }).catch(e => { ctx.notify(e.message, 'error'); });
      if (saved) { ctx.notify(`Amendment saved as rev ${saved.rev}.`, 'ok'); ctx.bus.emit('amendment', saved); }
    };
    const decide = decision => async () => {
      const recorded = await ctx.request('/api/decision', {
        method: 'POST',
        body: JSON.stringify({ path: ctx.selection.path, card: ctx.card, decision, actor: 'human' })
      }).catch(e => { ctx.notify(e.message, 'error'); });
      if (recorded) { ctx.notify(`Recorded: ${decision}.`, 'ok'); ctx.bus.emit('decision', recorded); }
    };
    el.querySelector('[data-role="accept"]').onclick = decide('accept');
    el.querySelector('[data-role="needs"]').onclick = decide('needs-more-work');
  }
  ctx.bus.on('selection', paint);
  ctx.bus.on('card', paint);
  paint();
}
