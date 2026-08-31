export const plugin = {
  id: 'history',
  label: 'History',
  order: 20,
  clientModule: '/plugins/history.js',
  description: 'Append-only governance event history.',
  async action({ action, payload, store }) {
    if (action === 'list') return store.history(payload.path, payload.limit || 100);
    throw new Error(`Unknown history action: ${action}`);
  }
};
