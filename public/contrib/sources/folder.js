// Card source: one folder's entries. The folder is config.path, relative to
// the workspace root, default '.'. A card is a file or a folder with its
// label chips and its sticky note (the stickies service), so the filesystem
// itself carries a little planning information. Clicking a folder reveals it
// in the tree; clicking a file selects it for every other view.
import { colorForLabel } from '../lib/sticky.js';

export function open(ctx, config) {
  const root = () => ctx.workspace.root_path;
  const stickyCall = (action, payload = {}) => ctx.action('stickies', action, { rootPath: root(), ...payload });
  const reveal = card => ctx.bus.emit('reveal-path', { path: card.path });

  async function load() {
    const folder = config.path || '.';
    const [entries, labels, stickies] = await Promise.all([
      ctx.request(`/api/tree?root=${encodeURIComponent(root())}&path=${encodeURIComponent(folder)}`),
      ctx.request(`/api/path-labels?root=${encodeURIComponent(root())}`).catch(() => ({})),
      stickyCall('list').catch(() => ({ notes: {} }))
    ]);
    const cards = entries.map(entry => {
      const isDir = entry.type === 'directory';
      const note = stickies.notes?.[entry.relativePath];
      // body '' rather than null: a preview read registers the file as a
      // working artifact, and a folder view must not register what it shows.
      return {
        id: entry.relativePath,
        kind: isDir ? 'folder' : 'file',
        ref: entry.relativePath,
        path: entry.path,
        head: entry.relativePath,
        title: entry.name,
        body: isDir ? note?.text || '' : '',
        text: note?.text || '',
        color: note?.color || null,
        face: null,
        icon: isDir ? 'folder' : 'file',
        fields: [],
        tags: labels[entry.path] || [],
        image: null,
        width: null,
        missing: false,
        badges: [],
        foot: []
      };
    });
    return { groups: [{ title: '', cards }], note: null, empty: 'This folder is empty.' };
  }

  return {
    name: 'Folder cards',
    events: ['fs-changed', 'labels-changed'],
    marks: ['selection'],
    labels: true,
    // Card ids are workspace-relative; the selection carries the absolute path.
    selected: () => {
      const p = ctx.selection?.path;
      return p && p.startsWith(root() + '/') ? p.slice(root().length + 1) : null;
    },
    editing: () => false,
    load,
    select: card => card.kind === 'folder' ? reveal(card) : ctx.selectFile(card.path),
    open: card => card.kind === 'folder' ? reveal(card) : ctx.selectFile(card.path),
    openTitle: () => 'Show this folder in the tree',
    // An emptied note comes off the path; the color picked while editing
    // wins, then the note's own, then the first label's.
    text: (card, value, colorPick) => stickyCall('set', {
      path: card.ref,
      text: value,
      color: (colorPick !== undefined ? colorPick : card.color) || colorForLabel(card.tags[0]?.label)
    })
  };
}
