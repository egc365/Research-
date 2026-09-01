// The composition catalog: every station and contribution the app ships, plus
// the default wiring between them. This file is the *declaration*; SQLite is
// the *crosswalk* — boot upserts these rows into ui_plugins (preserving the
// owner's enabled flags) and seeds station_contributions only for stations
// that have no wiring rows yet, so owner edits always survive a restart.
//
// Kinds:
//   station      a user-facing composed tool; owns a layout of named slots
//   contribution a behavior coded once, mounted into a slot by wiring rows
//   service      a server plugin (plugins/server/*.mjs) exposing actions
//
// Layouts the kernel knows: 'main', 'rail-main', 'main-side', 'rail-main-side'.

export const stations = [
  {
    id: 'file-workbench', label: 'File workbench', version: '1.1.0',
    manifest: {
      description: 'Edit the selected file, watch its lifecycle state and provenance. Navigation lives in the sidebar.',
      layout: 'main-side', slots: ['main', 'side'], icon: '🗂'
    }
  },
  {
    id: 'revision-center', label: 'Revision center', version: '1.1.0',
    manifest: {
      description: 'Preserved vs new side by side, block cards from the transcript index, amendments as append-only revisions, accept / needs-more-work.',
      layout: 'main-side', slots: ['main', 'side'], icon: '📝'
    }
  },
  {
    id: 'validation-center', label: 'Validation center', version: '1.0.0',
    manifest: {
      description: 'Review candidates and validated artifacts: queue of cards, base vs candidate side by side, shared diff, receipts and provenance. Promote is the single final verb — validated bytes to promoted authority, human-only.',
      layout: 'rail-main-side', slots: ['rail', 'main', 'side'], icon: '✅'
    }
  },
  {
    id: 'dashboard-viewer', label: 'Dashboard', version: '1.0.0',
    manifest: {
      description: 'Workspace counts and recent activity, computed from the ledger.',
      layout: 'main', slots: ['main'], icon: '📊'
    }
  },
  {
    id: 'provenance-viewer', label: 'Provenance', version: '1.1.0',
    manifest: {
      description: 'Who wrote what, when, under which run — the full event ledger for a file, filterable by actor.',
      layout: 'main-side', slots: ['main', 'side'], icon: '🔗'
    }
  },
  {
    id: 'execution-state', label: 'Execution state', version: '1.0.0',
    manifest: {
      description: 'The small structured memory an agent run keeps (SKILL.state): inspect a run, apply a patch, watch the version counter.',
      layout: 'main', slots: ['main'], icon: '⚙'
    }
  },
  {
    id: 'health-monitor', label: 'Tool health', version: '1.0.0',
    manifest: {
      description: 'Up/down and latency for the machine’s tool ports — the launchpad’s program list plus this workspace’s links, probed from the server (loopback only).',
      layout: 'main', slots: ['main'], icon: '🩺'
    }
  },
  {
    id: 'transcript-review', label: 'Transcript review', version: '1.0.0',
    manifest: {
      description: 'Deep search over every bot’s native session transcripts — pick a bot, optionally a session, filter by text, role, kind, date. Read-only; provider logs stay authoritative.',
      layout: 'main', slots: ['main'], icon: '🎞'
    }
  },
  {
    id: 'planning-board', label: 'Board', version: '1.0.0',
    manifest: {
      description: 'Groups and subgroups of cards that are real files, links and notes — horizontal for hierarchy, vertical for serial order; drill in, drag to arrange. Card workshop unwound.',
      layout: 'main', slots: ['main'], icon: '🗂'
    }
  },
  {
    id: 'project-creator', label: 'Project creator', version: '1.0.0',
    manifest: {
      description: 'Start a new project folder inside the workspace with a seeded README, registered in the ledger from its first byte.',
      layout: 'main', slots: ['main'], icon: '✚'
    }
  }
];

export const contributions = [
  { id: 'filesystem-tree',    label: 'File tree',          entry: '/contrib/filesystem-tree.js',    description: 'Expandable workspace tree; clicking a file selects it for every other view.' },
  { id: 'markdown-editor',    label: 'Editor',             entry: '/contrib/markdown-editor.js',    description: 'Edit the selected file. Save is checksum-guarded: a stale base shows both SHAs and never overwrites silently.' },
  { id: 'dual-document-view', label: 'Preserved | New',    entry: '/contrib/dual-document-view.js', description: 'The last promoted bytes beside the current working bytes, exact SHAs on both.' },
  { id: 'diff-renderer',      label: 'Continuous diff',    entry: '/contrib/diff-renderer.js',      description: 'Block-aligned diff between the preserved and working versions.' },
  { id: 'card-rail',          label: 'Block cards',        entry: '/contrib/card-rail.js',          description: 'The selected document split into markdown blocks, one card per block, with the latest decision per card.' },
  { id: 'amendment-editor',   label: 'Amendment editor',   entry: '/contrib/amendment-editor.js',   description: 'Write an amendment against the selected card. Each save is rev N+1 in an append-only log; nothing touches the document.' },
  { id: 'decision-controls',  label: 'Decision controls',  entry: '/contrib/decision-controls.js',  description: 'Accept / needs-more-work on the selected card. Record-only owner verdicts; promotion deliberately lives elsewhere.' },
  { id: 'revision-timeline',  label: 'Timeline',           entry: '/contrib/revision-timeline.js',  description: 'Amendments and ledger events for the selected file, newest first.' },
  { id: 'actor-filter',       label: 'Actor filter',       entry: '/contrib/actor-filter.js',       description: 'Narrow event views to one actor (human, agent, filesystem, validator).' },
  { id: 'provenance-block',   label: 'Provenance',         entry: '/contrib/provenance-block.js',   description: 'Registry row for the selected file: state, exact SHA-256, run and span ids, timestamps.' },
  { id: 'state-badge',        label: 'State badge',        entry: '/contrib/state-badge.js',        description: 'The lifecycle state of the selected file, colored, with its allowed next states.' },
  { id: 'promotion-control',  label: 'Validation controls', entry: '/contrib/promotion-control.js', description: 'Submit as candidate → run validation (mints receipts) → Promote. Promote is the single final verb: validated bytes to promoted authority, human-only.' },
  { id: 'candidate-list',     label: 'Validation queue',   entry: '/contrib/candidate-list.js',     description: 'Card wall of registered artifacts by lifecycle state — path, SHAs, run/span, drift; clicking selects the file.' },
  { id: 'validation-result',  label: 'Validation',         entry: '/contrib/validation-result.js',  description: 'Deterministic validator results for the selected file, check by check.' },
  { id: 'project-create-form',label: 'New project form',   entry: '/contrib/project-create-form.js',description: 'Name a project; the form writes the folder + README through the governed write path.' },
  { id: 'label-editor',      label: 'Label editor',       entry: '/contrib/label-editor.js',       headless: true, description: 'Manage labels in a dialog opened from the tree (create, rename, recolor, describe, delete, assign) — stored in the SQLite crosswalk, owner-only writes. Occupies no screen space until opened.' },
  { id: 'statistics-view',    label: 'Statistics',         entry: '/contrib/statistics-view.js',    description: 'Counts by state, event type, actor, and the last promotions.' },
  { id: 'launchpad',          label: 'Launchpad',          entry: '/contrib/launchpad.js',          description: 'Dashboard link hub: stations, workspaces, and the machine’s other programs as big cards. Per-workspace extra links come from the workspace preferences.' },
  { id: 'inbox',              label: 'Inbox',              entry: '/contrib/inbox.js',              description: 'What needs the owner: candidates and validated artifacts awaiting a verdict, plus the latest activity.' },
  { id: 'folder-cards',       label: 'Folder cards',       entry: '/contrib/folder-cards.js',       description: 'Notion-style card view of a folder (the workspace root by default): one card per file or folder, with label chips.' },
  { id: 'section-favorites',  label: 'Favorites',          entry: '/contrib/section-favorites.js',  description: 'Sidebar section: starred files and folders (star them in the tree).' },
  { id: 'section-projects',   label: 'Projects',           entry: '/contrib/section-projects.js',   description: 'Sidebar section: folders labeled ‘project’, nested, click to reveal in Files.' },
  { id: 'section-recent',     label: 'Recent',             entry: '/contrib/section-recent.js',     description: 'Sidebar section: last touched artifacts from the ledger.' },
  { id: 'section-trash',      label: 'Trash',              entry: '/contrib/section-trash.js',      description: 'Sidebar section: trashed entries with one-click restore.' },
  { id: 'execution-state-view', label: 'Execution state',  entry: '/contrib/execution-state-view.js', description: 'Inspect and patch a run’s structured state with optimistic version checks.' },
  { id: 'tool-health-view',   label: 'Tool health',        entry: '/contrib/tool-health.js',        description: 'Port health board: probes the machine’s tools via the tool-health service and shows up/down with latency. Extra targets via wiring config { targets: [...] }.' },
  { id: 'transcript-search-view', label: 'Transcript search', entry: '/contrib/transcript-search.js', description: 'Bot cutover → session list → filtered deep search over native transcripts, via the transcript-search service.' },
  { id: 'board-view',         label: 'Board',              entry: '/contrib/board-view.js',         description: 'Planning board over the workspace: group tiles laid out per orientation, breadcrumb drill-in, drag cards to reorder or move; file cards select the file, links open, notes edit inline.' }
];

// Default wiring, applied only when a station has zero rows in
// station_contributions. Order inside a slot = sort_order steps of 10.
export const defaultWiring = {
  'file-workbench': {
    main: ['markdown-editor', 'diff-renderer'],
    side: ['state-badge', 'provenance-block', 'revision-timeline']
  },
  'revision-center': {
    main: ['dual-document-view'],
    side: [{ id: 'card-rail', config: { source: 'transcript' } }, 'amendment-editor', 'decision-controls', 'revision-timeline']
  },
  'validation-center': {
    rail: ['candidate-list'],
    main: [
      { id: 'dual-document-view', config: { base: 'promoted' } },
      { id: 'diff-renderer', config: { base: 'promoted' } },
      'validation-result'
    ],
    side: [
      { id: 'state-badge', config: { openIn: ['revision-center', 'file-workbench'] } },
      'provenance-block',
      'promotion-control'
    ]
  },
  'dashboard-viewer': { main: ['launchpad', 'folder-cards', 'inbox', 'statistics-view'] },
  'provenance-viewer': {
    main: ['revision-timeline'],
    side: ['actor-filter', 'provenance-block']
  },
  'execution-state': { main: ['execution-state-view'] },
  'health-monitor': { main: ['tool-health-view'] },
  'transcript-review': { main: ['transcript-search-view'] },
  'planning-board': { main: ['board-view'] },
  'project-creator': { main: ['project-create-form'] }
};

// Ids the catalog used to ship and no longer does. Boot deletes their rows from
// all three composition tables (ui_plugins, workspace_plugins,
// station_contributions) so the plugin manager shows no ghosts.
export const retired = ['label-designator', 'governance-center'];

// Default sidebar sections for a workspace with no sidebar_sections rows yet.
// Sections are ordinary contributions (section-*) mounted by the kernel's
// sidebar; the owner shows/hides/reorders them per workspace.
export const sidebarDefaults = ['section-favorites', 'section-projects', 'filesystem-tree', 'section-recent', 'section-trash', 'label-editor'];

export function catalogRows(serverPlugins = []) {
  const rows = [];
  for (const s of stations) {
    rows.push({ plugin_id: s.id, plugin_kind: 'station', label: s.label, version: s.version,
      client_entry: null, server_entry: null, manifest_json: JSON.stringify(s.manifest) });
  }
  for (const c of contributions) {
    rows.push({ plugin_id: c.id, plugin_kind: 'contribution', label: c.label, version: c.version || '1.0.0',
      client_entry: c.entry, server_entry: null,
      manifest_json: JSON.stringify({ description: c.description, ...(c.headless ? { headless: true } : {}) }) });
  }
  for (const p of serverPlugins) {
    // A server plugin and a station may share a name (revision-center vs the
    // 'diff' service etc.) — ids here are the plugin's own; collisions throw.
    if (rows.some(r => r.plugin_id === p.id)) throw new Error(`Catalog id collision: ${p.id}`);
    rows.push({ plugin_id: p.id, plugin_kind: 'service', label: p.label || p.id, version: '1.0.0',
      client_entry: null, server_entry: `plugins/server/${p.id}.mjs`,
      manifest_json: JSON.stringify({ description: p.description || '' }) });
  }
  return rows;
}
