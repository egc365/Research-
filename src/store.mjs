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

  listWorkspaces() {
    return this.db.prepare('SELECT * FROM workspace_roots ORDER BY label, root_path').all();
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
      VALUES(?,?,?,?,NULL,1)
    `);
    for (const [stationId, slots] of Object.entries(defaultWiring)) {
      if (count.get(stationId).n > 0) continue; // owner wiring survives restarts
      for (const [slotName, contributionIds] of Object.entries(slots)) {
        contributionIds.forEach((cid, i) => insert.run(stationId, slotName, cid, (i + 1) * 10));
      }
    }
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
