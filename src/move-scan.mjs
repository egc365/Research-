import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// Folders never scanned for moved files. Documented default; per-workspace ignore
// rules (Branch 2) will extend this list from the control DB.
export const DEFAULT_IGNORES = ['.git', '.research-ops', 'node_modules', '__pycache__', '.venv', 'venv', '.cache', '.nvm'];

const jobs = new Map();

export function getScanJob(jobId) { return jobs.get(jobId) || null; }

export function scanJobStatus(job) {
  return {
    jobId: job.id,
    root: job.root,
    state: job.state,
    scanned: job.scanned,
    skippedLarge: job.skippedLarge,
    truncated: job.truncated,
    missingCount: job.missingCount,
    proposals: job.proposals,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt
  };
}

export function cancelScanJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (job.state === 'running') job.cancel = true;
  return job;
}

// Never runs on the request path synchronously: the walk is fully async, yields
// between directories, hashes only files under maxFileBytes, and is bounded by
// maxFiles — so /api/* stays responsive while a scan runs.
export function startMoveScan(store, rootPath, options = {}) {
  const {
    maxFileBytes = 10 * 1024 * 1024,
    maxFiles = 20000,
    ignores = DEFAULT_IGNORES,
    yieldDelayMs = 0
  } = options;
  const root = path.resolve(rootPath);
  const job = {
    id: `scan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    root,
    state: 'running',
    scanned: 0,
    skippedLarge: 0,
    truncated: false,
    missingCount: 0,
    proposals: [],
    error: null,
    cancel: false,
    startedAt: new Date().toISOString(),
    finishedAt: null
  };
  jobs.set(job.id, job);

  job.promise = (async () => {
    try {
      const rows = store.db.prepare('SELECT * FROM artifact_registry WHERE workspace_root=?').all(root);
      const missing = rows.filter(row => !fs.existsSync(row.path));
      job.missingCount = missing.length;
      if (!missing.length) { job.state = 'done'; return; }
      const registered = new Set(rows.map(row => row.path));
      const stack = [root];
      while (stack.length) {
        if (job.cancel) { job.state = 'cancelled'; return; }
        const dir = stack.pop();
        let entries;
        try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          if (job.cancel) { job.state = 'cancelled'; return; }
          if (ignores.includes(entry.name)) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) { stack.push(full); continue; }
          if (!entry.isFile()) continue;
          if (job.scanned >= maxFiles) { job.truncated = true; job.state = 'done'; return; }
          job.scanned++;
          if (registered.has(full)) continue;
          let stat;
          try { stat = await fsp.stat(full); } catch { continue; }
          if (stat.size > maxFileBytes) { job.skippedLarge++; continue; }
          const bytes = await fsp.readFile(full);
          const checksum = createHash('sha256').update(bytes).digest('hex');
          const matches = missing.filter(row => row.checksum === checksum);
          if (matches.length === 1) {
            job.proposals.push({ fromPath: matches[0].path, toPath: full, checksum, state: matches[0].state });
          }
        }
        await new Promise(resolve => setTimeout(resolve, yieldDelayMs));
      }
      job.state = 'done';
    } catch (error) {
      job.state = 'error';
      job.error = error.message;
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  })();
  return job;
}
