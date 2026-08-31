const state = {
  workspaces: [],
  workspace: null,
  file: null,
  plugins: [],
  pluginModules: new Map(),
  activePlugin: null,
  dirty: false
};

const $ = id => document.getElementById(id);
const workspaceSelect = $('workspaceSelect');
const tree = $('tree');
const editor = $('editor');
const fileName = $('fileName');
const fileMeta = $('fileMeta');
const stateBadge = $('stateBadge');
const statusBar = $('statusBar');
const pluginTabs = $('pluginTabs');
const pluginPanel = $('pluginPanel');

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || data.error || `HTTP ${response.status}`);
    error.data = data;
    throw error;
  }
  return data;
}

function setStatus(message, kind = 'info') {
  statusBar.textContent = message;
  statusBar.dataset.kind = kind;
}

async function loadWorkspaces(selectPath = null) {
  state.workspaces = await request('/api/workspaces');
  workspaceSelect.replaceChildren();
  for (const ws of state.workspaces) {
    const option = document.createElement('option');
    option.value = ws.root_path;
    option.textContent = ws.label || ws.root_path;
    workspaceSelect.append(option);
  }
  const wanted = selectPath || state.workspace?.root_path || state.workspaces[0]?.root_path;
  if (wanted) {
    workspaceSelect.value = wanted;
    state.workspace = state.workspaces.find(ws => ws.root_path === wanted) || state.workspaces[0];
    await renderTree();
  } else {
    state.workspace = null;
    tree.innerHTML = '<div class="empty">Add an absolute folder path to begin.</div>';
  }
}

async function renderTree() {
  tree.replaceChildren();
  if (!state.workspace) return;
  const root = document.createElement('div');
  root.className = 'tree-row';
  root.innerHTML = `<span class="caret">▾</span><span>▾ ${escapeHtml(state.workspace.label || state.workspace.root_path)}</span>`;
  tree.append(root);
  const children = document.createElement('div');
  children.className = 'tree-children';
  tree.append(children);
  await loadDirectory('.', children);
}

async function loadDirectory(relativePath, container) {
  const entries = await request(`/api/tree?root=${encodeURIComponent(state.workspace.root_path)}&path=${encodeURIComponent(relativePath)}`);
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.path = entry.path;
    row.innerHTML = entry.type === 'directory'
      ? `<span class="caret">›</span><span>▸ ${escapeHtml(entry.name)}</span>`
      : `<span class="caret"></span><span>${escapeHtml(entry.name)}</span>`;
    container.append(row);
    if (entry.type === 'directory') {
      let expanded = false;
      let child = null;
      row.addEventListener('click', async event => {
        event.stopPropagation();
        if (!expanded) {
          child = document.createElement('div');
          child.className = 'tree-children';
          row.after(child);
          row.querySelector('.caret').textContent = '⌄';
          await loadDirectory(entry.relativePath, child);
        } else {
          child?.remove();
          row.querySelector('.caret').textContent = '›';
        }
        expanded = !expanded;
      });
    } else {
      row.addEventListener('click', event => {
        event.stopPropagation();
        openFile(entry.path, row).catch(showError);
      });
    }
  }
}

async function openFile(path, row) {
  if (state.dirty && !confirm('Discard unsaved editor changes?')) return;
  const data = await request(`/api/file?root=${encodeURIComponent(state.workspace.root_path)}&path=${encodeURIComponent(path)}`);
  state.file = data;
  state.dirty = false;
  editor.disabled = false;
  editor.value = data.content;
  fileName.textContent = path.split('/').pop();
  fileMeta.textContent = `${path} · sha256 ${data.checksum.slice(0,12)}…`;
  stateBadge.textContent = data.artifact?.state || 'working';
  document.querySelectorAll('.tree-row.selected').forEach(el => el.classList.remove('selected'));
  row?.classList.add('selected');
  setStatus('Loaded exact current bytes.');
  await renderActivePlugin();
}

async function saveFile() {
  if (!state.file) return;
  const result = await request('/api/file', {
    method: 'PUT',
    body: JSON.stringify({
      rootPath: state.workspace.root_path,
      path: state.file.path,
      content: editor.value,
      expectedChecksum: state.file.checksum,
      actor: 'human'
    })
  });
  state.file = result;
  state.dirty = false;
  fileMeta.textContent = `${result.path} · sha256 ${result.checksum.slice(0,12)}…`;
  stateBadge.textContent = result.artifact?.state || 'working';
  setStatus(`Saved. ${result.preflight?.length || 0} preflight plugin result(s).`);
  await renderActivePlugin();
}

async function loadPlugins() {
  state.plugins = await request('/api/plugins');
  pluginTabs.replaceChildren();
  for (const spec of state.plugins) {
    if (spec.clientModule) {
      const mod = await import(spec.clientModule);
      state.pluginModules.set(spec.id, mod);
    }
    const button = document.createElement('button');
    button.className = 'tab';
    button.textContent = spec.label;
    button.dataset.pluginId = spec.id;
    button.onclick = () => activatePlugin(spec.id);
    pluginTabs.append(button);
  }
  if (state.plugins.length) await activatePlugin(state.plugins[0].id);
}

async function activatePlugin(id) {
  state.activePlugin = id;
  document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.pluginId === id));
  await renderActivePlugin();
}

async function renderActivePlugin() {
  if (!state.activePlugin) return;
  const mod = state.pluginModules.get(state.activePlugin);
  if (!mod?.render) {
    pluginPanel.innerHTML = '<div class="empty">This plugin has no client surface.</div>';
    return;
  }
  const context = {
    rootPath: state.workspace?.root_path,
    file: state.file,
    panel: pluginPanel,
    api: (action, payload = {}) => request(`/api/plugins/${encodeURIComponent(state.activePlugin)}/action`, { method:'POST', body: JSON.stringify({ action, payload }) }),
    refreshFile: async () => {
      if (!state.file) return;
      state.file = await request(`/api/file?root=${encodeURIComponent(state.workspace.root_path)}&path=${encodeURIComponent(state.file.path)}`);
      stateBadge.textContent = state.file.artifact?.state || 'working';
      fileMeta.textContent = `${state.file.path} · sha256 ${state.file.checksum.slice(0,12)}…`;
    },
    rerender: renderActivePlugin,
    notify: setStatus
  };
  await mod.render(context);
}

function showError(error) {
  console.error(error);
  setStatus(`${error.data?.error || 'ERROR'}: ${error.message}`, 'error');
  if (error.data?.preflight) alert(`${error.message}\n\n${JSON.stringify(error.data.preflight, null, 2)}`);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

$('addWorkspace').onclick = async () => {
  const rootPath = prompt('Absolute folder path to add:');
  if (!rootPath) return;
  try {
    const ws = await request('/api/workspaces', { method:'POST', body: JSON.stringify({ rootPath }) });
    await loadWorkspaces(ws.root_path);
  } catch (error) { showError(error); }
};

workspaceSelect.onchange = async () => {
  if (state.dirty && !confirm('Discard unsaved editor changes?')) {
    workspaceSelect.value = state.workspace?.root_path || '';
    return;
  }
  state.workspace = state.workspaces.find(ws => ws.root_path === workspaceSelect.value);
  state.file = null;
  state.dirty = false;
  editor.value = '';
  editor.disabled = true;
  fileName.textContent = 'Select a file';
  fileMeta.textContent = '';
  stateBadge.textContent = '—';
  await renderTree();
  await renderActivePlugin();
};

$('saveFile').onclick = () => saveFile().catch(showError);
editor.addEventListener('input', () => { state.dirty = true; setStatus('Unsaved working changes.'); });
window.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    saveFile().catch(showError);
  }
});

await Promise.all([loadWorkspaces(), loadPlugins()]);
