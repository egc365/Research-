export const plugin = {
  id: 'history',
  label: 'History',
  order: 20,
  clientModule: '/plugins/history.js',
  scope: 'file',
  surface: 'right',
  category: 'governance',
  requiresFile: true,
  description: 'Every recorded event for this file, oldest to newest. Nothing here can be edited or deleted.',
  async action({ action, payload, store }) {
    if (action === 'list') return store.history(payload.path, payload.limit || 100);
    throw new Error(`Unknown history action: ${action}`);
  }
};
