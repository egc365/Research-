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

CREATE TABLE IF NOT EXISTS policy_rules (
  rule_id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_path TEXT NOT NULL,
  rule_type TEXT NOT NULL,
  rule_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
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
