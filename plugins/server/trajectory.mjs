export const plugin = {
  id: 'trajectory',
  label: 'Provenance',
  order: 50,
  clientModule: '/plugins/trajectory.js',
  scope: 'file',
  surface: 'right',
  category: 'provenance',
  requiresFile: true,
  description: 'Links a file to the agent run and step that produced it. The harness session log stays the authority; only the identifiers are stored here.',
  async action({ action, payload, store }) {
    if (action === 'bind') {
      return store.bindTrace({
        filePath: payload.path,
        runId: payload.runId,
        spanId: payload.spanId || null,
        actor: payload.actor || 'human'
      });
    }
    if (action === 'current') return store.getArtifact(payload.path);
    throw new Error(`Unknown trajectory action: ${action}`);
  }
};
