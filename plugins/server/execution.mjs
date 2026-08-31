export const plugin = {
  id: 'execution',
  label: 'Execution state',
  order: 45,
  clientModule: '/plugins/execution.js',
  description: 'Bounded per-run structured execution state (SKILL.state): agents propose patches, the runtime validates and merges.',
  async action({ action, payload, store }) {
    if (action === 'get') return store.getExecutionState(payload.runId);
    if (action === 'init') return store.initExecutionState({ runId: payload.runId, skillPath: payload.skillPath || null, initial: payload.initial || {} });
    if (action === 'patch') return store.applyStatePatch({ runId: payload.runId, patch: payload.patch, expectedVersion: payload.expectedVersion });
    throw new Error(`Unknown execution action: ${action}`);
  }
};
