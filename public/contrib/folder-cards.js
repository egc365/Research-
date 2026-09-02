// Contribution: Notion-style card view of one folder. The folder comes from
// the contribution config (`path`, relative to the workspace root, default '.').
// Each entry is a .folder-card: name with a folder/file glyph, that path's
// label chips from the SQLite crosswalk, the relative path when it adds
// information — and a sticky note. A folder front carries one small colored
// note (the stickies service), so the filesystem itself communicates a little
// planning information. Clicking a directory asks the tree to reveal it;
// clicking a file broadcasts the kernel selection.
import { styleSticky, paletteEl, colorForLabel } from '/contrib/lib/sticky.js';

export async function mount(el, ctx) {
  let editingPath = null; // sticky editor stays open across repaints

  const stickyCall = (action, payload = {}) =>
    ctx.action('stickies', action, { rootPath: ctx.workspace.root_path, ...payload });

  function stickyEditor(host, entry, note, defaultColor) {
    const box = document.createElement('div');
    styleSticky(box, note?.color || defaultColor);
    box.style.marginTop = '6px';
    const area = document.createElement('textarea');
    area.value = note?.text || '';
    area.rows = 2;
    area.placeholder = 'A few words on this folder…';
    area.style.cssText = 'width:100%;background:rgba(255,255,255,.55);color:#222;border:1px solid rgba(0,0,0,.3);border-radius:4px;padding:2px 4px;font:inherit;resize:vertical';
    let color = note?.color || defaultColor;
    const palette = paletteEl(color, picked => { color = picked || defaultColor; styleSticky(box, color); });
    const save = document.createElement('button');
    save.textContent = note ? 'Save' : 'Stick it';
    save.onclick = async e => {
      e.stopPropagation();
      try { await stickyCall('set', { path: entry.relativePath, text: area.value, color }); }
      catch (error) { ctx.notify(error.message, 'error'); }
      editingPath = null;
      repaint();
    };
    box.append(area, palette, save);
    box.onclick = e => e.stopPropagation();
    area.onkeydown = e => { if (e.key === 'Escape') { editingPath = null; repaint(); } };
    host.append(box);
    return area;
  }

  async function paint() {
    if (!ctx.workspace) { el.innerHTML = '<div class="empty">No workspace.</div>'; return; }
    const folder = ctx.config?.path || '.';
    const root = ctx.workspace.root_path;
    const [entries, labels, stickies] = await Promise.all([
      ctx.request(`/api/tree?root=${encodeURIComponent(root)}&path=${encodeURIComponent(folder)}`),
      ctx.request(`/api/path-labels?root=${encodeURIComponent(root)}`).catch(() => ({})),
      stickyCall('list').catch(() => ({ notes: {} }))
    ]);
    el.innerHTML = `
      <div class="card"><h3>${ctx.esc(ctx.workspace.label || 'Workspace')}</h3>
        <div class="folder-cards" data-role="grid"></div>
      </div>`;
    const grid = el.querySelector('[data-role="grid"]');
    if (!entries.length) { grid.innerHTML = '<div class="muted">This folder is empty.</div>'; return; }
    let focusArea = null;
    for (const entry of entries) {
      const isDir = entry.type === 'directory';
      const card = document.createElement('div');
      card.className = 'folder-card';
      const pathLabels = labels[entry.path] || [];
      const chips = pathLabels.map(a =>
        `<span class="label-chip" style="border-color:${a.color};color:${a.color}">${ctx.esc(a.label)}</span>`).join('');
      const showPath = entry.relativePath && entry.relativePath !== entry.name;
      card.innerHTML = `
        <div class="name">${isDir ? '📁 ' : '📄 '}${ctx.esc(entry.name)}</div>
        ${chips}
        ${showPath ? `<div class="muted mono">${ctx.esc(entry.relativePath)}</div>` : ''}`;
      card.onclick = () => {
        if (isDir) ctx.bus.emit('reveal-path', { path: entry.path });
        else ctx.selectFile(entry.path).catch(e => ctx.notify(e.message, 'error'));
      };
      const stickyPath = entry.relativePath;
      const note = stickies.notes?.[stickyPath];
      // Color by function when a labeled path gets its first sticky: the same
      // label always suggests the same color; the palette overrides it.
      const defaultColor = colorForLabel(pathLabels[0]?.label);
      if (editingPath === stickyPath) {
        focusArea = stickyEditor(card, entry, note, defaultColor);
      } else if (note) {
        const sticky = document.createElement('div');
        styleSticky(sticky, note.color);
        sticky.style.marginTop = '6px';
        sticky.textContent = note.text;
        sticky.title = 'Edit sticky';
        sticky.onclick = e => { e.stopPropagation(); editingPath = stickyPath; repaint(); };
        card.append(sticky);
      } else {
        const add = document.createElement('button');
        add.textContent = '＋ sticky';
        add.className = 'muted';
        add.style.cssText = 'margin-top:6px;font-size:11px;background:none;border:1px dashed #555;border-radius:4px;color:inherit;cursor:pointer;padding:1px 6px;opacity:.6';
        add.onclick = e => { e.stopPropagation(); editingPath = stickyPath; repaint(); };
        card.append(add);
      }
      grid.append(card);
    }
    if (focusArea) focusArea.focus();
  }
  const repaint = () => paint().catch(e => ctx.notify(e.message, 'error'));
  ctx.bus.on('fs-changed', repaint);
  ctx.bus.on('labels-changed', repaint);
  ctx.bus.on('workspace', () => { editingPath = null; repaint(); });
  await paint();
}
