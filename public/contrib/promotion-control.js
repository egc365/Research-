// Contribution: governed lifecycle controls, in validation language. Getting
// validated requires deterministic validator receipts (the server mints
// them). "Promote" is the one place that word appears: validated bytes →
// promoted authority, human-only, exact SHA frozen. Errors surface verbatim.
export function mount(el, ctx) {
  let lastNote = null; // survives the repaint a state change triggers
  async function paint() {
    const f = ctx.selection;
    if (!f) { el.innerHTML = '<div class="empty">Select a file to govern it.</div>'; return; }
    const card = await ctx.action('governance', 'card', { path: f.path });
    const state = card.artifact?.state || 'working';
    // Deterministic on the way up: one Submit verb runs working → candidate →
    // validated, receipts deciding the outcome. Only the deliberate owner
    // decisions (promote, supersede, archive) get their own buttons; the raw
    // transition table hides behind a manual override.
    const next = {
      working: [['submit', 'Submit for validation']],
      candidate: [['submit', 'Re-run validation']],
      validated: [['promoted', 'Promote (human, freezes bytes)']],
      promoted: [['superseded', 'Mark superseded']],
      superseded: [['archived', 'Archive']],
      archived: []
    }[state] || [];
    const overrides = {
      candidate: [['working', 'Back to working']],
      validated: [['candidate', 'Back to candidate']]
    }[state] || [];
    el.innerHTML = `
      <div class="card"><h3>Validation</h3>
        <div class="muted" style="margin-bottom:6px">Governs this app's own artifact registry. The book promotion center at :8860 is a separate system.</div>
        <div class="keyval"><div class="key">State</div><div><span class="badge ${ctx.esc(state)}">${ctx.esc(state)}</span></div></div>
        ${card.promoted ? `<div class="keyval"><div class="key">Frozen</div><div class="mono">${ctx.esc(card.promoted.checksum.slice(0, 16))}… · ${ctx.esc(card.promoted.created_at)}</div></div>` : ''}
        ${card.validatedAt ? `<div class="keyval"><div class="key">Validated</div><div class="mono">${ctx.esc(card.validatedAt)}</div></div>` : ''}
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px" data-role="buttons"></div>
        <div data-role="result" class="muted" style="margin-top:6px">${lastNote ? ctx.esc(lastNote) : ''}</div>
        ${overrides.length ? '<details style="margin-top:6px"><summary class="muted" style="cursor:pointer;font-size:12px">Manual override</summary><div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px" data-role="overrides"></div></details>' : ''}
      </div>`;
    const result = el.querySelector('[data-role="result"]');
    const done = async (state, note) => {
      ctx.notify(note, state === 'candidate' ? 'error' : 'ok');
      await ctx.refreshSelection();
      ctx.bus.emit('artifact-changed', { path: f.path, state });
      paint();
    };
    const showError = error => {
      result.textContent = `${error.data?.error || 'ERROR'}: ${error.message}`;
      ctx.notify(`${error.data?.error || 'ERROR'}: ${error.message}`, 'error');
    };
    const actionButton = (host, [verb, label], primary) => {
      const button = document.createElement('button');
      if (primary) button.className = 'primary';
      button.textContent = label;
      button.onclick = async () => {
        try {
          lastNote = null;
          if (verb === 'submit') {
            const outcome = await ctx.action('governance', 'submit', { path: f.path, actor: 'human' });
            if (outcome.state === 'validated') { await done('validated', 'Validated — receipts minted.'); return; }
            // The receipts are the answer: candidate it stays, and here is why.
            const failed = (outcome.validation.results || []).filter(r => r.ok === false);
            lastNote = `Validation failed: ${failed.map(r => r.plugin).join(', ') || 'see receipts'}`;
            await done('candidate', 'Validation failed — still a candidate.');
            return;
          }
          await ctx.action('governance', 'transition', { path: f.path, toState: verb, actor: 'human' });
          await done(verb, `Now ${verb}.`);
        } catch (error) { showError(error); }
      };
      host.append(button);
    };
    const buttons = el.querySelector('[data-role="buttons"]');
    for (const entry of next) actionButton(buttons, entry, entry[0] === 'promoted' || entry[0] === 'submit');
    if (!next.length) buttons.innerHTML = '<span class="muted">Terminal state.</span>';
    const overrideHost = el.querySelector('[data-role="overrides"]');
    if (overrideHost) for (const entry of overrides) actionButton(overrideHost, entry, false);
  }
  const repaint = () => paint().catch(e => ctx.notify(e.message, 'error'));
  ctx.bus.on('selection', repaint);
  ctx.bus.on('file-saved', repaint);
  ctx.bus.on('artifact-changed', repaint);
  return repaint();
}
