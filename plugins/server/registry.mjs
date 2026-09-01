export const plugin = {
  id: 'registry',
  label: 'Registry',
  order: 15,
  scope: 'workspace',
  surface: 'right',
  category: 'governance',
  requiresWorkspace: true,
  description: 'Lists the registered artifacts of a workspace straight from the ledger, grouped by lifecycle state.',
  async action({ action, payload, store }) {
    if (action === 'list') {
      return store.db.prepare(`
        SELECT path, state, checksum, promoted_checksum, last_run_id, updated_at
        FROM artifact_registry WHERE workspace_root=?
        ORDER BY state, path
      `).all(payload.rootPath);
    }
    if (action === 'recent') {
      return store.recentActivity(payload.rootPath, payload.limit || 12);
    }
    throw new Error(`Unknown registry action: ${action}`);
  }
};
