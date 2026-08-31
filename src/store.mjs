import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { allowedTransitions, schemaSql } from './schema.mjs';

const now = () => new Date().toISOString();
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

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

  bindTrace({ filePath, runId, spanId = null, actor = 'human' }) {
    const target = path.resolve(filePath);
    const artifact = this.getArtifact(target);
    if (!artifact) throw new Error('Artifact is not registered');
    this.db.prepare('UPDATE artifact_registry SET last_run_id=?, last_span_id=?, updated_at=? WHERE path=?').run(runId, spanId, now(), target);
    this.appendEvent({ filePath: target, eventType: 'TRACE_BINDING', checksum: artifact.checksum, actor, runId, spanId });
    return this.getArtifact(target);
  }
}

export { sha256 };
