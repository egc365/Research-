export const schemaSql = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS workspace_roots (
  root_path TEXT PRIMARY KEY,
  label TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifact_registry (
  path TEXT PRIMARY KEY,
  workspace_root TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'working'
    CHECK (state IN ('working','candidate','validated','promoted','superseded','archived')),
  checksum TEXT,
  promoted_checksum TEXT,
  last_run_id TEXT,
  last_span_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_root) REFERENCES workspace_roots(root_path) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS artifact_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  event_type TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  checksum TEXT,
  actor TEXT NOT NULL,
  run_id TEXT,
  span_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS artifact_events_path_idx
  ON artifact_events(path, event_id DESC);

CREATE TABLE IF NOT EXISTS artifact_versions (
  version_id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  checksum TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('promoted','snapshot')),
  content BLOB NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(path, checksum, kind)
);

CREATE TABLE IF NOT EXISTS execution_state (
  run_id TEXT PRIMARY KEY,
  skill_path TEXT,
  state_json TEXT NOT NULL,
  state_version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_rules (
  rule_id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_path TEXT NOT NULL,
  rule_type TEXT NOT NULL,
  rule_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ui_plugins (
  plugin_id TEXT PRIMARY KEY,
  plugin_kind TEXT NOT NULL
    CHECK(plugin_kind IN ('station','contribution','service')),
  label TEXT NOT NULL,
  version TEXT NOT NULL,
  client_entry TEXT,
  server_entry TEXT,
  manifest_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS workspace_plugins (
  workspace_root TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 100,
  config_json TEXT,
  PRIMARY KEY(workspace_root, plugin_id)
);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS station_contributions (
  station_id TEXT NOT NULL,
  slot_name TEXT NOT NULL,
  contribution_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 100,
  config_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(station_id, slot_name, contribution_id)
);

CREATE TABLE IF NOT EXISTS amendments (
  amendment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  card TEXT NOT NULL DEFAULT '',
  rev INTEGER NOT NULL,
  body TEXT NOT NULL,
  note TEXT,
  actor TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(path, card, rev)
);

CREATE INDEX IF NOT EXISTS amendments_path_idx ON amendments(path, card, rev DESC);

-- Presentation and navigation preferences: validated JSON blobs, never one
-- column per CSS property. Composition answers "what can this workspace do";
-- these answer "what does it look like" and "how is it organized for me".
CREATE TABLE IF NOT EXISTS workspace_ui_preferences (
  workspace_root TEXT PRIMARY KEY,
  preference_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_ui_preferences (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sidebar_sections (
  workspace_root TEXT NOT NULL,
  section_id TEXT NOT NULL,
  visible INTEGER NOT NULL DEFAULT 1,
  collapsed INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 100,
  config_json TEXT,
  PRIMARY KEY(workspace_root, section_id)
);

CREATE TABLE IF NOT EXISTS labels (
  name TEXT PRIMARY KEY,
  color TEXT NOT NULL DEFAULT '#4fa3ff',
  description TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS path_labels (
  workspace_root TEXT NOT NULL,
  path TEXT NOT NULL,
  label TEXT NOT NULL REFERENCES labels(name) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(path, label)
);

CREATE INDEX IF NOT EXISTS path_labels_root_idx ON path_labels(workspace_root, path);
`;

export const lifecycle = ['working', 'candidate', 'validated', 'promoted', 'superseded', 'archived'];

export const allowedTransitions = new Map([
  ['working', new Set(['candidate', 'archived'])],
  ['candidate', new Set(['working', 'validated', 'archived'])],
  ['validated', new Set(['candidate', 'promoted', 'archived'])],
  ['promoted', new Set(['superseded', 'archived'])],
  ['superseded', new Set(['archived'])],
  ['archived', new Set([])],
]);
