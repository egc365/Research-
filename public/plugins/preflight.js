// Plain-language rule catalog. Internal rule_type tokens stay stable in the DB;
// the UI never shows a bare token without its meaning.
const RULE_TYPES = {
  deny_write: {
    label: 'Protected path',
    meaning: 'Blocks all writes under the scope path. Optionally still allows a human ("allowHuman": true).',
    example: { allowHuman: true, message: 'Protected: edits need the owner' }
  },
  max_bytes: {
    label: 'Size limit',
    meaning: 'Rejects a save if the file would be larger than "max" bytes.',
    example: { max: 1000000 }
  },
  require_text: {
    label: 'Required text',
    meaning: 'Rejects a save unless the file contains the given text (e.g. a required header).',
    example: { text: 'REQUIRED' }
  },
  forbid_text: {
    label: 'Forbidden text',
    meaning: 'Rejects a save if the file contains the given text.',
    example: { text: 'FORBIDDEN' }
  },
  json_parse: {
    label: 'Valid JSON',
    meaning: 'For .json files only: rejects a save if the content is not valid JSON.',
    example: {}
  }
};

export async function render(ctx) {
  const rules = await ctx.api('list', {});
  ctx.panel.innerHTML = `
    <div class="card">
      <h3>Add a rule</h3>
      <div class="muted">Rules run automatically before every save under their scope path, and again as the validators that mint validation receipts.</div>
      <div class="field"><label>Applies to (file or folder path)</label><input id="ruleScope" value="${escapeAttr(ctx.file?.path || ctx.rootPath || '')}"></div>
      <div class="field"><label>Rule</label><select id="ruleType">${Object.entries(RULE_TYPES).map(([key, t]) => `<option value="${key}">${t.label}</option>`).join('')}</select></div>
      <div class="muted" id="ruleMeaning">${escapeHtml(RULE_TYPES.deny_write.meaning)}</div>
      <div class="field"><label>Settings (JSON)</label><input id="ruleJson" value='${escapeAttr(JSON.stringify(RULE_TYPES.deny_write.example))}'></div>
      <div class="actions"><button id="addRule" class="primary">Add rule</button></div>
    </div>
    <div class="card"><h3>Active rules</h3><div id="rules">${rules.length ? rules.map(rule => `
      <div class="rule">
        <div><strong>${escapeHtml(RULE_TYPES[rule.rule_type]?.label || rule.rule_type)}</strong> · ${rule.enabled ? 'on' : 'off'}</div>
        <div class="muted">${escapeHtml(RULE_TYPES[rule.rule_type]?.meaning || '')}</div>
        <div class="muted">Applies to: ${escapeHtml(rule.scope_path)}</div>
        <div class="muted">Settings: ${escapeHtml(rule.rule_json)}</div>
        <div class="actions"><button data-toggle="${rule.rule_id}" data-enabled="${rule.enabled ? 0 : 1}">${rule.enabled ? 'Turn off' : 'Turn on'}</button></div>
      </div>`).join('') : '<div class="muted">No rules yet. Every save passes until you add one.</div>'}</div></div>`;

  ctx.panel.querySelector('#ruleType').onchange = event => {
    const t = RULE_TYPES[event.target.value];
    ctx.panel.querySelector('#ruleJson').value = JSON.stringify(t.example);
    ctx.panel.querySelector('#ruleMeaning').textContent = t.meaning;
  };
  ctx.panel.querySelector('#addRule').onclick = async () => {
    try {
      await ctx.api('add', {
        scopePath:ctx.panel.querySelector('#ruleScope').value,
        ruleType:ctx.panel.querySelector('#ruleType').value,
        rule:JSON.parse(ctx.panel.querySelector('#ruleJson').value)
      });
      ctx.notify('Rule added.');
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
