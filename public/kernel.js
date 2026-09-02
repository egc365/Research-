// UI composition kernel. It owns: workspace selection, the plugin manager,
// the slot renderer, plugin lifecycle (mount -> dispose), the selected
// file, the active station, and the shared event bus + services. It owns
// no domain behavior — with nothing enabled it renders the empty frame.

const $ = id => document.getElementById(id);
const stage = $('stage');
const stationBar = $('stationBar');
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
  sidebarSections: [],      // sidebar_sections rows for the current workspace
  boardPath: []             // board surface folder, one segment per element, from the root
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

bus.on('board-path', ({ path, source } = {}) => {
  const next = Array.isArray(path) ? path.map(String) : [];
  const prev = (kernel.boardPath || []).join('/');
  kernel.boardPath = next;
  if (skipHistory || source === 'history') return;
  if (next.join('/') === prev) return;
  commitHistory('push');
});

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

function relativeFile(p) {
  if (!p || !kernel.workspace) return p || null;
  const root = kernel.workspace.root_path;
  if (p === root) return '';
  return p.startsWith(root + '/') ? p.slice(root.length + 1) : p;
}

function snapshot() {
  return {
    ws: kernel.workspace?.root_path || null,
    station: kernel.activeStation || null,
    path: [...(kernel.boardPath || [])].map(String),
    file: relativeFile(kernel.selection?.path)
  };
}

function readUrlState() {
  const q = new URLSearchParams(location.search);
  const path = q.get('path');
  return {
    ws: q.get('ws') || null,
    station: q.get('station') || null,
    path: path ? path.split('/').filter(Boolean) : [],
    file: q.get('file') || null
  };
}

function urlHasNav(state) {
  return Boolean(state.ws || state.station || state.path?.length || state.file);
}

function urlFrom(state) {
  const q = new URLSearchParams();
  if (state.ws) q.set('ws', state.ws);
  if (state.station) q.set('station', state.station);
  if (state.path?.length) q.set('path', state.path.join('/'));
  if (state.file) q.set('file', state.file);
  const query = q.toString();
  return location.pathname + (query ? `?${query}` : '');
}

function sameNav(a, b) {
  if (!a || !b) return false;
  return a.ws === b.ws && a.station === b.station
    && (a.path || []).join('/') === (b.path || []).join('/')
    && (a.file || '') === (b.file || '');
}

let skipHistory = false;

function commitHistory(mode) {
  const state = snapshot();
  const url = urlFrom(state);
  if (mode === 'push') {
    if (sameNav(history.state, state) && `${location.pathname}${location.search}` === url) return;
    history.pushState(state, '', url);
  } else {
    history.replaceState(state, '', url);
  }
}

async function selectFile(path) {
  if (!kernel.workspace) return;
  const abs = path.startsWith('/') ? path : `${kernel.workspace.root_path}/${path}`;
  const record = await request(`/api/file?root=${encodeURIComponent(kernel.workspace.root_path)}&path=${encodeURIComponent(abs)}`);
  kernel.selection = record;
  kernel.card = null;
  uiMemory.patch(s => { (s.selection ??= {})[kernel.workspace.root_path] = record.path; });
  bus.emit('selection', record);
  notify(`Loaded ${abs.split('/').pop()} · sha256 ${record.checksum.slice(0, 12)}…`);
  if (!skipHistory) commitHistory('replace');
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

function makeContext(stationId, config, wiringRows = null, loc = {}) {
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
    get boardPath() { return kernel.boardPath || []; },
    // Which stations a contribution may offer to open — retired or disabled
    // ids (e.g. an old openIn config naming file-workbench) filter out.
    enabledStationIds: () => enabledStations().map(row => row.plugin_id),
    selectFile, refreshSelection, saveFile,
    notify, esc,
    onDirty(guard) { kernel.dirtyGuards.push(guard); },
    async patchConfig(patch) {
      const next = await saveWiringConfig(stationId, loc.slotName, loc.contributionId, patch);
      ctx.config = next;
      return next;
    }
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

// Curate and Monitor stay grouped. Plan dissolved: Board is an ungrouped
// home station, Inbox and Workspace are chrome dropdowns, not stations.
const CATEGORY_ORDER = ['Curate', 'Monitor'];
const HOME_STATION = 'dashboard-viewer';
const FRAME_STATIONS = ['dashboard-viewer', 'whiteboard'];

let inboxDispose = null;
let inboxBadgeEl = null;
let inboxBadgeStarted = false;
let inboxBadgeTimer = null;

function closeNavDrops() {
  if (inboxDispose) { inboxDispose(); inboxDispose = null; }
  for (const panel of stationBar.querySelectorAll('.nav-drop-panel')) panel.hidden = true;
  for (const wrap of stationBar.querySelectorAll('.nav-drop')) wrap.classList.remove('open');
}

async function refreshInboxBadge() {
  if (!inboxBadgeEl) return;
  try {
    const { count } = await request('/api/inbox/count');
    const n = Number(count) || 0;
    inboxBadgeEl.textContent = n ? String(n) : '';
    inboxBadgeEl.hidden = !n;
    const button = inboxBadgeEl.closest('button');
    if (button) button.setAttribute('aria-label', n ? `Inbox ${n}` : 'Inbox');
  } catch { /* badge is best-effort */ }
}

function startInboxBadge() {
  if (inboxBadgeStarted) return;
  inboxBadgeStarted = true;
  const refresh = () => refreshInboxBadge();
  bus.on('fs-changed', refresh);
  bus.on('artifact-changed', refresh);
  bus.on('file-saved', refresh);
  bus.on('workspace', refresh);
  inboxBadgeTimer = setInterval(refresh, 60_000);
}

window.addEventListener('beforeunload', () => {
  if (inboxBadgeTimer) {
    clearInterval(inboxBadgeTimer);
    inboxBadgeTimer = null;
  }
});

function stationButton(row) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.station = row.plugin_id;
  button.textContent = `${row.manifest.icon || ''} ${row.label}`.trim();
  button.classList.toggle('active', row.plugin_id === kernel.activeStation);
  button.onclick = () => activateStation(row.plugin_id);
  button.draggable = true;
  button.addEventListener('dragstart', event => {
    const json = JSON.stringify({ kind: 'app', station: row.plugin_id, label: row.label });
    event.dataTransfer.setData('application/x-ro-app', json);
    event.dataTransfer.setData('text/plain', 'ro-app:' + json);
    event.dataTransfer.effectAllowed = 'copy';
  });
  return button;
}

function navDropdown({ id, label, fill, badge = false }) {
  const wrap = document.createElement('div');
  wrap.className = 'nav-drop';
  wrap.id = id;
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-label', label);
  const labelEl = document.createElement('span');
  labelEl.textContent = label;
  button.append(labelEl);
  if (badge) {
    const countEl = document.createElement('span');
    countEl.className = 'inbox-badge';
    countEl.hidden = true;
    button.append(countEl);
    inboxBadgeEl = countEl;
  }
  const panel = document.createElement('div');
  panel.className = 'nav-drop-panel';
  panel.hidden = true;
  button.onclick = async event => {
    event.stopPropagation();
    const willOpen = panel.hidden;
    closeNavDrops();
    if (!willOpen) return;
    panel.hidden = false;
    wrap.classList.add('open');
    await fill(panel);
  };
  wrap.append(button, panel);
  return wrap;
}

async function fillInbox(panel) {
  if (inboxDispose) { inboxDispose(); inboxDispose = null; }
  panel.replaceChildren();
  const host = document.createElement('div');
  panel.append(host);
  try {
    const module = await loadModule(catalogClient('inbox'));
    const config = { ...(mergedPrefs().inbox || {}) };
    const { ctx, dispose } = makeContext(kernel.activeStation, config);
    const unmount = await module.mount(host, ctx);
    inboxDispose = () => { if (typeof unmount === 'function') unmount(); dispose(); };
  } catch (error) {
    host.innerHTML = `<div class="muted">Inbox failed: ${esc(error.message)}</div>`;
  }
}

function fillWorkspaces(panel) {
  panel.replaceChildren();
  const stations = document.createElement('div');
  stations.className = 'launch-row';
  panel.append(stations);
  for (const id of FRAME_STATIONS) {
    const row = enabledStations().find(s => s.plugin_id === id);
    if (!row) continue;
    const node = document.createElement('div');
    node.className = 'launch-chip';
    if (row.plugin_id === kernel.activeStation) node.classList.add('active');
    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.textContent = row.manifest.icon || '🗂';
    const label = document.createElement('span');
    label.textContent = row.label;
    node.append(ic, label);
    node.onclick = () => {
      closeNavDrops();
      activateStation(row.plugin_id);
    };
    stations.append(node);
  }
  const row = document.createElement('div');
  row.className = 'launch-row';
  panel.append(row);
  for (const ws of kernel.workspaces) {
    const isCurrent = ws.root_path === kernel.workspace?.root_path;
    const name = ws.label || ws.root_path.split('/').filter(Boolean).pop() || ws.root_path;
    const missing = ws.exists === false;
    const node = document.createElement('div');
    node.className = 'launch-chip';
    if (isCurrent) node.classList.add('active');
    node.title = missing ? `${ws.root_path} (missing on disk)` : ws.root_path;
    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.textContent = missing ? '⚠' : '🗂';
    const label = document.createElement('span');
    label.textContent = name;
    node.append(ic, label);
    if (!isCurrent) {
      node.onclick = () => {
        closeNavDrops();
        if (navigationBlocked()) return;
        loadWorkspaces(ws.root_path).catch(showError);
      };
    }
    row.append(node);
  }
  if (!kernel.workspaces.length) {
    panel.append(Object.assign(document.createElement('div'), { className: 'muted', textContent: 'No workspaces yet.' }));
  }
}

function renderStationBar() {
  closeNavDrops();
  stationBar.replaceChildren();
  const available = enabledStations();
  for (const id of FRAME_STATIONS) {
    const frame = available.find(row => row.plugin_id === id);
    if (frame) stationBar.append(stationButton(frame));
  }
  stationBar.append(navDropdown({
    id: 'navInbox',
    label: 'Inbox',
    fill: fillInbox,
    badge: true
  }));
  startInboxBadge();
  refreshInboxBadge();
  const wsName = kernel.workspace
    ? (kernel.workspace.label || kernel.workspace.root_path.split('/').filter(Boolean).pop() || 'Workspace')
    : 'Workspace';
  stationBar.append(navDropdown({
    id: 'navWorkspace',
    label: wsName,
    fill: fillWorkspaces
  }));
  const buckets = new Map();
  for (const row of available) {
    if (FRAME_STATIONS.includes(row.plugin_id)) continue;
    const category = row.manifest.category || 'More';
    if (!buckets.has(category)) buckets.set(category, []);
    buckets.get(category).push(row);
  }
  const order = [...CATEGORY_ORDER.filter(c => buckets.has(c)), ...[...buckets.keys()].filter(c => !CATEGORY_ORDER.includes(c))];
  for (const category of order) {
    const cluster = document.createElement('div');
    cluster.className = 'nav-cluster';
    cluster.dataset.category = category;
    if (CATEGORY_ORDER.includes(category)) {
      const tag = document.createElement('span');
      tag.className = 'nav-cluster-label';
      tag.textContent = category;
      cluster.append(tag);
    }
    for (const row of buckets.get(category)) cluster.append(stationButton(row));
    stationBar.append(cluster);
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

async function renderEmptyFrame() {
  stage.replaceChildren();
  stage.className = 'stage layout-main';
  const frame = document.createElement('div');
  if (kernel.workspace) {
    frame.className = 'empty-frame';
    frame.innerHTML = `<div class="ws-name">Workspace: ${esc(kernel.workspace.label || kernel.workspace.root_path)}</div>
       <div>No views loaded</div>
       <button id="emptyAddPlugin" class="primary">+ Add plugin</button>`;
    stage.append(frame);
    frame.querySelector('#emptyAddPlugin')?.addEventListener('click', openPluginManager);
    return;
  }
  // No workspace yet. Stations cannot activate, so the launchpad is the
  // frame (workspaces only) and chrome still owns ＋ Workspace.
  frame.className = 'empty-frame launchpad-host';
  const host = document.createElement('div');
  const add = document.createElement('button');
  add.id = 'emptyAddWorkspace';
  add.className = 'primary';
  add.textContent = '＋ Workspace';
  add.addEventListener('click', openWorkspaceDialog);
  frame.append(host, add);
  stage.append(frame);
  try {
    const module = await loadModule(catalogClient('launchpad'));
    const { ctx, dispose } = makeContext(null, {});
    const unmount = await module.mount(host, ctx);
    kernel.disposers.push(() => { if (typeof unmount === 'function') unmount(); dispose(); });
  } catch (error) {
    console.error('mount launchpad', error);
    host.innerHTML = `<div class="card"><div class="muted">Failed to mount: ${esc(error.message)}</div></div>`;
  }
}

async function loadModule(row) {
  if (!kernel.modules.has(row.contribution_id)) {
    kernel.modules.set(row.contribution_id, await import(row.client_entry));
  }
  return kernel.modules.get(row.contribution_id);
}

function catalogClient(id) {
  const row = kernel.composition.catalog.find(r => r.plugin_id === id);
  if (!row?.client_entry) throw new Error(`${id} is not in the catalog`);
  return { contribution_id: id, client_entry: row.client_entry };
}

function dragHasType(event, type) {
  return [...(event.dataTransfer?.types || [])].some(t => t.toLowerCase() === type);
}

function readDrag(event) {
  const widget = event.dataTransfer.getData('application/x-ro-widget');
  if (widget) {
    try { return { kind: 'widget', ...JSON.parse(widget) }; } catch { /* fall through */ }
  }
  const plain = event.dataTransfer.getData('text/plain') || '';
  if (plain.startsWith('ro-widget:')) {
    try { return { kind: 'widget', ...JSON.parse(plain.slice(10)) }; } catch { return null; }
  }
  return null;
}

function clearDropMarks() {
  for (const node of stage.querySelectorAll('.drop-before, .drop-after, .drop-slot')) {
    node.classList.remove('drop-before', 'drop-after', 'drop-slot');
  }
}

async function saveWiringConfig(stationId, slotName, contributionId, patch) {
  if (!stationId || !slotName || !contributionId) throw new Error('Cannot save wiring config');
  const row = (kernel.composition.stations[stationId] || []).find(
    r => r.contribution_id === contributionId && r.slot_name === slotName
  );
  const config = { ...(row?.config || {}) };
  for (const [key, value] of Object.entries(patch || {})) {
    if (key === 'label' && !String(value || '').trim()) delete config.label;
    else config[key] = value;
  }
  await request('/api/composition/station', {
    method: 'POST',
    body: JSON.stringify({
      stationId, slotName, contributionId,
      sortOrder: row?.sort_order ?? 100,
      config
    })
  });
  if (row) row.config = config;
  return config;
}

async function moveWired({ stationId, contributionId, fromSlot, toSlot, beforeContributionId }) {
  if (fromSlot === toSlot && contributionId === beforeContributionId) return;
  await request('/api/composition/station/move', {
    method: 'POST',
    body: JSON.stringify({ stationId, contributionId, fromSlot, toSlot, beforeContributionId: beforeContributionId || null })
  });
  await recompose();
}

function bindSlotDrops(stationId, slotEls) {
  for (const [name, el] of Object.entries(slotEls)) {
    el.addEventListener('dragover', event => {
      if (!dragHasType(event, 'application/x-ro-widget')) return;
      event.preventDefault();
      el.classList.add('drop-slot');
    });
    el.addEventListener('dragleave', event => {
      if (event.target === el) el.classList.remove('drop-slot');
    });
    el.addEventListener('drop', event => {
      el.classList.remove('drop-slot');
      const data = readDrag(event);
      if (data?.kind !== 'widget') return;
      event.preventDefault();
      moveWired({
        stationId: data.stationId || stationId,
        contributionId: data.contributionId,
        fromSlot: data.fromSlot,
        toSlot: name,
        beforeContributionId: null
      }).catch(showError);
    });
  }
}

function bindBoxReorder(box, stationId, row) {
  box.addEventListener('dragover', event => {
    if (!dragHasType(event, 'application/x-ro-widget')) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = box.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    box.classList.toggle('drop-before', before);
    box.classList.toggle('drop-after', !before);
    box.parentElement?.classList.remove('drop-slot');
  });
  box.addEventListener('dragleave', () => box.classList.remove('drop-before', 'drop-after'));
  box.addEventListener('drop', event => {
    if (!dragHasType(event, 'application/x-ro-widget')) return;
    event.preventDefault();
    event.stopPropagation();
    const data = readDrag(event);
    box.classList.remove('drop-before', 'drop-after');
    if (data?.kind !== 'widget') return;
    if (data.contributionId === row.contribution_id && data.fromSlot === row.slot_name) return;
    const rect = box.getBoundingClientRect();
    const dropBefore = event.clientY < rect.top + rect.height / 2;
    let beforeContributionId = null;
    if (dropBefore) beforeContributionId = row.contribution_id;
    else {
      const next = box.nextElementSibling;
      beforeContributionId = next?.dataset?.contribution || null;
    }
    moveWired({
      stationId: data.stationId || stationId,
      contributionId: data.contributionId,
      fromSlot: data.fromSlot,
      toSlot: row.slot_name,
      beforeContributionId
    }).catch(showError);
  });
}

function mountResizeEdge(box, stationId, slotName, contributionId) {
  const edge = document.createElement('div');
  edge.className = 'resize-edge';
  box.append(edge);
  edge.addEventListener('mousedown', event => {
    event.preventDefault();
    const startY = event.clientY;
    const startH = box.getBoundingClientRect().height;
    const move = ev => {
      const h = Math.max(80, Math.round(startH + ev.clientY - startY));
      box.style.height = `${h}px`;
      box.classList.add('has-height');
    };
    const up = async ev => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      const h = Math.max(80, Math.round(startH + ev.clientY - startY));
      box.style.height = `${h}px`;
      box.classList.add('has-height');
      try { await saveWiringConfig(stationId, slotName, contributionId, { height: h }); }
      catch (error) { showError(error); }
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

// Slim chrome on every mounted box. Fields come from the wiring row:
// stationId from activateStation, slotName/contributionId/label from
// kernel.composition.stations[stationId] (station_contributions JOIN ui_plugins).
// Contributions write host.innerHTML, so the header lives on the section
// and the contribution mounts in a child. Label is config.label or the catalog.
function contributionHeader({ stationId, slotName, contributionId, label, catalogLabel, box }) {
  const header = document.createElement('div');
  header.className = 'contrib-header';
  header.dataset.station = stationId;
  header.dataset.slot = slotName;
  header.dataset.contribution = contributionId;

  const handle = document.createElement('span');
  handle.className = 'contrib-handle';
  handle.title = 'Drag to another slot';
  handle.textContent = '⋮⋮';
  handle.draggable = true;
  handle.addEventListener('dragstart', event => {
    const json = JSON.stringify({ stationId, contributionId, fromSlot: slotName });
    event.dataTransfer.setData('application/x-ro-widget', json);
    event.dataTransfer.setData('text/plain', 'ro-widget:' + json);
    event.dataTransfer.effectAllowed = 'move';
    box?.classList.add('dragging');
  });
  handle.addEventListener('dragend', () => {
    box?.classList.remove('dragging');
    clearDropMarks();
  });

  const name = document.createElement('span');
  name.className = 'contrib-label';
  name.textContent = label;
  name.title = 'Double-click to rename';
  name.addEventListener('dblclick', () => {
    if (name.isContentEditable) return;
    const original = name.textContent;
    name.contentEditable = 'true';
    name.focus();
    const finish = async save => {
      if (!name.isContentEditable) return;
      name.contentEditable = 'false';
      name.onkeydown = null;
      name.onblur = null;
      if (!save) { name.textContent = original; return; }
      const next = name.textContent.trim();
      try {
        await saveWiringConfig(stationId, slotName, contributionId, { label: next });
        name.textContent = next || catalogLabel;
      } catch (error) {
        showError(error);
        name.textContent = original;
      }
    };
    name.onkeydown = event => {
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    };
    name.onblur = () => finish(true);
  });

  const gear = document.createElement('button');
  gear.type = 'button';
  gear.title = 'Open plugin manager';
  gear.setAttribute('aria-label', 'Open plugin manager');
  gear.textContent = '⚙';
  gear.addEventListener('click', () => openPluginManager(stationId));

  header.append(handle, name, gear);
  return header;
}

// Drag divider between the main and side slots. Until a paneSplit preference
// exists the layout keeps its fixed side width; the first drag (or a stored
// pref) switches the grid to the --pane-split variable. Saved once on drag
// end — never per pixel.
function mountPaneResizer(slotEls) {
  const divider = document.createElement('div');
  divider.className = 'pane-resizer';
  stage.insertBefore(divider, slotEls.side);
  const saved = mergedPrefs().paneSplit;
  if (saved) {
    stage.classList.add('has-split');
    stage.style.setProperty('--pane-split', saved);
  }
  divider.onmousedown = event => {
    event.preventDefault();
    const left = slotEls.main.getBoundingClientRect().left;
    const width = slotEls.side.getBoundingClientRect().right - left;
    const clamp = x => Math.min(80, Math.max(20, Math.round((x - left) / width * 100)));
    stage.classList.add('has-split');
    divider.classList.add('dragging');
    const move = e => stage.style.setProperty('--pane-split', clamp(e.clientX));
    const up = async e => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      divider.classList.remove('dragging');
      const paneSplit = clamp(e.clientX);
      stage.style.setProperty('--pane-split', paneSplit);
      if (kernel.workspace) await savePrefs({ paneSplit }).catch(showError);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };
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
  const previous = kernel.activeStation;
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
  if (slotEls.main && slotEls.side && (layout === 'main-side' || layout === 'rail-main-side')) {
    mountPaneResizer(slotEls);
  }
  bindSlotDrops(stationId, slotEls);
  // Lifecycle metadata sits at the bottom of the side slot and starts folded —
  // a render-order nudge only; the stored wiring sort_order is untouched.
  const lifecycleLast = new Set(['state-badge', 'provenance-block', 'revision-timeline']);
  const demote = row => row.slot_name === 'side' && lifecycleLast.has(row.contribution_id) ? 1 : 0;
  const wired = [...(kernel.composition.stations[stationId] || [])].sort((a, b) => demote(a) - demote(b));
  for (const row of wired) {
    const slotEl = slotEls[row.slot_name];
    if (!slotEl) continue;
    const section = document.createElement('section');
    const catalogLabel = row.label;
    const customLabel = String(row.config?.label || '').trim();
    section.className = 'section contrib-box';
    section.dataset.contribution = row.contribution_id;
    section.dataset.slot = row.slot_name;
    if (Number.isFinite(row.config?.height)) {
      section.style.height = `${row.config.height}px`;
      section.classList.add('has-height');
    }
    slotEl.append(section);
    section.append(contributionHeader({
      stationId,
      slotName: row.slot_name,
      contributionId: row.contribution_id,
      label: customLabel || catalogLabel,
      catalogLabel,
      box: section
    }));
    let host;
    if (row.slot_name === 'side') {
      const remembered = uiMemory.read().sideCollapsed?.[stationId]?.[row.contribution_id];
      const collapsed = remembered ?? lifecycleLast.has(row.contribution_id);
      section.classList.add('side-section');
      if (collapsed) section.classList.add('collapsed');
      const head = document.createElement('div');
      head.className = 'section-head';
      head.innerHTML = `<span data-caret>${collapsed ? '▸' : '⌄'}</span>`;
      head.onclick = () => {
        const next = !section.classList.contains('collapsed');
        section.classList.toggle('collapsed', next);
        head.querySelector('[data-caret]').textContent = next ? '▸' : '⌄';
        uiMemory.patch(s => { ((s.sideCollapsed ??= {})[stationId] ??= {})[row.contribution_id] = next; });
      };
      const body = document.createElement('div');
      body.className = 'section-body contrib-body';
      section.append(head, body);
      host = body;
    } else {
      host = document.createElement('div');
      host.className = 'contrib-body';
      section.append(host);
    }
    bindBoxReorder(section, stationId, row);
    mountResizeEdge(section, stationId, row.slot_name, row.contribution_id);
    try {
      const module = await loadModule(row);
      const { ctx, dispose } = makeContext(stationId, row.config, null, {
        contributionId: row.contribution_id,
        slotName: row.slot_name
      });
      const unmount = await module.mount(host, ctx);
      kernel.disposers.push(() => { if (typeof unmount === 'function') unmount(); dispose(); });
    } catch (error) {
      console.error(`mount ${row.contribution_id}`, error);
      host.innerHTML = `<div class="card"><h3>${esc(customLabel || catalogLabel)}</h3><div class="muted">Failed to mount: ${esc(error.message)}</div></div>`;
    }
  }
  for (const [name, el] of Object.entries(slotEls)) {
    if (!el.children.length) el.innerHTML = `<div class="empty">Empty slot: ${esc(name)}. Wire a contribution in Plugins ⚙.</div>`;
  }
  if (stationId === HOME_STATION && slotEls.main) mountBoardFrameChrome(slotEls.main);
  if (!skipHistory && previous !== stationId) commitHistory('push');
}

function mountBoardFrameChrome(slotMain) {
  const bar = document.createElement('div');
  bar.className = 'board-frame-chrome';
  const add = document.createElement('button');
  add.id = 'boardAddProject';
  add.type = 'button';
  add.textContent = '＋ project';
  add.onclick = () => openProjectDialog().catch(showError);
  bar.append(add);
  slotMain.prepend(bar);
}

let projectDialog = null;
let projectDispose = null;

async function openProjectDialog() {
  if (!kernel.workspace) return notify('Add a workspace first.', 'error');
  if (!projectDialog) {
    projectDialog = document.createElement('dialog');
    projectDialog.className = 'plugin-manager';
    projectDialog.innerHTML = `<div class="pm-head"><strong>New project</strong><button type="button" data-role="close">Close</button></div><div data-role="body" class="pm-body"></div>`;
    projectDialog.querySelector('[data-role="close"]').onclick = () => projectDialog.close();
    document.body.append(projectDialog);
  }
  const body = projectDialog.querySelector('[data-role="body"]');
  if (projectDispose) { projectDispose(); projectDispose = null; }
  body.replaceChildren();
  const host = document.createElement('div');
  body.append(host);
  const module = await loadModule(catalogClient('project-create-form'));
  const { ctx, dispose } = makeContext(kernel.activeStation, {});
  ctx.selectFile = async path => {
    const rec = await selectFile(path);
    projectDialog.close();
    return rec;
  };
  const unmount = await module.mount(host, ctx);
  projectDispose = () => { if (typeof unmount === 'function') unmount(); dispose(); };
  projectDialog.showModal();
}

async function recompose(keepStation = true, preferStation = null) {
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
  const pick = id => id && available.some(row => row.plugin_id === id);
  const target = keepStation && pick(kernel.activeStation)
    ? kernel.activeStation
    : pick(preferStation) ? preferStation
    : pick(remembered) ? remembered
    : pick(HOME_STATION) ? HOME_STATION
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

async function loadWorkspaces(selectPath = null, { restoreMemory = true, station = null } = {}) {
  const pushAfter = !skipHistory;
  if (pushAfter) kernel.boardPath = [];
  const prevSkip = skipHistory;
  skipHistory = true;
  try {
    kernel.workspaces = await request('/api/workspaces');
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
      uiMemory.patch(s => { s.workspace = kernel.workspace.root_path; });
    }
    kernel.selection = null;
    kernel.card = null;
    bus.emit('workspace', kernel.workspace);
    await loadPrefs().catch(showError);
    await recompose(false, station);
    await renderSidebar().catch(showError);
    if (restoreMemory) {
      const rememberedFile = kernel.workspace ? uiMemory.read().selection?.[kernel.workspace.root_path] : null;
      if (rememberedFile) await selectFile(rememberedFile).catch(() => { /* the file may be gone; stay silent */ });
    }
  } finally {
    skipHistory = prevSkip;
  }
  if (pushAfter) commitHistory('push');
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

function firstSentence(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const match = raw.match(/^.+?(?:[.!?]\s+|[.!?]$)/);
  return match ? match[0].trim() : raw;
}

function renderPluginManager() {
  if (!kernel.workspace) {
    pluginManagerBody.innerHTML = '<div class="empty">Add a workspace first.</div>';
    return;
  }
  const enabledIds = new Set(kernel.composition.enabled.map(row => row.plugin_id));
  const catalogById = new Map(kernel.composition.catalog.map(row => [row.plugin_id, row]));
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
    box.dataset.stationId = station.plugin_id;
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
          const desc = catalogById.get(row.contribution_id)?.manifest?.description || '';
          const line = document.createElement('div');
          line.className = 'pm-wire-row';
          line.innerHTML = `<div><span>${esc(row.label)}</span>${desc ? `<div class="desc">${esc(desc)}</div>` : ''}</div>
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
        <select data-role="contribution">${contributions.map(c => {
          const lead = firstSentence(c.manifest?.description);
          const text = lead ? `${c.label} ${lead}` : c.label;
          return `<option value="${esc(c.plugin_id)}">${esc(text)}</option>`;
        }).join('')}</select>
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

function openPluginManager(stationId) {
  renderPluginManager();
  pluginManager.showModal();
  if (typeof stationId !== 'string' || !stationId) return;
  const box = pluginManagerBody.querySelector(`.pm-station[data-station-id="${CSS.escape(stationId)}"]`);
  if (!box) return;
  box.dataset.focus = '1';
  box.scrollIntoView({ block: 'center' });
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
        <label>Inbox watches folder <input data-role="ws-inbox-watch" value="${esc(p.inbox?.watch || '')}" placeholder="outputs">
          <span class="muted">workspace-relative; empty = off</span></label>
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
        const watch = pane.querySelector('[data-role="ws-inbox-watch"]').value.trim();
        await savePrefs({ icon, inbox: { watch } });
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
    // Coalesce the live preview: rewriting root CSS variables restyles the
    // whole app, so a keystroke burst must cost one recalc per frame, not one
    // per key.
    let previewFrame = 0;
    pane.querySelectorAll('[data-pref]').forEach(el => el.oninput = () => {
      cancelAnimationFrame(previewFrame);
      previewFrame = requestAnimationFrame(() => applyAppearance(draft()));
    });
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
      <div class="muted" style="margin-bottom:8px">The dashboard's content blocks are wired in Plugins. Extra program links for THIS workspace feed the tool-health probe.</div>
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

document.addEventListener('click', event => {
  if (!stationBar.contains(event.target)) closeNavDrops();
});

async function applyState(state) {
  skipHistory = true;
  try {
    kernel.boardPath = Array.isArray(state.path) ? state.path.map(String) : [];
    const wantWs = state.ws || null;
    const haveWs = kernel.workspace?.root_path || null;
    if (wantWs !== haveWs) await loadWorkspaces(wantWs, { restoreMemory: false, station: state.station });
    if (state.station && state.station !== kernel.activeStation) {
      await activateStation(state.station);
    } else {
      bus.emit('board-path', { path: kernel.boardPath, source: 'history' });
    }
    const wantFile = state.file || null;
    const haveFile = relativeFile(kernel.selection?.path);
    if (wantFile && wantFile !== haveFile && kernel.workspace) {
      const abs = wantFile.startsWith('/') ? wantFile : `${kernel.workspace.root_path}/${wantFile}`;
      await selectFile(abs).catch(() => {});
    } else if (!wantFile && kernel.selection) {
      kernel.selection = null;
      kernel.card = null;
      bus.emit('selection', null);
    }
  } finally {
    skipHistory = false;
  }
}

window.addEventListener('popstate', event => {
  applyState(event.state || readUrlState()).catch(showError);
});

async function boot() {
  const state = readUrlState();
  const fromUrl = urlHasNav(state);
  skipHistory = true;
  try {
    kernel.boardPath = state.path || [];
    await loadWorkspaces(state.ws, { restoreMemory: !fromUrl, station: fromUrl ? state.station : null });
    if (fromUrl) {
      if (state.station && state.station !== kernel.activeStation) await activateStation(state.station);
      else bus.emit('board-path', { path: kernel.boardPath, source: 'history' });
      if (state.file && kernel.workspace) {
        const abs = state.file.startsWith('/') ? state.file : `${kernel.workspace.root_path}/${state.file}`;
        await selectFile(abs).catch(() => {});
      }
    }
  } finally {
    skipHistory = false;
  }
  commitHistory('replace');
}

boot().catch(showError);
