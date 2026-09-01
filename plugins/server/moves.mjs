import { startMoveScan, getScanJob, cancelScanJob, scanJobStatus } from '../../src/move-scan.mjs';

export const plugin = {
  id: 'moves',
  label: 'Moved files',
  order: 60,
  clientModule: '/plugins/moves.js',
  scope: 'workspace',
  surface: 'right',
  category: 'housekeeping',
  requiresWorkspace: true,
  description: 'Finds files that were renamed or moved outside the app by matching their content fingerprint, so their history can follow them.',
  async action({ action, payload, store, surface }) {
    if (action === 'scan-start') {
      // Explicit user action only; the scan itself runs off the request path.
      const options = {};
      if (payload.options && typeof payload.options === 'object') {
        for (const key of ['maxFileBytes', 'maxFiles', 'yieldDelayMs']) {
          if (payload.options[key] !== undefined) options[key] = Number(payload.options[key]);
        }
      }
      const job = startMoveScan(store, payload.rootPath, options);
      return scanJobStatus(job);
    }
    if (action === 'scan-status') {
      const job = getScanJob(payload.jobId);
      if (!job) throw new Error('Unknown scan job');
      return scanJobStatus(job);
    }
    if (action === 'scan-cancel') {
      const job = cancelScanJob(payload.jobId);
      if (!job) throw new Error('Unknown scan job');
      return scanJobStatus(job);
    }
    if (action === 'apply') {
      if (surface === 'agent') {
        const error = new Error('Move remapping happens on the owner surface.');
        error.code = 'OWNER_SURFACE_ONLY';
        throw error;
      }
      return store.applyMove({
        rootPath: payload.rootPath,
        fromPath: payload.fromPath,
        toPath: payload.toPath,
        actor: payload.actor || 'human'
      });
    }
    throw new Error(`Unknown moves action: ${action}`);
  }
};
