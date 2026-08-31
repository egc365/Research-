export async function render(ctx) {
  const panel = ctx.panel;
  const runId = ctx.file?.artifact?.last_run_id || '';
  panel.innerHTML = `
    <div class="card">
      <h3>Execution state (Σ)</h3>
      <div class="muted">Per-run structured state. Agents propose JSON patches (null deletes a key); the runtime validates, merges, and versions. Reasoning traces are never stored here.</div>
      <div class="field"><label>Run ID</label><input id="execRunId" value="${escapeAttr(runId)}"></div>
      <button id="execLoad">Load</button>
      <pre id="execState" class="muted" style="white-space:pre-wrap"></pre>
    </div>`;
  panel.querySelector('#execLoad').onclick = async () => {
    const id = panel.querySelector('#execRunId').value.trim();
    if (!id) { ctx.notify('Run ID is required.', 'error'); return; }
    try {
      const row = await ctx.api('get', { runId: id });
      panel.querySelector('#execState').textContent = row
        ? `version ${row.state_version} · ${row.updated_at}\nskill: ${row.skill_path || '—'}\n\n${JSON.stringify(row.state, null, 2)}`
        : 'No execution state for this run.';
    } catch (error) { ctx.notify(error.message, 'error'); }
  };
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const escapeAttr = value => escapeHtml(value).replace(/`/g,'&#96;');
