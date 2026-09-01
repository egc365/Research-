function lineDiff(baseText, currentText) {
  const base = String(baseText ?? '').split('\n');
  const current = String(currentText ?? '').split('\n');
  const rows = [];
  const n = Math.max(base.length, current.length);
  for (let i = 0; i < n; i++) {
    const before = base[i];
    const after = current[i];
    if (before === after) rows.push({ type: 'same', line: i + 1, text: before ?? '' });
    else {
      if (before !== undefined) rows.push({ type: 'remove', line: i + 1, text: before });
      if (after !== undefined) rows.push({ type: 'add', line: i + 1, text: after });
    }
  }
  return rows;
}

export const plugin = {
  id: 'diff',
  label: 'Diff',
  order: 30,
  clientModule: '/plugins/diff.js',
  scope: 'file',
  surface: 'right',
  category: 'document',
  requiresFile: true,
  description: 'Shows exactly what changed between the current file and the last promoted version.',
  async action({ action, payload, store }) {
    if (action !== 'promoted-vs-current') throw new Error(`Unknown diff action: ${action}`);
    const promoted = store.getPromotedVersion(payload.path);
    if (!promoted) return { promoted: null, rows: [] };
    const current = store.readFile(payload.rootPath, payload.path);
    // node:sqlite hands BLOBs back as Uint8Array, not Buffer
    const promotedText = typeof promoted.content === 'string' ? promoted.content : Buffer.from(promoted.content).toString('utf8');
    return {
      promoted: { checksum: promoted.checksum, created_at: promoted.created_at },
      current: { checksum: current.checksum },
      rows: lineDiff(promotedText, current.content)
    };
  }
};
