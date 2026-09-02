// Card source: the validation queue. Registered artifacts grouped by
// lifecycle state, candidates and validated first. A card carries the path,
// the current SHA, the promoted SHA when one exists, the last run and span,
// and a drift badge when the promoted bytes no longer match the disk.
// Clicking a card selects the file for every other mounted behavior.
const ORDER = ['candidate', 'validated', 'working', 'promoted', 'superseded', 'archived'];

export function open(ctx) {
  const root = () => ctx.workspace.root_path;
  const stickyCall = (action, payload = {}) => ctx.action('stickies', action, { rootPath: root(), ...payload });
  const rel = path => path.replace(root() + '/', '');

  function toCard(row, stickies) {
    const note = stickies.notes?.[rel(row.path)];
    const drifted = row.promoted_checksum && row.checksum !== row.promoted_checksum;
    const fields = [{ label: 'sha', value: (row.checksum || '?').slice(0, 12) }];
    if (row.promoted_checksum) fields.push({ label: 'promoted', value: row.promoted_checksum.slice(0, 12) });
    if (row.last_run_id) fields.push({ label: 'run', value: row.last_run_id });
    if (row.last_span_id) fields.push({ label: 'span', value: row.last_span_id });
    return {
      id: row.path,
      kind: 'file',
      ref: rel(row.path),
      path: row.path,
      head: rel(row.path),
      title: row.path.split('/').pop(),
      body: '',
      text: note?.text || '',
      color: note?.color || null,
      face: null,
      icon: 'file',
      fields,
      tags: [],
      image: null,
      width: null,
      missing: false,
      badges: drifted ? [{ text: 'drifted', cls: 'working' }] : [],
      foot: row.updated_at ? [row.updated_at] : []
    };
  }

  async function load() {
    const [rows, stickies] = await Promise.all([
      ctx.action('registry', 'list', { rootPath: root() }),
      stickyCall('list').catch(() => ({ notes: {} }))
    ]);
    const groups = ORDER.map(state => {
      const cards = rows.filter(row => row.state === state).map(row => toCard(row, stickies));
      return { title: `${state} · ${cards.length}`, cls: state, cards };
    });
    return { groups, note: null, empty: 'Nothing registered yet. Open or create a file to register it.' };
  }

  return {
    name: 'Validation queue',
    events: ['file-saved', 'artifact-changed'],
    marks: ['selection'],
    labels: false,
    selected: () => ctx.selection?.path ?? null,
    editing: () => false,
    load,
    select: card => ctx.selectFile(card.path),
    text: (card, value, colorPick) => stickyCall('set', {
      path: card.ref,
      text: value,
      color: (colorPick !== undefined ? colorPick : card.color) || undefined
    })
  };
}
