const TYPES = ['deny_write','max_bytes','require_text','forbid_text','json_parse'];

export async function render(ctx) {
  const rules = await ctx.api('list', {});
  ctx.panel.innerHTML = `
    <div class="card">
      <h3>Deterministic preflight</h3>
      <div class="muted">Rules run before file mutation. Scope can be a file or folder path.</div>
      <div class="field"><label>Scope path</label><input id="ruleScope" value="${escapeAttr(ctx.file?.path || ctx.rootPath || '')}"></div>
      <div class="field"><label>Rule type</label><select id="ruleType">${TYPES.map(x => `<option>${x}</option>`).join('')}</select></div>
      <div class="field"><label>Rule JSON</label><input id="ruleJson" value='{"allowHuman":true}'></div>
      <button id="addRule">Add rule</button>
    </div>
    <div class="card"><h3>Rules</h3><div id="rules">${rules.length ? rules.map(rule => `
      <div class="rule">
        <div><strong>${escapeHtml(rule.rule_type)}</strong> · ${rule.enabled ? 'enabled' : 'disabled'}</div>
        <div class="muted">${escapeHtml(rule.scope_path)}</div>
        <div class="muted">${escapeHtml(rule.rule_json)}</div>
        <div class="actions"><button data-toggle="${rule.rule_id}" data-enabled="${rule.enabled ? 0 : 1}">${rule.enabled ? 'Disable' : 'Enable'}</button></div>
      </div>`).join('') : '<div class="muted">No policy rules yet.</div>'}</div></div>`;

  ctx.panel.querySelector('#ruleType').onchange = event => {
    const examples = {
      deny_write:{allowHuman:true,message:'Protected deterministic routing block'},
      max_bytes:{max:1000000},
      require_text:{text:'REQUIRED'},
      forbid_text:{text:'FORBIDDEN'},
      json_parse:{}
    };
    ctx.panel.querySelector('#ruleJson').value = JSON.stringify(examples[event.target.value]);
  };
  ctx.panel.querySelector('#addRule').onclick = async () => {
    try {
      await ctx.api('add', {
        scopePath:ctx.panel.querySelector('#ruleScope').value,
        ruleType:ctx.panel.querySelector('#ruleType').value,
        rule:JSON.parse(ctx.panel.querySelector('#ruleJson').value)
      });
      ctx.notify('Preflight rule added.');
      await ctx.rerender();
    } catch (error) { ctx.notify(error.message, 'error'); }
  };
  ctx.panel.querySelectorAll('[data-toggle]').forEach(button => button.onclick = async () => {
    await ctx.api('toggle', { ruleId:Number(button.dataset.toggle), enabled:button.dataset.enabled === '1' });
    await ctx.rerender();
  });
}
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const escapeAttr = value => escapeHtml(value).replace(/`/g,'&#96;');
