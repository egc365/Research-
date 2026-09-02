// Contribution: the two review verdicts, and nothing else. Accept and
// needs-more-work are record-only owner decisions against the selected card —
// they land in the event ledger and move nothing. Promotion deliberately does
// not live here; that is the promotion control's single job.
export function mount(el, ctx) {
  function paint() {
    if (!ctx.selection || !ctx.card) {
      el.innerHTML = '<div class="card"><div class="muted">Pick a card to record a verdict on it.</div></div>';
      return;
    }
    el.innerHTML = `
      <div class="card"><div class="muted mono">${ctx.esc(ctx.card.slice(0, 24))}</div>
        <div style="display:flex;gap:6px">
          <button data-role="accept" class="primary">Accept</button>
          <button data-role="needs">Needs more work</button>
        </div>
        <div class="muted" style="margin-top:6px">Record only — a decision moves and changes nothing.</div>
      </div>`;
    const decide = decision => async () => {
      const recorded = await ctx.request('/api/decision', {
        method: 'POST',
        body: JSON.stringify({ path: ctx.selection.path, card: ctx.card, decision, actor: 'human' })
      }).catch(e => { ctx.notify(`${e.data?.error || 'ERROR'}: ${e.message}`, 'error'); });
      if (recorded) { ctx.notify(`Recorded: ${decision}.`, 'ok'); ctx.bus.emit('decision', recorded); }
    };
    el.querySelector('[data-role="accept"]').onclick = decide('accept');
    el.querySelector('[data-role="needs"]').onclick = decide('needs-more-work');
  }
  ctx.bus.on('selection', paint);
  ctx.bus.on('card', paint);
  paint();
}
