// Contribution: inspect and patch a run's structured state (SKILL.state).
// Patches merge with null-deletion semantics under an optimistic version
// check; an invalid patch changes nothing.
export function mount(el, ctx) {
  let runId = '';
  el.innerHTML = `
    <div class="card" style="max-width:640px">
      <div style="display:flex;gap:6px">
        <input data-role="run" placeholder="run id" style="flex:1">
        <button data-role="load">Load</button>
        <button data-role="init">Init empty</button>
      </div>
      <pre data-role="state" class="mono card" style="margin-top:8px;white-space:pre-wrap"></pre>
      <div class="pane-label"><span>Patch (JSON object; null deletes a key)</span><span data-role="version" class="mono"></span></div>
      <textarea data-role="patch" rows="4" style="width:100%" placeholder='{"step": 3, "obsolete_key": null}'></textarea>
      <button data-role="apply" style="margin-top:6px">Apply patch</button>
      <div data-role="result" class="muted" style="margin-top:6px"></div>
    </div>`;
  const stateEl = el.querySelector('[data-role="state"]');
  const versionEl = el.querySelector('[data-role="version"]');
  const result = el.querySelector('[data-role="result"]');
  let currentVersion = null;

  async function load() {
    runId = el.querySelector('[data-role="run"]').value.trim();
    if (!runId) return;
    const record = await ctx.action('execution', 'get', { runId });
    if (!record) { stateEl.textContent = 'No state for this run.'; currentVersion = null; versionEl.textContent = ''; return; }
    stateEl.textContent = JSON.stringify(record.state, null, 2);
    currentVersion = record.state_version;
    versionEl.textContent = `version ${record.state_version} · ${record.updated_at}`;
  }
  el.querySelector('[data-role="load"]').onclick = () => load().catch(e => ctx.notify(e.message, 'error'));
  el.querySelector('[data-role="init"]').onclick = async () => {
    runId = el.querySelector('[data-role="run"]').value.trim();
    if (!runId) return ctx.notify('A run id is required.', 'error');
    try { await ctx.action('execution', 'init', { runId }); await load(); }
    catch (error) { result.textContent = error.message; }
  };
  el.querySelector('[data-role="apply"]').onclick = async () => {
    try {
      const patch = JSON.parse(el.querySelector('[data-role="patch"]').value);
      await ctx.action('execution', 'patch', { runId, patch, expectedVersion: currentVersion });
      result.textContent = 'Patch applied.';
      await load();
    } catch (error) {
      result.textContent = `${error.data?.error || 'ERROR'}: ${error.message}`;
    }
  };
}
