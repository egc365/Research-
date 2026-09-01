// UI composition kernel. It owns: workspace selection, the plugin manager,
// the slot renderer, plugin lifecycle (mount -> dispose), the selected
// file, the active station, and the shared event bus + services. It owns
// no domain behavior — with nothing enabled it renders the empty frame.

const $ = id => document.getElementById(id);
const stage = $('stage');
const stationBar = $('stationBar');
const workspaceSelect = $('workspaceSelect');
const statusBar = $('statusBar');
const pluginManager = $('pluginManager');
const pluginManagerBody = $('pluginManagerBody');

const kernel = {
  workspaces: [],
  workspace: null,
  composition: { catalog: [], enabled: [], stations: {} },
  activeStation: null,
  selection: null,          // last loaded file record {path, content, checksum, artifact}
  card: null,               // selected block card id, shared across contributions
  modules: new Map(),       // contribution id -> imported module
  disposers: [],            // functions run before every re-composition
  dirtyGuards: []           // contributions veto navigation (unsaved editor text)
};

// ------------------------------------------------------------- shared services

const handlers = new Map();
const bus = {
  on(event, fn) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(fn);
    return () => handlers.get(event)?.delete(fn);
  },
  emit(event, data) {
    for (const fn of handlers.get(event) || []) {
      try { fn(data); } catch (error) { console.error(`bus handler for ${event}`, error); }
    }
  }
};

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

const esc = value => String(value ?? '').replace(/[&<>"']/g,
  ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch]));

function notify(message, kind = 'info') {
  statusBar.textContent = message;
  statusBar.dataset.kind = kind;
}

async function selectFile(path) {
  if (!kernel.workspace) return;
  const record = await request(`/api/file?root=${encodeURIComponent(kernel.workspace.root_path)}&path=${encodeURIComponent(path)}`);
  kernel.selection = record;
  kernel.card = null;
  bus.emit('selection', record);
  notify(`Loaded ${path.split('/').pop()} · sha256 ${record.checksum.slice(0, 12)}…`);
  return record;
}

async function refreshSelection() {
  if (!kernel.selection) return null;
  return selectFile(kernel.selection.path);
}

async function saveFile(content, actor = 'human') {
  if (!kernel.selection || !kernel.workspace) throw new Error('No file is selected');
  const result = await request('/api/file', {
    method: 'PUT',
    body: JSON.stringify({
      rootPath: kernel.workspace.root_path,
      path: kernel.selection.path,
      content,
      expectedChecksum: kernel.selection.checksum,
      actor
    })
  });
  kernel.selection = result;
  bus.emit('selection', result);
  bus.emit('file-saved', result);
  notify(`Saved · sha256 ${result.checksum.slice(0, 12)}… · ${result.preflight?.length || 0} preflight check(s)`, 'ok');
  return result;
}

function makeContext(stationId, config) {
  const offs = [];
  const ctx = {
    get workspace() { return kernel.workspace; },
    get selection() { return kernel.selection; },
    get card() { return kernel.card; },
    setCard(cardId) { kernel.card = cardId; bus.emit('card', cardId); },
    station: stationId,
    config: config || {},
    request,
    action: (serviceId, action, payload = {}) =>
      request(`/api/plugins/${encodeURIComponent(serviceId)}/action`, {
        method: 'POST', body: JSON.stringify({ action, payload })
      }),
    bus: {
      on(event, fn) { const off = bus.on(event, fn); offs.push(off); return off; },
      emit: bus.emit
    },
    selectFile, refreshSelection, saveFile,
    notify, esc,
    onDirty(guard) { kernel.dirtyGuards.push(guard); }
  };
  return { ctx, dispose: () => offs.forEach(off => off()) };
}

// ---------------------------------------------------------------- composition

function navigationBlocked() {
  const blocking = kernel.dirtyGuards.find(guard => guard());
  return blocking ? !confirm('Discard unsaved changes?') : false;
}

function disposeMounts() {
  for (const dispose of kernel.disposers.splice(0)) {
    try { dispose(); } catch (error) { console.error('dispose', error); }
  }
  kernel.dirtyGuards = [];
  stage.replaceChildren();
  stage.className = 'stage';
}

async function loadComposition() {
  const root = kernel.workspace ? `?root=${encodeURIComponent(kernel.workspace.root_path)}` : '';
  kernel.composition = await request(`/api/composition${root}`);
}

function enabledStations() {
  return kernel.composition.enabled.filter(row => row.plugin_kind === 'station');
}

function renderStationBar() {
  stationBar.replaceChildren();
  for (const row of enabledStations()) {
    const button = document.createElement('button');
    button.textContent = `${row.manifest.icon || ''} ${row.label}`.trim();
    button.classList.toggle('active', row.plugin_id === kernel.activeStation);
    button.onclick = () => activateStation(row.plugin_id);
    stationBar.append(button);
  }
}

function renderEmptyFrame() {
  stage.className = 'stage layout-main';
  const frame = document.createElement('div');
  frame.className = 'empty-frame';
  frame.innerHTML = kernel.workspace
    ? `<div class="ws-name">Workspace: ${esc(kernel.workspace.label || kernel.workspace.root_path)}</div>
       <div>No views loaded</div>
       <button id="emptyAddPlugin" class="primary">+ Add plugin</button>`
    : `<div class="ws-name">No workspace</div>
       <div>Register an absolute folder path to begin.</div>
       <button id="emptyAddWorkspace" class="primary">+ Add path</button>`;
  stage.append(frame);
  frame.querySelector('#emptyAddPlugin')?.addEventListener('click', openPluginManager);
  frame.querySelector('#emptyAddWorkspace')?.addEventListener('click', addWorkspace);
}

async function loadModule(row) {
  if (!kernel.modules.has(row.contribution_id)) {
    kernel.modules.set(row.contribution_id, await import(row.client_entry));
  }
  return kernel.modules.get(row.contribution_id);
}

async function activateStation(stationId) {
  if (navigationBlocked()) return;
  disposeMounts();
  kernel.activeStation = stationId;
  renderStationBar();
  const station = enabledStations().find(row => row.plugin_id === stationId);
  if (!station) return renderEmptyFrame();
  const layout = station.manifest.layout || 'main';
  const slots = station.manifest.slots || ['main'];
  stage.className = `stage layout-${layout}`;
  const slotEls = {};
  for (const name of slots) {
    const el = document.createElement('div');
    el.className = `slot slot-${name}`;
    el.dataset.slot = name;
    stage.append(el);
    slotEls[name] = el;
  }
  const wired = kernel.composition.stations[stationId] || [];
  for (const row of wired) {
    const host = slotEls[row.slot_name];
    if (!host) continue;
    const section = document.createElement('section');
    host.append(section);
    try {
      const module = await loadModule(row);
      const { ctx, dispose } = makeContext(stationId, row.config);
      const unmount = await module.mount(section, ctx);
      kernel.disposers.push(() => { if (typeof unmount === 'function') unmount(); dispose(); });
    } catch (error) {
      console.error(`mount ${row.contribution_id}`, error);
      section.innerHTML = `<div class="card"><h3>${esc(row.label)}</h3><div class="muted">Failed to mount: ${esc(error.message)}</div></div>`;
    }
  }
  for (const [name, el] of Object.entries(slotEls)) {
    if (!el.children.length) el.innerHTML = `<div class="empty">Empty slot: ${esc(name)}. Wire a contribution in Plugins ⚙.</div>`;
  }
}

async function recompose(keepStation = true) {
  disposeMounts();
  await loadComposition();
  const available = enabledStations();
  if (!available.length) {
    kernel.activeStation = null;
    renderStationBar();
    return renderEmptyFrame();
  }
  const target = keepStation && available.some(row => row.plugin_id === kernel.activeStation)
    ? kernel.activeStation
    : available[0].plugin_id;
  await activateStation(target);
}

// ---------------------------------------------------------------- workspaces

async function loadWorkspaces(selectPath = null) {
  kernel.workspaces = await request('/api/workspaces');
  workspaceSelect.replaceChildren();
  for (const ws of kernel.workspaces) {
    const option = document.createElement('option');
    option.value = ws.root_path;
    option.textContent = ws.label || ws.root_path;
    workspaceSelect.append(option);
  }
  const wanted = selectPath || kernel.workspace?.root_path || kernel.workspaces[0]?.root_path;
  kernel.workspace = kernel.workspaces.find(ws => ws.root_path === wanted) || null;
  if (kernel.workspace) workspaceSelect.value = kernel.workspace.root_path;
  kernel.selection = null;
  kernel.card = null;
  bus.emit('workspace', kernel.workspace);
  await recompose(false);
}

async function addWorkspace() {
  const rootPath = prompt('Absolute folder path to add:');
  if (!rootPath) return;
  try {
    const ws = await request('/api/workspaces', { method: 'POST', body: JSON.stringify({ rootPath }) });
    await loadWorkspaces(ws.root_path);
  } catch (error) { showError(error); }
}

// ------------------------------------------------------------- plugin manager

async function togglePlugin(pluginId, enabled) {
  await request('/api/composition/workspace', {
    method: 'POST',
    body: JSON.stringify({ rootPath: kernel.workspace.root_path, pluginId, enabled })
  });
  await recompose();
  renderPluginManager();
}

async function wireContribution(stationId, slotName, contributionId, remove = false) {
  await request('/api/composition/station', {
    method: 'POST',
    body: JSON.stringify({ stationId, slotName, contributionId, remove, sortOrder: remove ? 100 : Date.now() % 100000 })
  });
  await recompose();
  renderPluginManager();
}

function renderPluginManager() {
  if (!kernel.workspace) {
    pluginManagerBody.innerHTML = '<div class="empty">Add a workspace first.</div>';
    return;
  }
  const enabledIds = new Set(kernel.composition.enabled.map(row => row.plugin_id));
  const stations = kernel.composition.catalog.filter(row => row.plugin_kind === 'station' && row.enabled);
  const contributions = kernel.composition.catalog.filter(row => row.plugin_kind === 'contribution' && row.enabled);
  pluginManagerBody.replaceChildren();
  const intro = document.createElement('div');
  intro.className = 'muted';
  intro.style.marginBottom = '8px';
  intro.textContent = `Stations enabled for this workspace compose behaviors into slots. Wiring edits apply to the station everywhere; nothing here touches your files.`;
  pluginManagerBody.append(intro);

  for (const station of stations) {
    const box = document.createElement('div');
    box.className = 'pm-station';
    const isOn = enabledIds.has(station.plugin_id);
    box.innerHTML = `
      <label>
        <input type="checkbox" ${isOn ? 'checked' : ''} data-station="${esc(station.plugin_id)}">
        <span><strong>${esc(station.manifest.icon || '')} ${esc(station.label)}</strong>
        <span class="desc"> — ${esc(station.manifest.description || '')}</span></span>
      </label>`;
    box.querySelector('input').onchange = event =>
      togglePlugin(station.plugin_id, event.target.checked).catch(showError);

    if (isOn) {
      const wiring = document.createElement('div');
      wiring.className = 'pm-wiring';
      const wired = kernel.composition.stations[station.plugin_id] || [];
      for (const slotName of station.manifest.slots || []) {
        const label = document.createElement('div');
        label.className = 'slot-name';
        label.textContent = slotName;
        wiring.append(label);
        for (const row of wired.filter(r => r.slot_name === slotName)) {
          const line = document.createElement('div');
          line.className = 'pm-wire-row';
          line.innerHTML = `<span>${esc(row.label)}</span>
            <button class="danger" title="Remove from this slot">✕</button>`;
          line.querySelector('button').onclick = () =>
            wireContribution(station.plugin_id, slotName, row.contribution_id, true).catch(showError);
          wiring.append(line);
        }
      }
      const add = document.createElement('div');
      add.className = 'pm-add';
      add.innerHTML = `
        <select data-role="slot">${(station.manifest.slots || []).map(s => `<option>${esc(s)}</option>`).join('')}</select>
        <select data-role="contribution">${contributions.map(c => `<option value="${esc(c.plugin_id)}">${esc(c.label)}</option>`).join('')}</select>
        <button>Add</button>`;
      add.querySelector('button').onclick = () => wireContribution(
        station.plugin_id,
        add.querySelector('[data-role="slot"]').value,
        add.querySelector('[data-role="contribution"]').value
      ).catch(showError);
      wiring.append(add);
      box.append(wiring);
    }
    pluginManagerBody.append(box);
  }
}

function openPluginManager() {
  renderPluginManager();
  pluginManager.showModal();
}

// ---------------------------------------------------------------------- wiring

function showError(error) {
  console.error(error);
  notify(`${error.data?.error || 'ERROR'}: ${error.message}`, 'error');
}

$('openPluginManager').onclick = openPluginManager;
$('closePluginManager').onclick = () => pluginManager.close();
$('addWorkspace').onclick = addWorkspace;
workspaceSelect.onchange = async () => {
  if (navigationBlocked()) { workspaceSelect.value = kernel.workspace?.root_path || ''; return; }
  kernel.workspace = kernel.workspaces.find(ws => ws.root_path === workspaceSelect.value) || null;
  kernel.selection = null;
  kernel.card = null;
  bus.emit('workspace', kernel.workspace);
  await recompose(false).catch(showError);
};

loadWorkspaces().catch(showError);
