export const plugin = {
  id: 'trajectory',
  label: 'Trajectory',
  order: 50,
  clientModule: '/plugins/trajectory.js',
  description: 'Bind artifacts to authoritative DeepSeek Harness run/span identifiers without copying trace content.',
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
