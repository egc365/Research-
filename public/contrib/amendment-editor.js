// Contribution: write an amendment against the selected card. Every save is
// rev N+1 in an append-only log; the document itself is never touched here.
// The textarea prefills with the card's latest amendment (or its original
// text) so amending is an edit, not a retype. Verdicts live in the separate
// decision-controls contribution.
export function mount(el, ctx) {
  let prefill = '';

  function paint() {
    if (!ctx.selection) { el.innerHTML = '<div class="empty">Select a file, then a card.</div>'; return; }
    if (!ctx.card) { el.innerHTML = '<div class="card"><h3>Amendment</h3><div class="muted">Pick a card to amend it.</div></div>'; return; }
    el.innerHTML = `
      <div class="card"><h3>Amendment — <span class="mono">${ctx.esc(ctx.card.slice(0, 24))}</span></h3>
        <textarea data-role="body" rows="6" style="width:100%" placeholder="Amended text for this card…"></textarea>
        <input data-role="note" style="width:100%;margin-top:6px" placeholder="Reason for this amendment (kept in the revision log)">
        <div style="display:flex;gap:6px;margin-top:8px">
          <button data-role="save" class="primary">Save amendment</button>
        </div>
        <div class="muted" style="margin-top:6px">Each save appends rev N+1; earlier revisions are never rewritten or dropped.</div>
      </div>`;
    el.querySelector('[data-role="body"]').value = prefill;
    el.querySelector('[data-role="save"]').onclick = async () => {
      const body = el.querySelector('[data-role="body"]').value;
      if (!body) return ctx.notify('Amendment body is empty.', 'error');
      const saved = await ctx.request('/api/amendments', {
        method: 'POST',
        body: JSON.stringify({ path: ctx.selection.path, card: ctx.card, body,
          note: el.querySelector('[data-role="note"]').value || null, actor: 'human' })
      }).catch(e => { ctx.notify(`${e.data?.error || 'ERROR'}: ${e.message}`, 'error'); });
      if (saved) {
        prefill = body;
        ctx.notify(`Amendment saved as rev ${saved.rev} — earlier revisions are still in the log.`, 'ok');
        ctx.bus.emit('amendment', saved);
      }
    };
  }
  ctx.bus.on('selection', () => { prefill = ''; paint(); });
  ctx.bus.on('card', paint);
  ctx.bus.on('card-text', ({ card, text }) => { if (card === ctx.card) { prefill = text; paint(); } });
  paint();
}
