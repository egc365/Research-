export const plugin = {
  id: 'statistics',
  label: 'Statistics',
  order: 70,
  clientModule: '/plugins/statistics.js',
  scope: 'workspace',
  surface: 'right',
  category: 'analysis',
  requiresWorkspace: true,
  description: 'Counts and recent activity for this workspace, computed from the ledger — never by reading your files.',
  async action({ action, payload, store }) {
    if (action !== 'workspace-summary') throw new Error(`Unknown statistics action: ${action}`);
    const root = payload.rootPath;
    const byState = store.db.prepare(
      'SELECT state, COUNT(*) AS count FROM artifact_registry WHERE workspace_root=? GROUP BY state ORDER BY count DESC'
    ).all(root);
    const events = store.db.prepare(`
      SELECT event_type, COUNT(*) AS count
      FROM artifact_events e
      WHERE EXISTS (SELECT 1 FROM artifact_registry r WHERE r.path = e.path AND r.workspace_root = ?)
      GROUP BY event_type ORDER BY count DESC
    `).all(root);
    const actors = store.db.prepare(`
      SELECT actor, COUNT(*) AS count
      FROM artifact_events e
      WHERE EXISTS (SELECT 1 FROM artifact_registry r WHERE r.path = e.path AND r.workspace_root = ?)
      GROUP BY actor ORDER BY count DESC
    `).all(root);
    const promotions = store.db.prepare(`
      SELECT e.path, e.created_at
      FROM artifact_events e
      WHERE e.event_type='STATE_TRANSITION' AND e.to_state='promoted'
        AND EXISTS (SELECT 1 FROM artifact_registry r WHERE r.path = e.path AND r.workspace_root = ?)
      ORDER BY e.event_id DESC LIMIT 10
    `).all(root);
    return { byState, events, actors, promotions };
  }
};
