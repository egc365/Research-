export const plugin = {
  id: 'governance',
  label: 'Governance',
  order: 10,
  clientModule: '/plugins/governance.js',
  scope: 'file',
  surface: 'right',
  category: 'governance',
  requiresFile: true,
  description: 'Moves a file through working, candidate, validated, promoted. Only you can promote, and promotion freezes the exact bytes.',
  async action({ action, payload, store, plugins }) {
    if (action === 'transition') {
      let metadata = payload.metadata || null;
      if (payload.toState === 'validated') {
        // Receipts come from deterministic validators, never from the caller.
        const current = store.readFile(store.getArtifact(payload.path).workspace_root, payload.path);
        const receipts = plugins
          ? await plugins.runValidators({ filePath: payload.path, content: current.content, actor: payload.actor || 'human' })
          : { ok: true, results: [] };
        if (!receipts.ok) {
          const error = new Error('VALIDATION_FAILED');
          error.code = 'VALIDATION_FAILED';
          error.validation = receipts;
          throw error;
        }
        metadata = { ...(metadata || {}), validation: { ok: true, checksum: current.checksum, results: receipts.results } };
      }
      return store.transition({
        filePath: payload.path,
        toState: payload.toState,
        actor: payload.actor || 'human',
        runId: payload.runId || null,
        spanId: payload.spanId || null,
        metadata
      });
    }
    // Deterministic path up: one verb from working (or candidate) toward
    // validated. Candidate is a checkpoint the machine passes through, not a
    // choice the owner makes; validation receipts decide whether it sticks.
    // A failing validation returns { state: 'candidate', validation } rather
    // than throwing — the receipts are the answer. Promote, supersede and
    // archive remain deliberate owner transitions.
    if (action === 'submit') {
      const artifact = store.getArtifact(payload.path);
      if (!artifact) { const e = new Error(`Not a registered artifact: ${payload.path}`); e.code = 'BAD_STATE'; throw e; }
      if (!['working', 'candidate'].includes(artifact.state)) {
        const e = new Error(`Submit starts from working or candidate, not ${artifact.state}`);
        e.code = 'BAD_STATE';
        throw e;
      }
      const actor = payload.actor || 'human';
      if (artifact.state === 'working') {
        store.transition({ filePath: payload.path, toState: 'candidate', actor });
      }
      const current = store.readFile(artifact.workspace_root, payload.path);
      const receipts = plugins
        ? await plugins.runValidators({ filePath: payload.path, content: current.content, actor })
        : { ok: true, results: [] };
      if (!receipts.ok) return { state: 'candidate', validation: receipts };
      store.transition({
        filePath: payload.path, toState: 'validated', actor,
        metadata: { validation: { ok: true, checksum: current.checksum, results: receipts.results } }
      });
      return { state: 'validated', validation: receipts };
    }

    if (action === 'card') {
      const artifact = store.getArtifact(payload.path);
      if (!artifact) return { artifact: null };
      const events = store.history(payload.path, 200);
      const validatedEvent = events.find(e => e.event_type === 'STATE_TRANSITION' && e.to_state === 'validated');
      let validation = null;
      if (validatedEvent?.metadata_json) {
        try { validation = JSON.parse(validatedEvent.metadata_json).validation || null; } catch { validation = null; }
      }
      const promoted = store.getPromotedVersion(payload.path);
      return {
        artifact,
        validation,
        validatedAt: validatedEvent?.created_at || null,
        promoted: promoted ? { checksum: promoted.checksum, created_at: promoted.created_at } : null,
        eventCount: events.length
      };
    }
    throw new Error(`Unknown governance action: ${action}`);
  }
};
