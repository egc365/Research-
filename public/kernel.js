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
const workspaceDialog = $('workspaceDialog');
const shell = $('shell');
const sidebarBody = $('sidebarBody');
const customizeDialog = $('customizeDialog');
const customizeBody = $('customizeBody');

// Small persisted UI memory (localStorage): last workspace, and per-workspace
// the active station and selected file. Purely convenience — the SQLite
// crosswalk stays the only authority on composition.
const uiMemory = {
  read() { try { return JSON.parse(localStorage.getItem('ro.ui') || '{}'); } catch { return {}; } },
  patch(fn) { try { const s = this.read(); fn(s); localStorage.setItem('ro.ui', JSON.stringify(s)); } catch { /* storage may be unavailable */ } }
};

const kernel = {
  workspaces: [],
  workspace: null,
  composition: { catalog: [], enabled: [], stations: {} },
  activeStation: null,
  selection: null,          // last loaded file record {path, content, checksum, artifact}
  card: null,               // selected block card id, shared across contributions
  modules: new Map(),       // contribution id -> imported module
  disposers: [],            // functions run before every re-composition
  sidebarDisposers: [],     // sidebar section unmounts, run on workspace switch
  dirtyGuards: [],          // contributions veto navigation (unsaved editor text)
  prefs: { user: {}, workspace: {} },  // appearance + navigation preferences
  sidebarSections: []       // sidebar_sections rows for the current workspace
};

// -------------------------------------------------------- appearance engine
// Preferences are validated JSON in SQLite (workspace overrides user overrides
// defaults). They only retune the design tokens — plugin business logic never
// changes with appearance, and plugins never ship their own themes.

const appearanceDefaults = {
  theme: 'system', density: 'comfortable', accent: '#4fa3ff', radius: 'rounded',
  fontSize: 14, editorFontSize: 13, sidebar: { width: 280, collapsed: false }
};

function mergedPrefs(draft = null) {
  return {
    ...appearanceDefaults,
    ...kernel.prefs.user,
    ...kernel.prefs.workspace,
    ...(draft || {}),
    sidebar: {
      ...appearanceDefaults.sidebar,
      ...(kernel.prefs.user.sidebar || {}),
      ...(kernel.prefs.workspace.sidebar || {}),
      ...((draft && draft.sidebar) || {})
    }
  };
}

function applyAppearance(draft = null) {
  const p = mergedPrefs(draft);
  const rootEl = document.documentElement;
  if (p.theme === 'system') {
    rootEl.dataset.theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } else {
    rootEl.dataset.theme = p.theme;
  }
  rootEl.style.setProperty('--accent', p.accent);
  rootEl.style.setProperty('--radius', p.radius === 'square' ? '2px' : '8px');
  rootEl.style.setProperty('--font-size', `${p.fontSize}px`);
  rootEl.style.setProperty('--editor-font-size', `${p.editorFontSize}px`);
  rootEl.style.setProperty('--spacing', p.density === 'compact' ? '6px' : '10px');
  rootEl.style.setProperty('--sidebar-width', `${p.sidebar.width}px`);
  shell.classList.toggle('sidebar-collapsed', p.sidebar.collapsed === true);
}

matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => applyAppearance());

async function loadPrefs() {
  const root = kernel.workspace ? `?root=${encodeURIComponent(kernel.workspace.root_path)}` : '';
  const prefs = await request(`/api/ui-preferences${root}`);
  kernel.prefs = prefs;
  applyAppearance();
}

async function savePrefs(patch, { userScope = false } = {}) {
  const saved = await request('/api/ui-preferences', {
    method: 'POST',
    body: JSON.stringify(userScope
      ? { scope: 'user', patch }
      : { rootPath: kernel.workspace?.root_path, patch })
  });
  if (userScope) kernel.prefs.user = saved; else kernel.prefs.workspace = saved;
  applyAppearance();
  return saved;
}

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
  uiMemory.patch(s => { (s.selection ??= {})[kernel.workspace.root_path] = record.path; });
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

function makeContext(stationId, config, wiringRows = null) {
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
    // The wiring rows of the station this contribution is mounted in — lets a
    // contribution offer an action only when its handler is actually composed
    // (e.g. the tree shows "Labels…" only when label-editor is wired here).
    get wiring() { return wiringRows || kernel.composition.stations[stationId] || []; },
    activateStation,
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

// A registered workspace whose folder is gone from disk (moved or deleted
// outside the app). Nothing can mount against it, so the stage explains and
// offers the one useful verb instead of letting every contribution ENOENT.
function workspaceMissing() {
  return Boolean(kernel.workspace) && kernel.workspace.exists === false;
}

function renderMissingFrame() {
  stage.className = 'stage layout-main';
  const frame = document.createElement('div');
  frame.className = 'empty-frame';
  frame.innerHTML = `
    <div class="ws-name">Workspace folder is missing on disk</div>
    <div class="muted mono" style="word-break:break-all">${esc(kernel.workspace.root_path)}</div>
    <div>The registration outlived its folder — it was moved or deleted outside this app.
    Restore the folder at that path, or unregister the workspace here.</div>
    <button id="missingUnregister" class="danger">Unregister this workspace</button>`;
  stage.append(frame);
  frame.querySelector('#missingUnregister').onclick = async () => {
    const name = kernel.workspace.label || kernel.workspace.root_path;
    if (!confirm(`Unregister workspace '${name}'? Only the registration is removed.`)) return;
    try {
      await request('/api/workspaces/remove', { method: 'POST', body: JSON.stringify({ rootPath: kernel.workspace.root_path }) });
      notify(`Unregistered '${name}'.`, 'ok');
      kernel.workspace = null;
      await loadWorkspaces();
    } catch (error) { showError(error); }
  };
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
       <div>A workspace is a folder plus its own set of plugins.</div>
       <button id="emptyAddWorkspace" class="primary">＋ Workspace</button>`;
  stage.append(frame);
  frame.querySelector('#emptyAddPlugin')?.addEventListener('click', openPluginManager);
  frame.querySelector('#emptyAddWorkspace')?.addEventListener('click', openWorkspaceDialog);
}

async function loadModule(row) {
  if (!kernel.modules.has(row.contribution_id)) {
    kernel.modules.set(row.contribution_id, await import(row.client_entry));
  }
  return kernel.modules.get(row.contribution_id);
}

async function activateStation(stationId) {
  if (navigationBlocked()) return;
  // Guard before tearing anything down: a target station that is not enabled
  // for this workspace must not blank the current view ("Open in X" buttons).
  const station = enabledStations().find(row => row.plugin_id === stationId);
  if (!station) {
    notify(`${stationId} is not enabled for this workspace — enable it in Plugins ⚙.`, 'error');
    if (kernel.activeStation) return;
    return renderEmptyFrame();
  }
  disposeMounts();
  kernel.activeStation = stationId;
  if (kernel.workspace) uiMemory.patch(s => { (s.station ??= {})[kernel.workspace.root_path] = stationId; });
  renderStationBar();
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
  if (workspaceMissing()) {
    kernel.activeStation = null;
    renderStationBar();
    return renderMissingFrame();
  }
  const available = enabledStations();
  if (!available.length) {
    kernel.activeStation = null;
    renderStationBar();
    return renderEmptyFrame();
  }
  const remembered = kernel.workspace ? uiMemory.read().station?.[kernel.workspace.root_path] : null;
  const target = keepStation && available.some(row => row.plugin_id === kernel.activeStation)
    ? kernel.activeStation
    : available.some(row => row.plugin_id === remembered) ? remembered
    : available[0].plugin_id;
  await activateStation(target);
}

// ------------------------------------------------------------------ sidebar
// The sidebar frame is kernel chrome; its content is plugin sections from
// sidebar_sections rows (visible, collapsed, ordered, per workspace). A
// headless contribution (manifest.headless) mounts with no section chrome.

function disposeSidebar() {
  for (const dispose of kernel.sidebarDisposers.splice(0)) {
    try { dispose(); } catch (error) { console.error('sidebar dispose', error); }
  }
  sidebarBody.replaceChildren();
}

async function renderSidebar() {
  disposeSidebar();
  if (!kernel.workspace) return;
  if (workspaceMissing()) {
    sidebarBody.innerHTML = '<div class="empty">Workspace folder is missing on disk.</div>';
    return;
  }
  kernel.sidebarSections = await request(`/api/sidebar?root=${encodeURIComponent(kernel.workspace.root_path)}`);
  const catalog = new Map(kernel.composition.catalog.map(row => [row.plugin_id, row]));
  const sidebarWiring = kernel.sidebarSections.map(row => ({ contribution_id: row.section_id, slot_name: 'sidebar', config: row.config }));
  for (const row of kernel.sidebarSections) {
    if (!row.visible) continue;
    const contribution = catalog.get(row.section_id);
    if (!contribution || !contribution.enabled || !contribution.client_entry) continue;
    const headless = contribution.manifest?.headless === true;
    const wrap = document.createElement('div');
    wrap.className = 'section' + (row.collapsed && !headless ? ' collapsed' : '');
    let host = wrap;
    if (!headless) {
      const head = document.createElement('div');
      head.className = 'section-head';
      head.innerHTML = `<span data-caret>${row.collapsed ? '▸' : '⌄'}</span><span>${esc(contribution.label)}</span>`;
      head.onclick = async () => {
        const collapsed = !wrap.classList.contains('collapsed');
        wrap.classList.toggle('collapsed', collapsed);
        head.querySelector('[data-caret]').textContent = collapsed ? '▸' : '⌄';
        await request('/api/sidebar', { method: 'POST', body: JSON.stringify({
          rootPath: kernel.workspace.root_path, sectionId: row.section_id, collapsed
        }) }).catch(showError);
      };
      const body = document.createElement('div');
      body.className = 'section-body';
      wrap.append(head, body);
      host = body;
    }
    sidebarBody.append(wrap);
    try {
      const module = kernel.modules.get(row.section_id)
        || (await import(contribution.client_entry).then(m => (kernel.modules.set(row.section_id, m), m)));
      const { ctx, dispose } = makeContext('sidebar', row.config, sidebarWiring);
      const unmount = await module.mount(host, ctx);
      kernel.sidebarDisposers.push(() => { if (typeof unmount === 'function') unmount(); dispose(); });
    } catch (error) {
      console.error(`sidebar mount ${row.section_id}`, error);
      host.innerHTML = `<div class="muted">${esc(contribution.label)} failed: ${esc(error.message)}</div>`;
    }
  }
}

// Sidebar chrome: collapse toggle and drag-resize, persisted per workspace.
$('toggleSidebar').onclick = async () => {
  const collapsed = !shell.classList.contains('sidebar-collapsed');
  shell.classList.toggle('sidebar-collapsed', collapsed);
  if (kernel.workspace) await savePrefs({ sidebar: { ...mergedPrefs().sidebar, collapsed } }).catch(showError);
};
$('sidebarResizer').onmousedown = event => {
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = mergedPrefs().sidebar.width;
  const move = e => {
    const width = Math.min(560, Math.max(180, startWidth + e.clientX - startX));
    document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
  };
  const up = async e => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    const width = Math.min(560, Math.max(180, startWidth + e.clientX - startX));
    if (kernel.workspace) await savePrefs({ sidebar: { ...mergedPrefs().sidebar, width } }).catch(showError);
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
};
$('sidebarNew').onclick = () => bus.emit('new-entry');
$('sidebarPlugins').onclick = () => openPluginManager();

// ---------------------------------------------------------------- workspaces

async function loadWorkspaces(selectPath = null) {
  kernel.workspaces = await request('/api/workspaces');
  workspaceSelect.replaceChildren();
  for (const ws of kernel.workspaces) {
    const option = document.createElement('option');
    option.value = ws.root_path;
    option.textContent = (ws.label || ws.root_path) + (ws.exists === false ? ' ⚠ missing on disk' : '');
    workspaceSelect.append(option);
  }
  // A contribution (the launchpad) may ask the kernel to switch workspaces.
  if (!kernel._switchHooked) {
    kernel._switchHooked = true;
    bus.on('switch-workspace', ({ root }) => {
      if (navigationBlocked()) return;
      loadWorkspaces(root).catch(showError);
    });
  }
  const wanted = selectPath || kernel.workspace?.root_path || uiMemory.read().workspace || kernel.workspaces[0]?.root_path;
  kernel.workspace = kernel.workspaces.find(ws => ws.root_path === wanted) || kernel.workspaces[0] || null;
  if (kernel.workspace) {
    workspaceSelect.value = kernel.workspace.root_path;
    uiMemory.patch(s => { s.workspace = kernel.workspace.root_path; });
  }
  kernel.selection = null;
  kernel.card = null;
  bus.emit('workspace', kernel.workspace);
  await loadPrefs().catch(showError);
  await recompose(false);
  await renderSidebar().catch(showError);
  const rememberedFile = kernel.workspace ? uiMemory.read().selection?.[kernel.workspace.root_path] : null;
  if (rememberedFile) await selectFile(rememberedFile).catch(() => { /* the file may be gone; stay silent */ });
}

function openWorkspaceDialog() {
  $('wsName').value = '';
  $('wsPath').value = '';
  $('wsCreate').checked = true;
  workspaceDialog.showModal();
}

async function createWorkspace(event) {
  event.preventDefault();
  const rootPath = $('wsPath').value.trim();
  if (!rootPath.startsWith('/')) return notify('The folder path must be absolute (start with /).', 'error');
  try {
    const ws = await request('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ rootPath, label: $('wsName').value.trim() || null, create: $('wsCreate').checked })
    });
    workspaceDialog.close();
    notify(`Workspace ready: ${ws.label || ws.root_path}. Enable stations in Plugins ⚙.`, 'ok');
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

  // Owner-defined stations: name it, pick a layout, then wire contributions
  // into its slots below exactly like a shipped station.
  const maker = document.createElement('details');
  maker.className = 'pm-station';
  maker.innerHTML = `
    <summary>＋ New station</summary>
    <div class="pm-add" style="margin-top:8px">
      <input data-role="st-label" placeholder="station name (e.g. Reading room)">
      <select data-role="st-layout">
        <option value="rail-main-side">rail + main + side</option>
        <option value="main-side">main + side</option>
        <option value="rail-main">rail + main</option>
        <option value="main">main only</option>
      </select>
      <input data-role="st-icon" placeholder="icon" value="★" style="width:42px">
      <button data-role="st-make" class="primary">Create</button>
    </div>`;
  maker.querySelector('[data-role="st-make"]').onclick = async () => {
    const label = maker.querySelector('[data-role="st-label"]').value.trim();
    if (!label) return notify('Give the station a name.', 'error');
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    try {
      await request('/api/stations', { method: 'POST', body: JSON.stringify({
        id, label,
        layout: maker.querySelector('[data-role="st-layout"]').value,
        icon: maker.querySelector('[data-role="st-icon"]').value || '★'
      }) });
      await togglePlugin(id, true); // enable it here and rerender the manager
      notify(`Station '${label}' created — wire contributions into its slots below.`, 'ok');
    } catch (error) { showError(error); }
  };
  pluginManagerBody.append(maker);

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

// ---------------------------------------------------------- customize dialog
// Appearance / Sidebar / Dashboard / Plugins. Changes preview live on the
// tokens; Save persists to workspace preferences (or user scope with the
// apply-everywhere box); Reset deletes this workspace's stored preferences.

function renderCustomize(tab = 'appearance') {
  if (!kernel.workspace) { customizeBody.innerHTML = '<div class="empty">Pick a workspace first.</div>'; return; }
  const p = mergedPrefs();
  customizeBody.innerHTML = `
    <div class="dual-tabs" data-role="tabs">
      ${['workspace', 'appearance', 'sidebar', 'dashboard', 'plugins'].map(t =>
        `<button data-tab="${t}" class="${t === tab ? 'active' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
    </div>
    <div data-role="pane"></div>`;
  customizeBody.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => renderCustomize(b.dataset.tab));
  const pane = customizeBody.querySelector('[data-role="pane"]');

  if (tab === 'workspace') {
    pane.innerHTML = `
      <div class="ws-form">
        <label>Name <input data-role="ws-label" value="${esc(kernel.workspace.label || '')}"></label>
        <label>Icon (emoji, shown in the switcher) <input data-role="ws-icon" value="${esc(p.icon || '')}" maxlength="4" style="width:70px"></label>
        <div class="muted mono" style="word-break:break-all">${esc(kernel.workspace.root_path)}</div>
        <div class="ws-actions" style="gap:6px">
          <button data-role="ws-remove" class="danger">Remove workspace…</button>
          <button data-role="ws-save" class="primary">Save</button>
        </div>
        <div class="muted">Removing unregisters the workspace here — its folder and files stay on disk exactly as they are.</div>
      </div>`;
    pane.querySelector('[data-role="ws-save"]').onclick = async () => {
      try {
        const label = pane.querySelector('[data-role="ws-label"]').value.trim() || null;
        await request('/api/workspaces', { method: 'POST', body: JSON.stringify({ rootPath: kernel.workspace.root_path, label }) });
        const icon = pane.querySelector('[data-role="ws-icon"]').value.trim();
        await savePrefs({ icon });
        notify('Workspace updated.', 'ok');
        await loadWorkspaces(kernel.workspace.root_path);
        renderCustomize('workspace');
      } catch (error) { showError(error); }
    };
    pane.querySelector('[data-role="ws-remove"]').onclick = async () => {
      const name = kernel.workspace.label || kernel.workspace.root_path;
      if (!confirm(`Remove workspace '${name}' from Research Operations?\nThe folder and its files stay on disk untouched.`)) return;
      try {
        await request('/api/workspaces/remove', { method: 'POST', body: JSON.stringify({ rootPath: kernel.workspace.root_path }) });
        customizeDialog.close();
        notify(`Removed workspace '${name}'. Its folder is untouched.`, 'ok');
        kernel.workspace = null;
        await loadWorkspaces();
      } catch (error) { showError(error); }
    };
  }

  if (tab === 'appearance') {
    pane.innerHTML = `
      <div class="ws-form">
        <label>Theme
          <select data-pref="theme">${['system', 'dark', 'light'].map(v => `<option ${p.theme === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>Density
          <select data-pref="density">${['comfortable', 'compact'].map(v => `<option ${p.density === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>Accent <input data-pref="accent" type="color" value="${esc(p.accent)}"></label>
        <label>Corners
          <select data-pref="radius">${['rounded', 'square'].map(v => `<option ${p.radius === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>Font size <input data-pref="fontSize" type="number" min="11" max="20" value="${p.fontSize}"></label>
        <label>Editor font size <input data-pref="editorFontSize" type="number" min="11" max="22" value="${p.editorFontSize}"></label>
        <label class="ws-check"><input data-role="user-scope" type="checkbox"> Apply to all my workspaces (user default)</label>
        <div class="ws-actions" style="gap:6px">
          <button data-role="reset">Reset to defaults</button>
          <button data-role="save" class="primary">Save</button>
        </div>
      </div>`;
    const draft = () => {
      const read = sel => pane.querySelector(`[data-pref="${sel}"]`).value;
      return {
        theme: read('theme'), density: read('density'), accent: read('accent'),
        radius: read('radius'), fontSize: Number(read('fontSize')), editorFontSize: Number(read('editorFontSize'))
      };
    };
    pane.querySelectorAll('[data-pref]').forEach(el => el.oninput = () => applyAppearance(draft()));
    pane.querySelector('[data-role="save"]').onclick = async () => {
      const userScope = pane.querySelector('[data-role="user-scope"]').checked;
      await savePrefs(draft(), { userScope }).catch(showError);
      notify(userScope ? 'Saved as your default appearance.' : 'Saved for this workspace.', 'ok');
    };
    pane.querySelector('[data-role="reset"]').onclick = async () => {
      await request('/api/ui-preferences', { method: 'POST', body: JSON.stringify({ rootPath: kernel.workspace.root_path, reset: true }) }).catch(showError);
      kernel.prefs.workspace = {};
      applyAppearance();
      renderCustomize('appearance');
      notify('This workspace is back to defaults.', 'ok');
    };
  }

  if (tab === 'sidebar') {
    const rows = kernel.sidebarSections;
    const catalog = new Map(kernel.composition.catalog.map(r => [r.plugin_id, r]));
    pane.innerHTML = `<div data-role="rows"></div>
      <div class="muted" style="margin-top:8px">Width: drag the sidebar edge. Sections are plugins — new ones appear here once registered.</div>`;
    const host = pane.querySelector('[data-role="rows"]');
    rows.forEach((row, index) => {
      const label = catalog.get(row.section_id)?.label || row.section_id;
      const line = document.createElement('div');
      line.className = 'pm-wire-row';
      line.innerHTML = `
        <label style="flex:1;display:flex;gap:8px;align-items:center">
          <input type="checkbox" ${row.visible ? 'checked' : ''}> ${esc(label)}</label>
        <button data-dir="-1" title="Move up" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button data-dir="1" title="Move down" ${index === rows.length - 1 ? 'disabled' : ''}>↓</button>`;
      const save = async patch => {
        await request('/api/sidebar', { method: 'POST', body: JSON.stringify({
          rootPath: kernel.workspace.root_path, sectionId: row.section_id, ...patch
        }) }).catch(showError);
        await renderSidebar().catch(showError);
        kernel.sidebarSections = await request(`/api/sidebar?root=${encodeURIComponent(kernel.workspace.root_path)}`);
        renderCustomize('sidebar');
      };
      line.querySelector('input').onchange = e => save({ visible: e.target.checked });
      line.querySelectorAll('[data-dir]').forEach(b => b.onclick = async () => {
        const dir = Number(b.dataset.dir);
        const neighbor = rows[index + dir];
        if (!neighbor) return;
        await request('/api/sidebar', { method: 'POST', body: JSON.stringify({
          rootPath: kernel.workspace.root_path, sectionId: row.section_id, sortOrder: neighbor.sort_order }) }).catch(showError);
        await save({ sectionId: neighbor.section_id, sortOrder: row.sort_order, visible: neighbor.visible === 1 });
      });
      host.append(line);
    });
  }

  if (tab === 'dashboard') {
    const links = mergedPrefs().links || [];
    pane.innerHTML = `
      <div class="muted" style="margin-bottom:8px">The dashboard's content blocks (launchpad, inbox, statistics) are wired in Plugins. Extra launchpad links for THIS workspace live here.</div>
      <div data-role="links"></div>
      <div class="pm-add"><input data-role="new-label" placeholder="label (e.g. Extraction app)">
        <input data-role="new-url" class="mono" placeholder="http://127.0.0.1:7860">
        <button data-role="add">Add link</button></div>`;
    const host = pane.querySelector('[data-role="links"]');
    const saveLinks = async next => {
      await savePrefs({ links: next }).catch(showError);
      bus.emit('prefs-changed');
      renderCustomize('dashboard');
    };
    links.forEach((link, index) => {
      const line = document.createElement('div');
      line.className = 'pm-wire-row';
      line.innerHTML = `<span style="flex:1">${esc(link.label)} <span class="muted mono">${esc(link.url)}</span></span>
        <button class="danger">✕</button>`;
      line.querySelector('button').onclick = () => saveLinks(links.filter((_, i) => i !== index));
      host.append(line);
    });
    pane.querySelector('[data-role="add"]').onclick = () => {
      const label = pane.querySelector('[data-role="new-label"]').value.trim();
      const url = pane.querySelector('[data-role="new-url"]').value.trim();
      if (!label || !url) return notify('A link needs a label and a URL.', 'error');
      saveLinks([...links, { label, url }]);
    };
  }

  if (tab === 'plugins') {
    pane.innerHTML = '<div class="muted" style="margin-bottom:8px">Stations and wiring live in the plugin manager.</div>';
    const open = document.createElement('button');
    open.className = 'primary';
    open.textContent = 'Open plugin manager';
    open.onclick = () => { customizeDialog.close(); openPluginManager(); };
    pane.append(open);
  }
}

$('openCustomize').onclick = () => { renderCustomize(); customizeDialog.showModal(); };
$('closeCustomize').onclick = () => customizeDialog.close();

// ---------------------------------------------------------------------- wiring

function showError(error) {
  console.error(error);
  notify(`${error.data?.error || 'ERROR'}: ${error.message}`, 'error');
}

$('openPluginManager').onclick = openPluginManager;
$('closePluginManager').onclick = () => pluginManager.close();
$('newWorkspace').onclick = openWorkspaceDialog;
$('closeWorkspaceDialog').onclick = () => workspaceDialog.close();
$('workspaceForm').addEventListener('submit', createWorkspace);
workspaceSelect.onchange = async () => {
  if (navigationBlocked()) { workspaceSelect.value = kernel.workspace?.root_path || ''; return; }
  await loadWorkspaces(workspaceSelect.value).catch(showError);
};

loadWorkspaces().catch(showError);
