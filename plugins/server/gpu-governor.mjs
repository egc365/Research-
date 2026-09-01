// Service: read-only window onto the gpu-governor daemon (/apps/gpu-governor/
// gpu_governor.py, a systemd unit enforcing GPU memory budgets). The governor
// process itself stays outside this app — this plugin only reads its data
// files: latest.json (current snapshot, rewritten each poll, so a torn read is
// a real runtime case), events.jsonl (append-only kill/would-kill log, read
// tail-only), and the owner allowlist JSON. The allowlist is being repointed
// from /wiki/config/ to <governor dir>/config/ — the new path is tried FIRST,
// the legacy path is the fallback. Nothing here mutates governor state; the
// STOP buttons live on the daemon's own dashboard at :7890.
import fs from 'node:fs';
import path from 'node:path';

const DASHBOARD_URL = 'http://127.0.0.1:7890';
const DEFAULT_DIR = '/apps/gpu-governor';
const LEGACY_ALLOWLIST = '/wiki/config/gpu-allowlist.json';

// RESEARCH_OPS_GPU_GOVERNOR_DIR overrides the governor data dir (for tests);
// RESEARCH_OPS_GPU_ALLOWLIST overrides the legacy fallback path.
function governorDir() {
  return process.env.RESEARCH_OPS_GPU_GOVERNOR_DIR || DEFAULT_DIR;
}

// New path first (the repoint target), legacy path as fallback. Reports which
// slot won so the UI can show which allowlist file is live.
function resolveAllowlist(baseDir) {
  const candidates = [
    { slot: 'new', path: path.join(baseDir, 'config', 'gpu-allowlist.json') },
    { slot: 'legacy', path: process.env.RESEARCH_OPS_GPU_ALLOWLIST || LEGACY_ALLOWLIST }
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate.path).isFile()) return candidate;
    } catch { /* try the next candidate */ }
  }
  return { slot: null, path: null };
}

// Defensive JSON read: the daemon rewrites latest.json non-atomically, so a
// missing file or a torn/partial write degrades to null, never a throw.
function readJson(file) {
  try {
    return { value: JSON.parse(fs.readFileSync(file, 'utf8')), error: null };
  } catch (error) {
    return { value: null, error: error.code === 'ENOENT' ? 'missing' : `unreadable: ${error.message}` };
  }
}

// Last `limit` events without loading the whole log: stat for size, read only
// a tail window, drop the possibly-truncated first fragment, parse each line
// defensively. Returned newest first.
function tailEvents(file, limit) {
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    const window = Math.min(size, Math.max(64 * 1024, limit * 2048));
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(window);
    fs.readSync(fd, buffer, 0, window, size - window);
    let lines = buffer.toString('utf8').split('\n');
    if (window < size) lines = lines.slice(1); // first fragment may be a torn line
    const events = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { events.push(JSON.parse(trimmed)); } catch { /* torn or corrupt row: skip */ }
    }
    return events.slice(-limit).reverse();
  } catch {
    return null; // missing/unreadable log degrades to null, never a throw
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export const plugin = {
  id: 'gpu-governor',
  label: 'GPU governor',
  order: 88,
  scope: 'workspace',
  surface: 'main',
  category: 'monitoring',
  description: 'Read-only window onto the gpu-governor daemon: current GPU snapshot, allowlist rules (new config path first, legacy fallback), and the tail of the enforcement event log.',
  async action({ action, payload }) {
    if (action !== 'status') throw new Error(`Unknown gpu-governor action: ${action}`);
    const baseDir = governorDir();
    const limit = Math.min(Math.max(Number(payload?.limit) || 20, 1), 200);

    const latest = readJson(path.join(baseDir, 'latest.json'));
    const allowlist = resolveAllowlist(baseDir);
    const rules = allowlist.path ? readJson(allowlist.path) : { value: null, error: 'missing' };
    const events = tailEvents(path.join(baseDir, 'events.jsonl'), limit);

    return {
      checkedAt: new Date().toISOString(),
      baseDir,
      dashboardUrl: DASHBOARD_URL,
      latest: latest.value,
      latestError: latest.error,
      allowlistPath: allowlist.path,
      allowlistSource: allowlist.slot, // 'new' | 'legacy' | null
      rules: rules.value,
      rulesError: allowlist.path ? rules.error : 'missing',
      events, // newest first, or null when the log is missing
      eventLimit: limit
    };
  }
};
