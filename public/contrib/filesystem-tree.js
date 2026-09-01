// Contribution: expandable workspace tree with creation controls and label
// chips. Selecting a file broadcasts the kernel selection; "+ file" writes
// an empty file through the governed write path so it is registered and
// preflighted from its first byte; "+ folder" creates a real directory with
// a MKDIR provenance event. Label chips come from the SQLite crosswalk.
export async function mount(el, ctx) {
  el.innerHTML = `
    <div class="card"><h3>Workspace</h3>
      <div class="tree-toolbar">
        <button data-role="new-file" title="Create an empty file at the workspace root">＋ file</button>
        <button data-role="new-folder" title="Create a folder at the workspace root">＋ folder</button>
      </div>
      <div data-role="tree"></div>
    </div>`;
  const tree = el.querySelector('[data-role="tree"]');
  let labels = {};

  async function createEntry(baseRelative, kind) {
    const name = prompt(`New ${kind} name (created under ${baseRelative === '.' ? 'the workspace root' : baseRelative}):`);
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
      ctx.bus.emit('fs-changed', { path: target, kind });
      if (kind === 'file') await ctx.selectFile(target);
    } catch (error) {
      ctx.notify(`${error.data?.error || 'ERROR'}: ${error.message}`, 'error');
    }
  }

  function chips(fullPath) {
    const assigned = labels[fullPath];
    if (!assigned?.length) return '';
    return assigned.map(a =>
      `<span class="label-chip" style="border-color:${a.color};color:${a.color}">${a.label}</span>`).join('');
  }

  async function loadDirectory(relativePath, container) {
    const entries = await ctx.request(`/api/tree?root=${encodeURIComponent(ctx.workspace.root_path)}&path=${encodeURIComponent(relativePath)}`);
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'tree-row';
      row.dataset.path = entry.path;
      const name = document.createElement('span');
      name.innerHTML = `${entry.type === 'directory' ? '▸ ' : '· '}${entry.name} ${chips(entry.path)}`;
      row.append(name);
      container.append(row);
      if (entry.type === 'directory') {
        const add = document.createElement('button');
        add.className = 'tree-add';
        add.textContent = '＋';
        add.title = `Create a file or folder inside ${entry.name}`;
        add.onclick = event => {
          event.stopPropagation();
          const kind = confirm(`Create a FILE inside ${entry.name}?\n(OK = file, Cancel = folder)`) ? 'file' : 'folder';
          createEntry(entry.relativePath, kind);
        };
        row.append(add);
        let child = null;
        row.onclick = async event => {
          event.stopPropagation();
          if (child) { child.remove(); child = null; name.innerHTML = `▸ ${entry.name} ${chips(entry.path)}`; return; }
          child = document.createElement('div');
          child.className = 'tree-children';
          row.after(child);
          name.innerHTML = `⌄ ${entry.name} ${chips(entry.path)}`;
          await loadDirectory(entry.relativePath, child).catch(e => ctx.notify(e.message, 'error'));
        };
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
    tree.replaceChildren();
    await loadDirectory('.', tree);
    markSelected();
  }

  el.querySelector('[data-role="new-file"]').onclick = () => createEntry('.', 'file');
  el.querySelector('[data-role="new-folder"]').onclick = () => createEntry('.', 'folder');
  ctx.bus.on('selection', markSelected);
  ctx.bus.on('fs-changed', () => paint().catch(e => ctx.notify(e.message, 'error')));
  ctx.bus.on('labels-changed', () => paint().catch(e => ctx.notify(e.message, 'error')));
  await paint();
}
