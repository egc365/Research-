import path from 'node:path';

function applies(scope, target) {
  const s = path.resolve(scope);
  const t = path.resolve(target);
  const rel = path.relative(s, t);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function evaluate(rule, content, target, actor) {
  const spec = JSON.parse(rule.rule_json);
  switch (rule.rule_type) {
    case 'deny_write':
      return actor === 'human' && spec.allowHuman === true
        ? { ok: true, ruleId: rule.rule_id }
        : { ok: false, ruleId: rule.rule_id, message: spec.message || `Writes are protected under ${rule.scope_path}` };
    case 'max_bytes': {
      const bytes = Buffer.byteLength(content, 'utf8');
      return bytes <= Number(spec.max)
        ? { ok: true, ruleId: rule.rule_id, bytes }
        : { ok: false, ruleId: rule.rule_id, message: `File exceeds ${spec.max} bytes`, bytes };
    }
    case 'require_text':
      return content.includes(String(spec.text))
        ? { ok: true, ruleId: rule.rule_id }
        : { ok: false, ruleId: rule.rule_id, message: `Required text missing: ${spec.text}` };
    case 'forbid_text':
      return !content.includes(String(spec.text))
        ? { ok: true, ruleId: rule.rule_id }
        : { ok: false, ruleId: rule.rule_id, message: `Forbidden text present: ${spec.text}` };
    case 'json_parse':
      if (path.extname(target).toLowerCase() !== '.json') return { ok: true, ruleId: rule.rule_id, skipped: true };
      try { JSON.parse(content); return { ok: true, ruleId: rule.rule_id }; }
      catch (error) { return { ok: false, ruleId: rule.rule_id, message: `Invalid JSON: ${error.message}` }; }
    default:
      return { ok: false, ruleId: rule.rule_id, message: `Unknown policy rule type: ${rule.rule_type}` };
  }
}

export const plugin = {
  id: 'preflight',
  label: 'Preflight',
  order: 40,
  clientModule: '/plugins/preflight.js',
  scope: 'workspace',
  surface: 'right',
  category: 'policy',
  requiresWorkspace: true,
  description: 'Deterministic path protection and lint rules before file mutation.',

  async beforeWrite({ filePath, content, actor = 'human', store }) {
    const rules = store.db.prepare('SELECT * FROM policy_rules WHERE enabled=1 ORDER BY rule_id').all();
    const applicable = rules.filter(rule => applies(rule.scope_path, filePath));
    if (!applicable.length) return { ok: true, checks: [] };
    const checks = applicable.map(rule => evaluate(rule, content, filePath, actor));
    const failed = checks.find(check => check.ok === false);
    return failed ? { ok: false, message: failed.message, checks } : { ok: true, checks };
  },

  async validate({ filePath, content, store }) {
    const rules = store.db.prepare('SELECT * FROM policy_rules WHERE enabled=1 ORDER BY rule_id').all();
    const applicable = rules.filter(rule => rule.rule_type !== 'deny_write' && applies(rule.scope_path, filePath));
    const checks = applicable.map(rule => evaluate(rule, content, filePath, 'validator'));
    const failed = checks.find(check => check.ok === false);
    return failed ? { ok: false, message: failed.message, checks } : { ok: true, checks };
  },

  async action({ action, payload, store, surface }) {
    if (action === 'list') {
      return store.db.prepare('SELECT * FROM policy_rules ORDER BY scope_path, rule_id').all();
    }
    if (surface === 'agent') {
      // Agents may not change validation policy (spec §6): the rules that mint
      // validation receipts are owner-surface state.
      const error = new Error('Policy rules are managed on the owner surface.');
      error.code = 'OWNER_SURFACE_ONLY';
      throw error;
    }
    if (action === 'add') {
      const ts = new Date().toISOString();
      const scope = path.resolve(payload.scopePath);
      const spec = typeof payload.rule === 'string' ? JSON.parse(payload.rule) : payload.rule;
      const result = store.db.prepare(`
        INSERT INTO policy_rules(scope_path,rule_type,rule_json,enabled,created_at,updated_at)
        VALUES(?,?,?,?,?,?)
      `).run(scope, payload.ruleType, JSON.stringify(spec || {}), payload.enabled === false ? 0 : 1, ts, ts);
      return store.db.prepare('SELECT * FROM policy_rules WHERE rule_id=?').get(result.lastInsertRowid);
    }
    if (action === 'toggle') {
      store.db.prepare('UPDATE policy_rules SET enabled=?,updated_at=? WHERE rule_id=?')
        .run(payload.enabled ? 1 : 0, new Date().toISOString(), payload.ruleId);
      return { ok: true };
    }
    throw new Error(`Unknown preflight action: ${action}`);
  }
};
