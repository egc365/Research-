export const plugin = {
  id: 'moves',
  label: 'Moves',
  order: 60,
  clientModule: '/plugins/moves.js',
  description: 'Detect renamed/moved registered files by checksum and remap them with a MOVE event.',
  async action({ action, payload, store, surface }) {
    if (action === 'detect') return store.detectMoves(payload.rootPath);
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
