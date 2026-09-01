// Contribution: expandable workspace tree. Selecting a file broadcasts the
// kernel selection. "＋ file" writes an empty file through the governed write
// path (registered and preflighted from its first byte); "＋ folder" makes a
// real directory with a MKDIR provenance event. Rows can be dragged into a
// folder (or the root drop bar) — a governed move that carries the registry
// row, labels, amendments and frozen versions along with the bytes. Expanded
// folders persist per workspace in localStorage. Label chips come from the
// SQLite crosswalk; the "Labels…" buttons appear only when the label-editor
// contribution is wired into this station.
export async function mount(el, ctx) {
  const labelsWired = () => ctx.wiring.some(row => row.contribution_id === 'label-editor');
  el.innerHTML = `
    <div class="card"><h3>Workspace</h3>
      <div class="tree-toolbar">
        <button data-role="new-file">＋ file</button>
        <button data-role="new-folder">＋ folder</button>
        <button data-role="labels" hidden>Labels…</button>
      </div>
      <div data-role="droproot" class="tree-droproot" title="Drop a dragged entry here to move it to the workspace root">workspace root</div>
      <div data-role="tree"></div>
      <div data-role="menu-host"></div>
    </div>`;
  const tree = el.querySelector('[data-role="tree"]');
  let labels = {};

  const memoryKey = () => 'ro.tree.' + (ctx.workspace?.root_path || '');
  const expanded = new Set(JSON.parse(localStorage.getItem(memoryKey()) || '[]'));
  const rememberExpanded = () => { try { localStorage.setItem(memoryKey(), JSON.stringify([...expanded])); } catch { /* fine */ } };

  // The create menu: explicit File / Folder / Cancel buttons. Cancel and
  // click-away abort — nothing is ever created from a dismissal.
  function createMenu(anchor, baseRelative) {
    el.querySelector('.tree-menu')?.remove();
    const menu = document.createElement('div');
    menu.className = 'tree-menu';
    menu.innerHTML = `
      <div class="muted">Create in ${ctx.esc(baseRelative === '.' ? 'workspace root' : baseRelative)}:</div>
      <button data-kind="file">New file</button>
      <button data-kind="folder">New folder</button>
      <button data-kind="cancel">Cancel</button>`;
    anchor.after(menu);
    const close = () => { menu.remove(); document.removeEventListener('click', onAway, true); };
    const onAway = event => { if (!menu.contains(event.target)) close(); };
    setTimeout(() => document.addEventListener('click', onAway, true), 0);
    menu.querySelectorAll('button').forEach(button => button.onclick = () => {
      const kind = button.dataset.kind;
      close();
      if (kind !== 'cancel') createEntry(baseRelative, kind);
    });
  }

  async function createEntry(baseRelative, kind) {
    const name = prompt(`Name for the new ${kind}:`);
    if (!name) return;
    if (!/^[a-z0-9][a-z0-9 ._-]*$/i.test(name)) return ctx.notify('Names: letters, digits, space, dot, dash, underscore.', 'error');
    const target = `${ctx.workspace.root_path}/${baseRelative === '.' ? '' : baseRelative + '/'}${name}`;
    try {
      if (kind === 'folder') {
        await ctx.request('/api/fs/mkdir', { method: 'POST', body: JSON.stringify({ rootPath: ctx.workspace.root_path, path: target, actor: 'human' }) });
        ctx.notify(`Folder created: ${target}`, 'ok');
      } else {
        const written = await ctx.request('/api/file', {
          method: 'PUT',
          body: JSON.stringify({ rootPath: ctx.workspace.root_path, path: target, content: '', actor: 'human' })
        });
        ctx.notify(`File created and registered · sha256 ${written.checksum.slice(0, 12)}…`, 'ok');
      }
      if (baseRelative !== '.') { expanded.add(baseRelative); rememberExpanded(); }
      ctx.bus.emit('fs-changed', { path: target, kind });
      if (kind === 'file') await ctx.selectFile(target);
    } catch (error) {
      ctx.notify(`${error.data?.error || 'ERROR'}: ${error.message}`, 'error');
    }
  }

  async function moveTo(fromPath, toDirRelative) {
    const name = fromPath.split('/').pop();
    const to = `${ctx.workspace.root_path}/${toDirRelative === '.' ? '' : toDirRelative + '/'}${name}`;
    if (to === fromPath) return;
    try {
      const moved = await ctx.request('/api/fs/move', {
        method: 'POST',
        body: JSON.stringify({ rootPath: ctx.workspace.root_path, from: fromPath, to, actor: 'human' })
      });
      ctx.notify(`Moved ${moved.kind}: ${name} → ${toDirRelative === '.' ? 'workspace root' : toDirRelative}`, 'ok');
      ctx.bus.emit('fs-changed', { path: to, kind: 'move' });
    } catch (error) {
      ctx.notify(`${error.data?.error || 'ERROR'}: ${error.message}`, 'error');
    }
  }

  function chips(fullPath) {
    const assigned = labels[fullPath];
    if (!assigned?.length) return '';
    return assigned.map(a =>
      `<span class="label-chip" style="border-color:${a.color};color:${a.color}">${ctx.esc(a.label)}</span>`).join('');
  }

  function acceptDrops(node, targetRelative) {
    node.addEventListener('dragover', event => { event.preventDefault(); node.classList.add('drop-target'); });
    node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
    node.addEventListener('drop', event => {
      event.preventDefault();
      event.stopPropagation();
      node.classList.remove('drop-target');
      const from = event.dataTransfer.getData('text/ro-path');
      if (from) moveTo(from, targetRelative);
    });
  }

  async function loadDirectory(relativePath, container) {
    const entries = await ctx.request(`/api/tree?root=${encodeURIComponent(ctx.workspace.root_path)}&path=${encodeURIComponent(relativePath)}`);
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'tree-row';
      row.dataset.path = entry.path;
      row.draggable = true;
      row.addEventListener('dragstart', event => {
        event.dataTransfer.setData('text/ro-path', entry.path);
        event.dataTransfer.effectAllowed = 'move';
      });
      const isDir = entry.type === 'directory';
      const isOpen = isDir && expanded.has(entry.relativePath);
      const name = document.createElement('span');
      const caret = isDir ? (isOpen ? '⌄ ' : '▸ ') : '· ';
      name.innerHTML = `${caret}${ctx.esc(entry.name)} ${chips(entry.path)}`;
      row.append(name);

      if (labelsWired()) {
        const tag = document.createElement('button');
        tag.className = 'tree-add';
        tag.textContent = '🏷';
        tag.title = `Labels for ${entry.name}`;
        tag.onclick = event => { event.stopPropagation(); ctx.bus.emit('open-labels', { path: entry.path }); };
        row.append(tag);
      }

      const bin = document.createElement('button');
      bin.className = 'tree-add';
      bin.textContent = '🗑';
      bin.title = `Move ${entry.name} to the workspace trash`;
      bin.onclick = async event => {
        event.stopPropagation();
        if (!confirm(`Move '${entry.name}' to the trash?\nIt goes to .research-ops/trash inside the workspace — nothing is destroyed.`)) return;
        try {
          const gone = await ctx.request('/api/fs/delete', {
            method: 'POST',
            body: JSON.stringify({ rootPath: ctx.workspace.root_path, path: entry.path, actor: 'human' })
          });
          ctx.notify(`Trashed ${gone.kind}: ${entry.name} → .research-ops/trash`, 'ok');
          ctx.bus.emit('fs-changed', { path: entry.path, kind: 'delete' });
        } catch (error) {
          ctx.notify(`${error.data?.error || 'ERROR'}: ${error.message}`, 'error');
        }
      };
      row.append(bin);

      container.append(row);
      if (isDir) {
        const add = document.createElement('button');
        add.className = 'tree-add';
        add.textContent = '＋';
        add.title = `Create inside ${entry.name}`;
        add.onclick = event => { event.stopPropagation(); createMenu(row, entry.relativePath); };
        row.append(add);
        acceptDrops(row, entry.relativePath);

        let child = null;
        const openChild = async () => {
          child = document.createElement('div');
          child.className = 'tree-children';
          row.after(child);
          name.innerHTML = `⌄ ${ctx.esc(entry.name)} ${chips(entry.path)}`;
          await loadDirectory(entry.relativePath, child).catch(e => ctx.notify(e.message, 'error'));
        };
        row.onclick = async event => {
          event.stopPropagation();
          if (child) {
            child.remove(); child = null;
            expanded.delete(entry.relativePath); rememberExpanded();
            name.innerHTML = `▸ ${ctx.esc(entry.name)} ${chips(entry.path)}`;
            return;
          }
          expanded.add(entry.relativePath); rememberExpanded();
          await openChild();
        };
        if (isOpen) await openChild();
      } else {
        row.onclick = event => {
          event.stopPropagation();
          ctx.selectFile(entry.path).catch(e => ctx.notify(e.message, 'error'));
        };
      }
    }
  }

  function markSelected() {
    el.querySelectorAll('.tree-row.selected').forEach(n => n.classList.remove('selected'));
    if (ctx.selection) el.querySelector(`.tree-row[data-path="${CSS.escape(ctx.selection.path)}"]`)?.classList.add('selected');
  }

  async function paint() {
    if (!ctx.workspace) { tree.innerHTML = '<div class="empty">No workspace.</div>'; return; }
    labels = await ctx.request(`/api/path-labels?root=${encodeURIComponent(ctx.workspace.root_path)}`).catch(() => ({}));
    el.querySelector('[data-role="labels"]').hidden = !labelsWired();
    tree.replaceChildren();
    await loadDirectory('.', tree);
    markSelected();
  }

  el.querySelector('[data-role="new-file"]').onclick = () => createEntry('.', 'file');
  el.querySelector('[data-role="new-folder"]').onclick = () => createEntry('.', 'folder');
  el.querySelector('[data-role="labels"]').onclick = () =>
    ctx.bus.emit('open-labels', { path: ctx.selection?.path || null });
  acceptDrops(el.querySelector('[data-role="droproot"]'), '.');
  ctx.bus.on('selection', markSelected);
  ctx.bus.on('fs-changed', () => paint().catch(e => ctx.notify(e.message, 'error')));
  ctx.bus.on('labels-changed', () => paint().catch(e => ctx.notify(e.message, 'error')));
  await paint();
}
