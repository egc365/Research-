export const plugin = {
  id: 'governance',
  label: 'Governance',
  order: 10,
  clientModule: '/plugins/governance.js',
  description: 'Lifecycle transitions and owner-only promotion.',
  async action({ action, payload, store }) {
    if (action === 'transition') {
      return store.transition({
        filePath: payload.path,
        toState: payload.toState,
        actor: payload.actor || 'human',
        runId: payload.runId || null,
        spanId: payload.spanId || null,
        metadata: payload.metadata || null
      });
    }
    throw new Error(`Unknown governance action: ${action}`);
  }
};
