// Contribution: the registry row for the selected file — lifecycle state,
// exact SHA-256, run/span identifiers, timestamps — plus run/span binding.
export function mount(el, ctx) {
  async function paint() {
    const f = ctx.selection;
    if (!f) { el.innerHTML = '<div class="empty">Select a file to see where it came from.</div>'; return; }
    const artifact = await ctx.action('trajectory', 'current', { path: f.path });
    if (!artifact) { el.innerHTML = '<div class="card"><h3>Provenance</h3><div class="muted">Not registered yet.</div></div>'; return; }
    el.innerHTML = `
      <div class="card"><h3>Provenance</h3>
        <div class="keyval"><div class="key">Path</div><div class="mono">${ctx.esc(artifact.path)}</div></div>
        <div class="keyval"><div class="key">State</div><div><span class="badge ${ctx.esc(artifact.state)}">${ctx.esc(artifact.state)}</span></div></div>
        <div class="keyval"><div class="key">SHA-256</div><div class="mono">${ctx.esc(artifact.checksum || '—')}</div></div>
        ${artifact.promoted_checksum ? `<div class="keyval"><div class="key">Promoted</div><div class="mono">${ctx.esc(artifact.promoted_checksum)}</div></div>` : ''}
        <div class="keyval"><div class="key">Run</div><div class="mono">${ctx.esc(artifact.last_run_id || '—')}</div></div>
        <div class="keyval"><div class="key">Span</div><div class="mono">${ctx.esc(artifact.last_span_id || '—')}</div></div>
        <div class="keyval"><div class="key">Updated</div><div class="mono">${ctx.esc(artifact.updated_at)}</div></div>
        <div style="display:flex;gap:6px;margin-top:8px">
          <input data-role="run" placeholder="run id" style="flex:1">
          <input data-role="span" placeholder="span id" style="flex:1">
          <button data-role="bind">Bind</button>
        </div>
      </div>`;
    el.querySelector('[data-role="bind"]').onclick = async () => {
      const runId = el.querySelector('[data-role="run"]').value;
      if (!runId) return ctx.notify('A run id is required to bind.', 'error');
      await ctx.action('trajectory', 'bind', {
        path: f.path, runId, spanId: el.querySelector('[data-role="span"]').value || null, actor: 'human'
      }).catch(e => ctx.notify(e.message, 'error'));
      ctx.notify('Trace bound.', 'ok');
      paint();
    };
  }
  const repaint = () => paint().catch(e => ctx.notify(e.message, 'error'));
  ctx.bus.on('selection', repaint);
  ctx.bus.on('file-saved', repaint);
  ctx.bus.on('artifact-changed', repaint);
  return repaint();
}
