import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { allowedTransitions, schemaSql } from './schema.mjs';

const now = () => new Date().toISOString();
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function validateStateObject(value, label = 'state') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error(`INVALID_STATE_PATCH: ${label} must be a JSON object`);
    error.code = 'INVALID_STATE_PATCH';
    throw error;
  }
}

export class ControlStore {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(schemaSql);
  }

  close() { this.db.close(); }

  addWorkspace(rootPath, label = null) {
    const resolved = path.resolve(rootPath);
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) throw new Error('Workspace root must be a directory');
    const ts = now();
    this.db.prepare(`
      INSERT INTO workspace_roots(root_path,label,created_at,updated_at)
      VALUES(?,?,?,?)
      ON CONFLICT(root_path) DO UPDATE SET label=excluded.label, updated_at=excluded.updated_at
    `).run(resolved, label || path.basename(resolved), ts, ts);
    return this.getWorkspace(resolved);
  }

  // A workspace is a composition profile over a real directory. `create` lets
  // the owner start from a brand-new folder; a fresh workspace has no rows in
  // workspace_plugins, so it renders the empty frame until stations are enabled.
  createWorkspace({ rootPath, label = null, create = false }) {
    const resolved = path.resolve(rootPath);
    if (!fs.existsSync(resolved)) {
      if (!create) throw new Error(`No directory at ${resolved} — pass create to make one`);
      fs.mkdirSync(resolved, { recursive: true });
    }
    return this.addWorkspace(resolved, label);
  }

  // Retire plugin ids the catalog no longer ships: their rows leave all three
  // composition tables so the plugin manager shows no ghosts. Content tables
  // (labels, amendments, ledger) are untouched.
  retirePlugins(ids = []) {
    for (const id of ids) {
      this.db.prepare('DELETE FROM station_contributions WHERE station_id=? OR contribution_id=?').run(id, id);
      this.db.prepare('DELETE FROM workspace_plugins WHERE plugin_id=?').run(id);
      this.db.prepare('DELETE FROM ui_plugins WHERE plugin_id=?').run(id);
    }
  }

  // Unregister a workspace: its registry rows, composition, preferences,
  // sidebar layout and label designations go; the folder and its bytes stay
  // on disk untouched, and the event ledger keeps its history.
  removeWorkspace(rootPath) {
    const root = path.resolve(rootPath);
    if (!this.getWorkspace(root)) throw new Error('Workspace is not registered: ' + root);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM workspace_plugins WHERE workspace_root=?').run(root);
      this.db.prepare('DELETE FROM workspace_ui_preferences WHERE workspace_root=?').run(root);
      this.db.prepare('DELETE FROM sidebar_sections WHERE workspace_root=?').run(root);
      this.db.prepare('DELETE FROM path_labels WHERE workspace_root=?').run(root);
      this.db.prepare('DELETE FROM workspace_roots WHERE root_path=?').run(root); // cascades artifact_registry
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { removed: root, note: 'The folder and its files are untouched on disk.' };
  }

  listWorkspaces() {
    // `exists` tells the UI a registration outlived its folder, so the switcher
    // can say "missing on disk" instead of rendering a ghost that ENOENTs.
    return this.db.prepare('SELECT * FROM workspace_roots ORDER BY label, root_path').all()
      .map(row => ({ ...row, exists: fs.existsSync(row.root_path) }));
  }

  // Registered workspace roots sitting at or under a path. A governed move or
  // trash of that path must carry these registrations along — leaving them
  // behind is what turns a deleted folder into a ghost workspace.
  registeredRootsUnder(targetPath) {
    const target = path.resolve(targetPath);
    return this.db.prepare("SELECT root_path FROM workspace_roots WHERE root_path=? OR root_path LIKE ? || '/%'")
      .all(target, target).map(row => row.root_path);
  }

  // Caller holds the transaction. Composition, preferences and sidebar rows go;
  // workspace_roots delete cascades artifact_registry. path_labels stay keyed
  // to their (possibly trashed) paths so a restore keeps its designations.
  #unregisterWorkspaceRows(root) {
    this.db.prepare('DELETE FROM workspace_plugins WHERE workspace_root=?').run(root);
    this.db.prepare('DELETE FROM workspace_ui_preferences WHERE workspace_root=?').run(root);
    this.db.prepare('DELETE FROM sidebar_sections WHERE workspace_root=?').run(root);
    this.db.prepare('DELETE FROM workspace_roots WHERE root_path=?').run(root);
  }

  getWorkspace(rootPath) {
    return this.db.prepare('SELECT * FROM workspace_roots WHERE root_path=?').get(path.resolve(rootPath));
  }

  assertInsideWorkspace(rootPath, candidatePath) {
    const root = path.resolve(rootPath);
    const target = path.resolve(candidatePath);
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Path is outside workspace');
    return target;
  }

  listDirectory(rootPath, relativePath = '.') {
    const root = path.resolve(rootPath);
    if (!fs.existsSync(root)) {
      const error = new Error(`WORKSPACE_ROOT_MISSING: no folder on disk at ${root} — restore the folder or unregister the workspace`);
      error.code = 'WORKSPACE_ROOT_MISSING';
      throw error;
    }
    const target = this.assertInsideWorkspace(rootPath, path.join(rootPath, relativePath));
    return fs.readdirSync(target, { withFileTypes: true })
      .filter(entry => entry.name !== '.research-ops')
      .map(entry => ({
        name: entry.name,
        path: path.join(target, entry.name),
        relativePath: path.relative(rootPath, path.join(target, entry.name)) || '.',
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'
      }))
      .filter(entry => entry.type !== 'other')
      .sort((a,b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1);
  }

  ensureRegistered(rootPath, filePath) {
    const target = this.assertInsideWorkspace(rootPath, filePath);
    const existing = this.getArtifact(target);
    const bytes = fs.readFileSync(target);
    const checksum = sha256(bytes);
    const ts = now();
    const divergedFromPromotion = existing?.state === 'promoted'
      && existing.promoted_checksum
      && existing.promoted_checksum !== checksum;
    const invalidatedByEdit = (existing?.state === 'candidate' || existing?.state === 'validated')
      && existing.checksum
      && existing.checksum !== checksum;
    const nextState = (divergedFromPromotion || invalidatedByEdit) ? 'working' : (existing?.state || 'working');

    this.db.prepare(`
      INSERT INTO artifact_registry(path,workspace_root,state,checksum,created_at,updated_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(path) DO UPDATE SET state=excluded.state, checksum=excluded.checksum, updated_at=excluded.updated_at
    `).run(target, path.resolve(rootPath), nextState, checksum, ts, ts);

    if (divergedFromPromotion) {
      this.appendEvent({
        filePath: target,
        eventType: 'WORKING_DIVERGENCE',
        fromState: 'promoted',
        toState: 'working',
        checksum,
        actor: 'filesystem',
        metadata: { promoted_checksum: existing.promoted_checksum }
      });
    }
    if (invalidatedByEdit) {
      this.appendEvent({
        filePath: target,
        eventType: 'WRITE_DEMOTION',
        fromState: existing.state,
        toState: 'working',
        checksum,
        actor: 'filesystem',
        metadata: { registry_checksum: existing.checksum }
      });
    }
    return this.getArtifact(target);
  }

  getArtifact(filePath) {
    return this.db.prepare('SELECT * FROM artifact_registry WHERE path=?').get(path.resolve(filePath)) || null;
  }

  readFile(rootPath, filePath) {
    const target = this.assertInsideWorkspace(rootPath, filePath);
    const stat = fs.statSync(target);
    if (!stat.isFile()) throw new Error('Not a file');
    const bytes = fs.readFileSync(target);
    const artifact = this.ensureRegistered(rootPath, target);
    return {
      path: target,
      content: bytes.toString('utf8'),
      checksum: sha256(bytes),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      artifact
    };
  }

  appendEvent({ filePath, eventType, fromState = null, toState = null, checksum = null, actor = 'human', runId = null, spanId = null, metadata = null }) {
    this.db.prepare(`
      INSERT INTO artifact_events(path,event_type,from_state,to_state,checksum,actor,run_id,span_id,metadata_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)
    `).run(path.resolve(filePath), eventType, fromState, toState, checksum, actor, runId, spanId, metadata ? JSON.stringify(metadata) : null, now());
  }

  writeFile({ rootPath, filePath, content, expectedChecksum, actor = 'human', runId = null, spanId = null }) {
    const target = this.assertInsideWorkspace(rootPath, filePath);
    const beforeArtifact = this.getArtifact(target);
    const before = fs.existsSync(target) ? fs.readFileSync(target) : Buffer.from('');
    const actual = sha256(before);
    if (expectedChecksum && actual !== expectedChecksum) {
      const error = new Error('STALE_BASE');
      error.code = 'STALE_BASE';
      error.expected = expectedChecksum;
      error.actual = actual;
      throw error;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    const after = Buffer.from(content, 'utf8');
    const checksum = sha256(after);
    const ts = now();
    const workspace = path.resolve(rootPath);
    const divergedFromPromotion = beforeArtifact?.state === 'promoted'
      && beforeArtifact.promoted_checksum
      && beforeArtifact.promoted_checksum !== checksum;
    const invalidatedByEdit = (beforeArtifact?.state === 'candidate' || beforeArtifact?.state === 'validated')
      && checksum !== actual;
    const nextState = (divergedFromPromotion || invalidatedByEdit) ? 'working' : (beforeArtifact?.state || 'working');

    this.db.prepare(`
      INSERT INTO artifact_registry(path,workspace_root,state,checksum,last_run_id,last_span_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(path) DO UPDATE SET state=excluded.state,checksum=excluded.checksum,last_run_id=excluded.last_run_id,last_span_id=excluded.last_span_id,updated_at=excluded.updated_at
    `).run(target, workspace, nextState, checksum, runId, spanId, ts, ts);
    this.appendEvent({ filePath: target, eventType: 'WRITE', checksum, actor, runId, spanId, metadata: { previous_checksum: actual } });
    if (divergedFromPromotion) {
      this.appendEvent({
        filePath: target,
        eventType: 'WORKING_DIVERGENCE',
        fromState: 'promoted',
        toState: 'working',
        checksum,
        actor,
        runId,
        spanId,
        metadata: { promoted_checksum: beforeArtifact.promoted_checksum }
      });
    }
    if (invalidatedByEdit) {
      this.appendEvent({
        filePath: target,
        eventType: 'WRITE_DEMOTION',
        fromState: beforeArtifact.state,
        toState: 'working',
        checksum,
        actor,
        runId,
        spanId,
        metadata: { previous_checksum: actual }
      });
    }
    return this.readFile(rootPath, target);
  }

  transition({ filePath, toState, actor = 'human', runId = null, spanId = null, metadata = null }) {
    const target = path.resolve(filePath);
    const artifact = this.getArtifact(target);
    if (!artifact) throw new Error('Artifact is not registered');
    if (toState === artifact.state) return artifact;
    const allowed = allowedTransitions.get(artifact.state);
    if (!allowed?.has(toState)) throw new Error(`Invalid transition ${artifact.state} -> ${toState}`);
    if (toState === 'promoted' && actor !== 'human') {
      const error = new Error('PROMOTION_REQUIRES_HUMAN_APPROVAL');
      error.code = 'PROMOTION_REQUIRES_HUMAN_APPROVAL';
      throw error;
    }
    const bytes = fs.readFileSync(target);
    const checksum = sha256(bytes);
    if (toState === 'validated') {
      const validation = metadata?.validation;
      const receiptsOk = validation?.ok === true
        && (!validation.checksum || validation.checksum === checksum);
      if (!receiptsOk) {
        const error = new Error('VALIDATION_RECEIPTS_REQUIRED');
        error.code = 'VALIDATION_RECEIPTS_REQUIRED';
        error.validation = validation || null;
        throw error;
      }
    }
    if (artifact.checksum && artifact.checksum !== checksum) {
      const error = new Error('REGISTRY_CHECKSUM_STALE');
      error.code = 'REGISTRY_CHECKSUM_STALE';
      throw error;
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (toState === 'promoted') {
        this.db.prepare(`INSERT OR IGNORE INTO artifact_versions(path,checksum,kind,content,created_at) VALUES(?,?,?,?,?)`)
          .run(target, checksum, 'promoted', bytes, now());
      }
      this.db.prepare(`
        UPDATE artifact_registry
        SET state=?, checksum=?, promoted_checksum=CASE WHEN ?='promoted' THEN ? ELSE promoted_checksum END,
            last_run_id=?, last_span_id=?, updated_at=?
        WHERE path=?
      `).run(toState, checksum, toState, checksum, runId, spanId, now(), target);
      this.appendEvent({ filePath: target, eventType: 'STATE_TRANSITION', fromState: artifact.state, toState, checksum, actor, runId, spanId, metadata });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getArtifact(target);
  }

  history(filePath, limit = 100) {
    return this.db.prepare('SELECT * FROM artifact_events WHERE path=? ORDER BY event_id DESC LIMIT ?').all(path.resolve(filePath), limit);
  }

  getPromotedVersion(filePath) {
    return this.db.prepare(`SELECT version_id,path,checksum,kind,content,created_at FROM artifact_versions WHERE path=? AND kind='promoted' ORDER BY version_id DESC LIMIT 1`).get(path.resolve(filePath)) || null;
  }

  walkFiles(rootPath, dir = null, acc = []) {
    const root = path.resolve(rootPath);
    const target = dir ? path.resolve(dir) : root;
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      if (entry.name === '.research-ops' || entry.name === '.git') continue;
      const full = path.join(target, entry.name);
      if (entry.isDirectory()) this.walkFiles(root, full, acc);
      else if (entry.isFile()) acc.push(full);
    }
    return acc;
  }

  detectMoves(rootPath) {
    const root = path.resolve(rootPath);
    const rows = this.db.prepare('SELECT * FROM artifact_registry WHERE workspace_root=?').all(root);
    const missing = rows.filter(row => !fs.existsSync(row.path));
    if (!missing.length) return [];
    const registered = new Set(rows.map(row => row.path));
    const proposals = [];
    for (const file of this.walkFiles(root)) {
      if (registered.has(file)) continue;
      const checksum = sha256(fs.readFileSync(file));
      const matches = missing.filter(row => row.checksum === checksum);
      if (matches.length === 1) {
        proposals.push({ fromPath: matches[0].path, toPath: file, checksum, state: matches[0].state });
      }
    }
    return proposals;
  }

  applyMove({ rootPath, fromPath, toPath, actor = 'human' }) {
    const root = path.resolve(rootPath);
    const from = path.resolve(fromPath);
    const to = this.assertInsideWorkspace(root, toPath);
    const row = this.getArtifact(from);
    if (!row) throw new Error('Move source is not registered');
    if (fs.existsSync(from)) throw new Error('Move source still exists on disk');
    if (this.getArtifact(to)) throw new Error('Move target is already registered');
    const checksum = sha256(fs.readFileSync(to));
    if (row.checksum && row.checksum !== checksum) {
      const error = new Error('MOVE_CHECKSUM_MISMATCH');
      error.code = 'MOVE_CHECKSUM_MISMATCH';
      throw error;
    }
    const ts = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE artifact_registry SET path=?, updated_at=? WHERE path=?').run(to, ts, from);
      // Promoted snapshots follow the artifact; the event ledger stays untouched.
      this.db.prepare('UPDATE artifact_versions SET path=? WHERE path=?').run(to, from);
      this.appendEvent({
        filePath: to,
        eventType: 'MOVE',
        fromState: row.state,
        toState: row.state,
        checksum,
        actor,
        metadata: { from_path: from, to_path: to }
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getArtifact(to);
  }

  // SKILL.state (arXiv 2608.26263) inner loop: the model proposes a state patch
  // ΔΣ (a JSON dictionary of key mutations and deletions); the runtime validates
  // and merges Σ_{t+1} = Σ_t ⊕ ΔΣ with null-deletion semantics. The model never
  // writes authoritative state, and an invalid patch changes nothing.
  getExecutionState(runId) {
    const row = this.db.prepare('SELECT * FROM execution_state WHERE run_id=?').get(runId);
    return row ? { ...row, state: JSON.parse(row.state_json) } : null;
  }

  initExecutionState({ runId, skillPath = null, initial = {} }) {
    if (!runId) throw new Error('runId is required');
    if (this.getExecutionState(runId)) throw new Error('Execution state already exists for run');
    validateStateObject(initial);
    this.db.prepare('INSERT INTO execution_state(run_id,skill_path,state_json,state_version,updated_at) VALUES(?,?,?,0,?)')
      .run(runId, skillPath, JSON.stringify(initial), now());
    return this.getExecutionState(runId);
  }

  applyStatePatch({ runId, patch, expectedVersion }) {
    const current = this.getExecutionState(runId);
    if (!current) throw new Error('Execution state is not initialized for run');
    if (expectedVersion !== undefined && expectedVersion !== null && Number(expectedVersion) !== current.state_version) {
      const error = new Error('STATE_VERSION_CONFLICT');
      error.code = 'STATE_VERSION_CONFLICT';
      error.expected = expectedVersion;
      error.actual = current.state_version;
      throw error;
    }
    validateStateObject(patch, 'patch');
    const merged = { ...current.state };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    const serialized = JSON.stringify(merged);
    if (Buffer.byteLength(serialized, 'utf8') > 262144) {
      const error = new Error('STATE_TOO_LARGE');
      error.code = 'STATE_TOO_LARGE';
      throw error;
    }
    this.db.prepare('UPDATE execution_state SET state_json=?, state_version=state_version+1, updated_at=? WHERE run_id=?')
      .run(serialized, now(), runId);
    return this.getExecutionState(runId);
  }

  bindTrace({ filePath, runId, spanId = null, actor = 'human' }) {
    const target = path.resolve(filePath);
    const artifact = this.getArtifact(target);
    if (!artifact) throw new Error('Artifact is not registered');
    this.db.prepare('UPDATE artifact_registry SET last_run_id=?, last_span_id=?, updated_at=? WHERE path=?').run(runId, spanId, now(), target);
    this.appendEvent({ filePath: target, eventType: 'TRACE_BINDING', checksum: artifact.checksum, actor, runId, spanId });
    return this.getArtifact(target);
  }

  // ---------------------------------------------------------------- composition
  // SQLite is the composition crosswalk: which plugins exist (ui_plugins),
  // which stations a workspace enables (workspace_plugins), and which
  // contributions fill each station slot (station_contributions). Routing and
  // configuration only — application content never lives in these tables.

  syncCatalog(rows) {
    const upsert = this.db.prepare(`
      INSERT INTO ui_plugins(plugin_id,plugin_kind,label,version,client_entry,server_entry,manifest_json,enabled)
      VALUES(?,?,?,?,?,?,?,1)
      ON CONFLICT(plugin_id) DO UPDATE SET
        plugin_kind=excluded.plugin_kind, label=excluded.label, version=excluded.version,
        client_entry=excluded.client_entry, server_entry=excluded.server_entry,
        manifest_json=excluded.manifest_json
      -- enabled deliberately untouched: an owner disable survives restarts.
    `);
    for (const r of rows) {
      upsert.run(r.plugin_id, r.plugin_kind, r.label, r.version, r.client_entry, r.server_entry, r.manifest_json);
    }
    return this.listCatalog();
  }

  listCatalog() {
    return this.db.prepare('SELECT * FROM ui_plugins ORDER BY plugin_kind, label').all()
      .map(row => ({ ...row, manifest: JSON.parse(row.manifest_json || '{}') }));
  }

  seedStationWiring(defaultWiring) {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM station_contributions WHERE station_id=?');
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO station_contributions(station_id,slot_name,contribution_id,sort_order,config_json,enabled)
      VALUES(?,?,?,?,?,1)
    `);
    for (const [stationId, slots] of Object.entries(defaultWiring)) {
      if (count.get(stationId).n > 0) continue; // owner wiring survives restarts
      for (const [slotName, contributionIds] of Object.entries(slots)) {
        // An entry is either a bare contribution id or { id, config } when the
        // station mounts a shared behavior with station-specific configuration.
        contributionIds.forEach((entry, i) => {
          const id = typeof entry === 'string' ? entry : entry.id;
          const config = typeof entry === 'string' ? null : JSON.stringify(entry.config || {});
          insert.run(stationId, slotName, id, (i + 1) * 10, config);
        });
      }
    }
  }

  // An owner-defined station: a ui_plugins row like any shipped station, so
  // the kernel renders it and the plugin manager wires it — domain-specific
  // behavior arrives by choosing contributions, not by writing a component.
  // Catalog sync never touches it (sync only upserts declared ids).
  defineStation({ id, label, description = '', layout = 'rail-main-side', icon = '★' }) {
    if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('Station ids: lowercase letters, digits, dashes');
    if (!label) throw new Error('A station needs a label');
    const layouts = { main: ['main'], 'rail-main': ['rail', 'main'], 'main-side': ['main', 'side'], 'rail-main-side': ['rail', 'main', 'side'] };
    if (!layouts[layout]) throw new Error(`Unknown layout '${layout}' (one of: ${Object.keys(layouts).join(', ')})`);
    const existing = this.db.prepare('SELECT plugin_id, plugin_kind FROM ui_plugins WHERE plugin_id=?').get(id);
    if (existing && existing.plugin_kind !== 'station') throw new Error(`The id '${id}' already names a ${existing.plugin_kind}`);
    const manifest = JSON.stringify({ description, layout, slots: layouts[layout], icon, custom: true });
    this.db.prepare(`
      INSERT INTO ui_plugins(plugin_id,plugin_kind,label,version,client_entry,server_entry,manifest_json,enabled)
      VALUES(?,?,?,?,NULL,NULL,?,1)
      ON CONFLICT(plugin_id) DO UPDATE SET label=excluded.label, manifest_json=excluded.manifest_json
    `).run(id, 'station', label, '1.0.0', manifest);
    return this.db.prepare('SELECT * FROM ui_plugins WHERE plugin_id=?').get(id);
  }

  stationContributions(stationId) {
    return this.db.prepare(`
      SELECT sc.*, up.label, up.client_entry, up.manifest_json
      FROM station_contributions sc
      JOIN ui_plugins up ON up.plugin_id = sc.contribution_id
      WHERE sc.station_id=? AND sc.enabled=1 AND up.enabled=1
      ORDER BY sc.slot_name, sc.sort_order, sc.contribution_id
    `).all(stationId).map(row => ({ ...row, config: row.config_json ? JSON.parse(row.config_json) : {} }));
  }

  setStationContribution({ stationId, slotName, contributionId, sortOrder = 100, config = null, enabled = true, remove = false }) {
    if (!stationId || !slotName || !contributionId) throw new Error('stationId, slotName and contributionId are required');
    if (remove) {
      this.db.prepare('DELETE FROM station_contributions WHERE station_id=? AND slot_name=? AND contribution_id=?')
        .run(stationId, slotName, contributionId);
      return { removed: true };
    }
    const station = this.db.prepare("SELECT plugin_id, manifest_json FROM ui_plugins WHERE plugin_id=? AND plugin_kind='station'").get(stationId);
    if (!station) throw new Error(`Unknown station: ${stationId}`);
    const slots = JSON.parse(station.manifest_json || '{}').slots || [];
    if (!slots.includes(slotName)) throw new Error(`Station ${stationId} has no slot '${slotName}' (slots: ${slots.join(', ')})`);
    const contribution = this.db.prepare("SELECT plugin_id FROM ui_plugins WHERE plugin_id=? AND plugin_kind='contribution'").get(contributionId);
    if (!contribution) throw new Error(`Unknown contribution: ${contributionId}`);
    this.db.prepare(`
      INSERT INTO station_contributions(station_id,slot_name,contribution_id,sort_order,config_json,enabled)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(station_id,slot_name,contribution_id) DO UPDATE SET
        sort_order=excluded.sort_order, config_json=excluded.config_json, enabled=excluded.enabled
    `).run(stationId, slotName, contributionId, sortOrder, config ? JSON.stringify(config) : null, enabled ? 1 : 0);
    return this.db.prepare('SELECT * FROM station_contributions WHERE station_id=? AND slot_name=? AND contribution_id=?')
      .get(stationId, slotName, contributionId);
  }

  workspacePlugins(rootPath) {
    return this.db.prepare(`
      SELECT wp.*, up.label, up.plugin_kind, up.manifest_json
      FROM workspace_plugins wp
      JOIN ui_plugins up ON up.plugin_id = wp.plugin_id
      WHERE wp.workspace_root=? AND wp.enabled=1 AND up.enabled=1
      ORDER BY wp.sort_order, up.label
    `).all(path.resolve(rootPath)).map(row => ({ ...row, manifest: JSON.parse(row.manifest_json || '{}') }));
  }

  setWorkspacePlugin({ rootPath, pluginId, enabled = true, sortOrder = 100, config = null }) {
    const root = path.resolve(rootPath);
    if (!this.getWorkspace(root)) throw new Error('Workspace is not registered');
    if (!this.db.prepare('SELECT plugin_id FROM ui_plugins WHERE plugin_id=?').get(pluginId)) {
      throw new Error(`Unknown plugin: ${pluginId}`);
    }
    this.db.prepare(`
      INSERT INTO workspace_plugins(workspace_root,plugin_id,enabled,sort_order,config_json)
      VALUES(?,?,?,?,?)
      ON CONFLICT(workspace_root,plugin_id) DO UPDATE SET
        enabled=excluded.enabled, sort_order=excluded.sort_order, config_json=excluded.config_json
    `).run(root, pluginId, enabled ? 1 : 0, sortOrder, config ? JSON.stringify(config) : null);
    return this.db.prepare('SELECT * FROM workspace_plugins WHERE workspace_root=? AND plugin_id=?').get(root, pluginId);
  }

  composition(rootPath = null) {
    const catalog = this.listCatalog();
    const enabled = rootPath ? this.workspacePlugins(rootPath) : [];
    const stations = {};
    for (const row of enabled.filter(r => r.plugin_kind === 'station')) {
      stations[row.plugin_id] = this.stationContributions(row.plugin_id);
    }
    return { catalog, enabled, stations };
  }

  // ------------------------------------------------------------- fs + labels
  // Folders are real filesystem directories (containment-checked, provenance
  // event appended). Labels are the owner's designation schema, living in the
  // same SQLite crosswalk as the composition tables: `labels` defines the
  // schema, `path_labels` assigns names to files or folders.

  createDirectory({ rootPath, dirPath, actor = 'human' }) {
    const target = this.assertInsideWorkspace(rootPath, dirPath);
    if (fs.existsSync(target)) throw new Error('Already exists: ' + target);
    fs.mkdirSync(target, { recursive: true });
    this.appendEvent({ filePath: target, eventType: 'MKDIR', actor, metadata: { workspace_root: path.resolve(rootPath) } });
    return { path: target, created: true };
  }

  // Governed move for the tree's drag-and-drop: renames on disk, then carries
  // every path-keyed row (registry, labels, amendments, frozen versions) to the
  // new path so identity and history follow the file. Directories move with
  // everything under them. A MOVE event lands at the new path naming the old.
  moveEntry({ rootPath, fromPath, toPath, actor = 'human' }) {
    const from = this.assertInsideWorkspace(rootPath, fromPath);
    const to = this.assertInsideWorkspace(rootPath, toPath);
    if (from === to) return { path: to, moved: false };
    if (!fs.existsSync(from)) throw new Error('No such file or folder: ' + from);
    if (fs.existsSync(to)) throw new Error('Already exists: ' + to);
    if ((to + '/').startsWith(from + '/')) throw new Error('Cannot move a folder into itself');
    const isDir = fs.statSync(from).isDirectory();
    const affectedRoots = isDir ? this.registeredRootsUnder(from) : [];
    fs.renameSync(from, to);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const tables = ['artifact_registry', 'path_labels', 'amendments', 'artifact_versions'];
      for (const table of tables) {
        this.db.prepare(`UPDATE ${table} SET path=? WHERE path=?`).run(to, from);
        if (isDir) {
          this.db.prepare(`UPDATE ${table} SET path=? || substr(path, length(?)+1) WHERE path LIKE ? || '/%'`)
            .run(to, from, from);
        }
      }
      // A registration follows its folder. root_path is the parent key of the
      // artifact_registry FK, so: insert the new root, re-point every
      // workspace-keyed row, then drop the old root (nothing left to cascade).
      for (const oldRoot of affectedRoots) {
        const newRoot = oldRoot === from ? to : to + oldRoot.slice(from.length);
        const row = this.db.prepare('SELECT * FROM workspace_roots WHERE root_path=?').get(oldRoot);
        this.db.prepare('INSERT INTO workspace_roots(root_path,label,created_at,updated_at) VALUES(?,?,?,?)')
          .run(newRoot, row.label, row.created_at, now());
        for (const table of ['artifact_registry', 'workspace_plugins', 'workspace_ui_preferences', 'sidebar_sections', 'path_labels']) {
          this.db.prepare(`UPDATE ${table} SET workspace_root=? WHERE workspace_root=?`).run(newRoot, oldRoot);
        }
        this.db.prepare('DELETE FROM workspace_roots WHERE root_path=?').run(oldRoot);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      fs.renameSync(to, from); // put the bytes back rather than leave disk and registry split
      throw error;
    }
    this.appendEvent({ filePath: to, eventType: 'MOVE', actor, metadata: { from, kind: isDir ? 'directory' : 'file' } });
    return { path: to, from, moved: true, kind: isDir ? 'directory' : 'file' };
  }

  // Governed delete = move to trash. The entry (file or folder, with
  // everything under it) moves to <workspace>/.research-ops/trash/<stamp>-<name>,
  // which the tree never lists. Registry rows follow the bytes and flip to
  // 'archived'; labels and amendments follow too; a DELETE event names where
  // it came from. Nothing is unlinked — the owner can pull it back from the
  // trash folder by hand, and a rm of the trash dir is an explicit shell act.
  deleteEntry({ rootPath, filePath, actor = 'human' }) {
    const root = path.resolve(rootPath);
    const target = this.assertInsideWorkspace(root, filePath);
    if (target === root) throw new Error('Refusing to trash the workspace root itself');
    if (!fs.existsSync(target)) throw new Error('No such file or folder: ' + target);
    if (target.includes(`${path.sep}.research-ops${path.sep}`)) throw new Error('Already in the trash');
    const isDir = fs.statSync(target).isDirectory();
    // Folders being trashed may themselves be registered workspace roots (or
    // contain some). Their registrations go with them — a workspace_roots row
    // pointing at trashed bytes is the ghost that haunted the switcher.
    const unregistered = isDir ? this.registeredRootsUnder(target).filter(r => r !== root) : [];
    const trashDir = path.join(root, '.research-ops', 'trash');
    fs.mkdirSync(trashDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(trashDir, `${stamp}-${path.basename(target)}`);
    fs.renameSync(target, dest);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of ['artifact_registry', 'path_labels', 'amendments', 'artifact_versions']) {
        this.db.prepare(`UPDATE ${table} SET path=? WHERE path=?`).run(dest, target);
        if (isDir) {
          this.db.prepare(`UPDATE ${table} SET path=? || substr(path, length(?)+1) WHERE path LIKE ? || '/%'`)
            .run(dest, target, target);
        }
      }
      for (const ghost of unregistered) this.#unregisterWorkspaceRows(ghost);
      this.db.prepare("UPDATE artifact_registry SET state='archived', updated_at=? WHERE path=? OR path LIKE ? || '/%'")
        .run(now(), dest, dest);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      fs.renameSync(dest, target);
      throw error;
    }
    this.appendEvent({ filePath: dest, eventType: 'DELETE', actor, metadata: { from: target, kind: isDir ? 'directory' : 'file', trash: true, ...(unregistered.length ? { unregistered_workspaces: unregistered } : {}) } });
    return { trashed: true, from: target, path: dest, kind: isDir ? 'directory' : 'file', unregisteredWorkspaces: unregistered };
  }

  listLabels() {
    const counts = {};
    for (const row of this.db.prepare('SELECT label, COUNT(*) AS n FROM path_labels GROUP BY label').all()) {
      counts[row.label] = row.n;
    }
    return this.db.prepare('SELECT * FROM labels ORDER BY name').all()
      .map(row => ({ ...row, assigned: counts[row.name] || 0 }));
  }

  defineLabel({ name, color = '#4fa3ff', description = null }) {
    if (!name || !/^[a-z0-9][a-z0-9 ._-]*$/i.test(name)) throw new Error('Label names: letters, digits, space, dot, dash, underscore');
    this.db.prepare(`
      INSERT INTO labels(name,color,description,created_at) VALUES(?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET color=excluded.color, description=excluded.description
    `).run(name, color, description, now());
    return this.db.prepare('SELECT * FROM labels WHERE name=?').get(name);
  }

  renameLabel({ name, newName }) {
    if (!newName || !/^[a-z0-9][a-z0-9 ._-]*$/i.test(newName)) throw new Error('Label names: letters, digits, space, dot, dash, underscore');
    const existing = this.db.prepare('SELECT * FROM labels WHERE name=?').get(name);
    if (!existing) throw new Error('Unknown label: ' + name);
    if (this.db.prepare('SELECT name FROM labels WHERE name=?').get(newName)) throw new Error('A label named ' + newName + ' already exists');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO labels(name,color,description,created_at) VALUES(?,?,?,?)')
        .run(newName, existing.color, existing.description, existing.created_at);
      this.db.prepare('UPDATE path_labels SET label=? WHERE label=?').run(newName, name);
      this.db.prepare('DELETE FROM labels WHERE name=?').run(name);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.db.prepare('SELECT * FROM labels WHERE name=?').get(newName);
  }

  deleteLabel(name) {
    this.db.prepare('DELETE FROM path_labels WHERE label=?').run(name);
    this.db.prepare('DELETE FROM labels WHERE name=?').run(name);
    return { deleted: name };
  }

  pathLabels(rootPath) {
    const rows = this.db.prepare(`
      SELECT pl.path, pl.label, l.color FROM path_labels pl
      JOIN labels l ON l.name = pl.label
      WHERE pl.workspace_root=? ORDER BY pl.path, pl.label
    `).all(path.resolve(rootPath));
    const byPath = {};
    for (const row of rows) (byPath[row.path] ??= []).push({ label: row.label, color: row.color });
    return byPath;
  }

  assignLabel({ rootPath, filePath, label, actor = 'human', remove = false }) {
    const target = this.assertInsideWorkspace(rootPath, filePath);
    if (remove) {
      this.db.prepare('DELETE FROM path_labels WHERE path=? AND label=?').run(target, label);
      return { path: target, label, removed: true };
    }
    if (!this.db.prepare('SELECT name FROM labels WHERE name=?').get(label)) {
      throw new Error('Unknown label: ' + label + ' — define it in the schema first');
    }
    if (!fs.existsSync(target)) throw new Error('No such file or folder: ' + target);
    this.db.prepare(`
      INSERT INTO path_labels(workspace_root,path,label,actor,created_at) VALUES(?,?,?,?,?)
      ON CONFLICT(path,label) DO NOTHING
    `).run(path.resolve(rootPath), target, label, actor, now());
    return { path: target, label, assigned: true };
  }

  // ------------------------------------------------- appearance + navigation
  // Validated JSON preferences. Workspace scope wins over user scope wins over
  // defaults; the kernel resolves that — here we only store clean values.

  static #prefValidators = {
    theme: v => ['light', 'dark', 'system'].includes(v),
    density: v => ['compact', 'comfortable'].includes(v),
    accent: v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v),
    radius: v => ['rounded', 'square'].includes(v),
    fontSize: v => Number.isFinite(v) && v >= 11 && v <= 20,
    editorFontSize: v => Number.isFinite(v) && v >= 11 && v <= 22,
    sidebar: v => v && typeof v === 'object' && !Array.isArray(v)
      && (v.width === undefined || (Number.isFinite(v.width) && v.width >= 180 && v.width <= 560))
      && (v.collapsed === undefined || typeof v.collapsed === 'boolean'),
    paneSplit: v => Number.isFinite(v) && v >= 20 && v <= 80,
    dashboard: v => v && typeof v === 'object' && !Array.isArray(v),
    favorites: v => Array.isArray(v) && v.every(x => typeof x === 'string'),
    order: v => v && typeof v === 'object' && !Array.isArray(v)
      && Object.values(v).every(list => Array.isArray(list) && list.every(x => typeof x === 'string')),
    links: v => Array.isArray(v) && v.every(x => x && typeof x.label === 'string' && typeof x.url === 'string'),
    icon: v => typeof v === 'string' && v.length <= 8
  };

  static cleanPreferences(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Preferences must be a JSON object');
    const clean = {};
    for (const [key, value] of Object.entries(raw)) {
      const validator = ControlStore.#prefValidators[key];
      if (!validator) continue; // unknown keys are dropped, never stored
      if (!validator(value)) throw new Error(`Preference '${key}' has an invalid value`);
      clean[key] = value;
    }
    return clean;
  }

  uiPreferences(rootPath = null) {
    const row = rootPath
      ? this.db.prepare('SELECT preference_json AS j FROM workspace_ui_preferences WHERE workspace_root=?').get(path.resolve(rootPath))
      : this.db.prepare("SELECT value_json AS j FROM user_ui_preferences WHERE key='ui'").get();
    try { return row ? JSON.parse(row.j) : {}; } catch { return {}; }
  }

  setUiPreferences({ rootPath = null, patch = null, reset = false }) {
    const ts = now();
    if (reset) {
      if (rootPath) this.db.prepare('DELETE FROM workspace_ui_preferences WHERE workspace_root=?').run(path.resolve(rootPath));
      else this.db.prepare("DELETE FROM user_ui_preferences WHERE key='ui'").run();
      return {};
    }
    const merged = ControlStore.cleanPreferences({ ...this.uiPreferences(rootPath), ...patch });
    const json = JSON.stringify(merged);
    if (rootPath) {
      const root = path.resolve(rootPath);
      if (!this.getWorkspace(root)) throw new Error('Workspace is not registered');
      this.db.prepare(`
        INSERT INTO workspace_ui_preferences(workspace_root,preference_json,updated_at) VALUES(?,?,?)
        ON CONFLICT(workspace_root) DO UPDATE SET preference_json=excluded.preference_json, updated_at=excluded.updated_at
      `).run(root, json, ts);
    } else {
      this.db.prepare(`
        INSERT INTO user_ui_preferences(key,value_json,updated_at) VALUES('ui',?,?)
        ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
      `).run(json, ts);
    }
    return merged;
  }

  sidebarSections(rootPath, defaults = []) {
    const root = path.resolve(rootPath);
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM sidebar_sections WHERE workspace_root=?').get(root);
    if (count.n === 0 && defaults.length) {
      const insert = this.db.prepare(`
        INSERT INTO sidebar_sections(workspace_root,section_id,visible,collapsed,sort_order,config_json)
        VALUES(?,?,1,0,?,NULL)`);
      defaults.forEach((id, i) => insert.run(root, id, (i + 1) * 10));
    }
    return this.db.prepare('SELECT * FROM sidebar_sections WHERE workspace_root=? ORDER BY sort_order, section_id').all(root)
      .map(row => ({ ...row, config: row.config_json ? JSON.parse(row.config_json) : {} }));
  }

  setSidebarSection({ rootPath, sectionId, visible, collapsed, sortOrder, config }) {
    const root = path.resolve(rootPath);
    if (!sectionId) throw new Error('sectionId is required');
    // A first edit must not swallow the defaults: seed them before writing,
    // so hiding one section never becomes hiding all the others.
    this.sidebarSections(root, this.sidebarDefaults || []);
    const existing = this.db.prepare('SELECT * FROM sidebar_sections WHERE workspace_root=? AND section_id=?').get(root, sectionId);
    this.db.prepare(`
      INSERT INTO sidebar_sections(workspace_root,section_id,visible,collapsed,sort_order,config_json)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(workspace_root,section_id) DO UPDATE SET
        visible=excluded.visible, collapsed=excluded.collapsed,
        sort_order=excluded.sort_order, config_json=excluded.config_json
    `).run(root, sectionId,
      (visible ?? (existing ? existing.visible === 1 : true)) ? 1 : 0,
      (collapsed ?? (existing ? existing.collapsed === 1 : false)) ? 1 : 0,
      sortOrder ?? existing?.sort_order ?? 100,
      config !== undefined ? (config ? JSON.stringify(config) : null) : existing?.config_json ?? null);
    return this.db.prepare('SELECT * FROM sidebar_sections WHERE workspace_root=? AND section_id=?').get(root, sectionId);
  }

  // ------------------------------------------------------------ trash + recent

  listTrash(rootPath) {
    const root = path.resolve(rootPath);
    const trashDir = path.join(root, '.research-ops', 'trash');
    if (!fs.existsSync(trashDir)) return [];
    return fs.readdirSync(trashDir, { withFileTypes: true }).map(entry => {
      const full = path.join(trashDir, entry.name);
      const event = this.db.prepare("SELECT metadata_json, created_at FROM artifact_events WHERE path=? AND event_type='DELETE' ORDER BY event_id DESC").get(full);
      let from = null;
      try { from = event ? JSON.parse(event.metadata_json).from : null; } catch { from = null; }
      return { name: entry.name, path: full, kind: entry.isDirectory() ? 'directory' : 'file', from, trashedAt: event?.created_at || null };
    }).sort((a, b) => String(b.trashedAt).localeCompare(String(a.trashedAt)));
  }

  restoreEntry({ rootPath, trashPath, actor = 'human' }) {
    const root = path.resolve(rootPath);
    const source = this.assertInsideWorkspace(root, trashPath);
    if (!source.startsWith(path.join(root, '.research-ops', 'trash') + path.sep)) throw new Error('Not a trash entry: ' + source);
    if (!fs.existsSync(source)) throw new Error('No such trash entry: ' + source);
    const event = this.db.prepare("SELECT metadata_json FROM artifact_events WHERE path=? AND event_type='DELETE' ORDER BY event_id DESC").get(source);
    let target = null;
    try { target = event ? JSON.parse(event.metadata_json).from : null; } catch { target = null; }
    if (!target) target = path.join(root, path.basename(source).replace(/^[0-9T-]+Z?-/, ''));
    if (fs.existsSync(target)) throw new Error('Cannot restore — something already exists at ' + target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const isDir = fs.statSync(source).isDirectory();
    fs.renameSync(source, target);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of ['artifact_registry', 'path_labels', 'amendments', 'artifact_versions']) {
        this.db.prepare(`UPDATE ${table} SET path=? WHERE path=?`).run(target, source);
        if (isDir) {
          this.db.prepare(`UPDATE ${table} SET path=? || substr(path, length(?)+1) WHERE path LIKE ? || '/%'`)
            .run(target, source, source);
        }
      }
      // Restored files come back as working: bytes are unchanged but their
      // place in the lifecycle must be re-earned (promoted_checksum survives).
      this.db.prepare("UPDATE artifact_registry SET state='working', updated_at=? WHERE path=? OR path LIKE ? || '/%'")
        .run(now(), target, target);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      fs.renameSync(target, source);
      throw error;
    }
    this.appendEvent({ filePath: target, eventType: 'RESTORE', actor, metadata: { from: source, kind: isDir ? 'directory' : 'file' } });
    return { restored: true, from: source, path: target, kind: isDir ? 'directory' : 'file' };
  }

  // Permanent deletion: only entries already in the trash can be purged. Bytes
  // are unlinked and every path-keyed row goes with them; the event ledger is
  // the one thing that keeps the purge on record.
  purgeTrashEntry({ rootPath, trashPath, actor = 'human' }) {
    const root = path.resolve(rootPath);
    const source = this.assertInsideWorkspace(root, trashPath);
    if (!source.startsWith(path.join(root, '.research-ops', 'trash') + path.sep)) throw new Error('Not a trash entry: ' + source);
    if (!fs.existsSync(source)) throw new Error('No such trash entry: ' + source);
    const isDir = fs.statSync(source).isDirectory();
    fs.rmSync(source, { recursive: true, force: true });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of ['artifact_registry', 'path_labels', 'amendments', 'artifact_versions']) {
        this.db.prepare(`DELETE FROM ${table} WHERE path=?`).run(source);
        if (isDir) this.db.prepare(`DELETE FROM ${table} WHERE path LIKE ? || '/%'`).run(source);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.appendEvent({ filePath: source, eventType: 'PURGE', actor, metadata: { permanent: true, kind: isDir ? 'directory' : 'file' } });
    return { purged: true, path: source };
  }

  emptyTrash({ rootPath, actor = 'human' }) {
    const entries = this.listTrash(rootPath);
    for (const entry of entries) this.purgeTrashEntry({ rootPath, trashPath: entry.path, actor });
    return { purged: entries.length };
  }

  recentActivity(rootPath, limit = 12) {
    return this.db.prepare(`
      SELECT e.path, MAX(e.event_id) AS last_event, e.event_type, e.actor, e.created_at
      FROM artifact_events e
      JOIN artifact_registry r ON r.path = e.path
      WHERE r.workspace_root = ? AND r.path NOT LIKE ? || '/%'
      GROUP BY e.path
      ORDER BY last_event DESC
      LIMIT ?
    `).all(path.resolve(rootPath), path.join(path.resolve(rootPath), '.research-ops'), limit);
  }

  // ---------------------------------------------------------------- amendments
  // An amendment is an append-only proposal against one card (block) of one
  // document. rev is the next number for (path, card); nothing here ever
  // rewrites a prior rev, and nothing here touches the document itself.

  appendAmendment({ filePath, card = '', body, note = null, actor = 'human' }) {
    if (!filePath) throw new Error('filePath is required');
    if (typeof body !== 'string' || !body.length) throw new Error('Amendment body must be non-empty text');
    const target = path.resolve(filePath);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare('SELECT COALESCE(MAX(rev),0) AS r FROM amendments WHERE path=? AND card=?').get(target, card);
      const rev = current.r + 1;
      const ts = now();
      this.db.prepare(`
        INSERT INTO amendments(path,card,rev,body,note,actor,sha256,created_at)
        VALUES(?,?,?,?,?,?,?,?)
      `).run(target, card, rev, body, note, actor, sha256(Buffer.from(body, 'utf8')), ts);
      this.db.exec('COMMIT');
      return this.db.prepare('SELECT * FROM amendments WHERE path=? AND card=? AND rev=?').get(target, card, rev);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listAmendments(filePath, card = null) {
    const target = path.resolve(filePath);
    const rows = card === null
      ? this.db.prepare('SELECT * FROM amendments WHERE path=? ORDER BY card, rev').all(target)
      : this.db.prepare('SELECT * FROM amendments WHERE path=? AND card=? ORDER BY rev').all(target, card);
    const latestRevByCard = {};
    for (const row of rows) latestRevByCard[row.card] = Math.max(latestRevByCard[row.card] || 0, row.rev);
    return { path: target, entries: rows, latestRevByCard };
  }

  // Decisions are record-only review verdicts: accept | needs-more-work.
  // They move nothing and change nothing; they land in the event ledger.
  recordDecision({ filePath, card = '', decision, note = null, actor = 'human' }) {
    if (!['accept', 'needs-more-work'].includes(decision)) {
      const error = new Error(`'${decision}' is not a decision this app records. The two decisions are accept and needs-more-work.`);
      error.code = 'UNKNOWN_DECISION';
      throw error;
    }
    const target = path.resolve(filePath);
    const artifact = this.getArtifact(target);
    this.appendEvent({
      filePath: target, eventType: 'DECISION', checksum: artifact?.checksum || null, actor,
      metadata: { card, decision, note, effect: 'record only — this decision moves and changes nothing' }
    });
    return this.listDecisions(target);
  }

  listDecisions(filePath) {
    const target = path.resolve(filePath);
    const rows = this.db.prepare("SELECT * FROM artifact_events WHERE path=? AND event_type='DECISION' ORDER BY event_id").all(target)
      .map(row => ({ ...row, metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {} }));
    const latestByCard = {};
    for (const row of rows) latestByCard[row.metadata.card || ''] = row.metadata.decision;
    return { path: target, entries: rows, latestByCard };
  }
}

export { sha256 };
