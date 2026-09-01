// Contribution: the preserved bytes (last promoted version) beside the current
// working bytes, exact SHA-256 on both. No preserved version is an honest
// answer, never a fabricated pane.
export function mount(el, ctx) {
  async function paint() {
    const f = ctx.selection;
    if (!f) { el.innerHTML = '<div class="empty">Select a file to compare versions.</div>'; return; }
    const result = await ctx.action('diff', 'promoted-vs-current', { path: f.path, rootPath: ctx.workspace.root_path });
    // The promoted bytes come from the ledger via the diff service's rows
    // (everything that isn't an added line), not from a second disk read.
    const promotedText = result.promoted
      ? result.rows.filter(r => r.type !== 'add').map(r => r.text).join('\n')
      : null;
    const left = result.promoted
      ? `<div class="pane-label"><span>Preserved (promoted ${ctx.esc(result.promoted.created_at)})</span>
           <span class="mono">${ctx.esc(result.promoted.checksum.slice(0, 16))}…</span></div>
         <pre class="card mono" data-role="left"></pre>`
      : `<div class="pane-label"><span>Preserved</span></div>
         <div class="card muted">No promoted version exists yet — there is nothing preserved to show.</div>`;
    el.innerHTML = `
      <div class="dual">
        <div>${left}</div>
        <div>
          <div class="pane-label"><span>New (working)</span>
            <span class="mono">${ctx.esc(f.checksum.slice(0, 16))}…</span></div>
          <pre class="card mono" data-role="right"></pre>
        </div>
      </div>`;
    el.querySelector('[data-role="right"]').textContent = f.content;
    if (promotedText !== null) el.querySelector('[data-role="left"]').textContent = promotedText;
  }
  const repaint = () => paint().catch(e => ctx.notify(e.message, 'error'));
  ctx.bus.on('selection', repaint);
  ctx.bus.on('file-saved', repaint);
  return repaint();
}
