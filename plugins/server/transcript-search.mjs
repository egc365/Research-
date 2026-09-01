// Service: deep search over the native session transcripts — the pre-trace
// spec of the transcript viewer (provider cutover → session → filtered
// blocks). Read-only over the provider-native roots; this service never
// rewrites a provider log and never leaves its roots. Trace logic, team /
// subagent evidence layers and DeepSeek event-log decoding are deferred
// extensions (docs/plugins/transcript-review.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

// The five native roots (transcript-viewer README, /wiki trash 2026-09-01).
// RESEARCH_OPS_TRANSCRIPT_ROOTS=name=path,name=path overrides for tests.
function providerRoots() {
  const override = process.env.RESEARCH_OPS_TRANSCRIPT_ROOTS;
  if (override) {
    return Object.fromEntries(override.split(',').map(pair => {
      const [name, ...rest] = pair.split('=');
      return [name.trim(), rest.join('=').trim()];
    }));
  }
  const home = os.homedir();
  return {
    claude: path.join(home, '.claude', 'projects'),
    codex: path.join(home, '.codex', 'sessions'),
    deepseek: '/Ai-workshop/deepseek/home/sessions',
    grok: path.join(home, '.grok', 'sessions'),
    kimi: path.join(home, '.kimi-code', 'sessions')
  };
}

function sessionFiles(root, cap = 200) {
  const found = [];
  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const stat = fs.statSync(full);
        found.push({ path: full, name: entry.name, mtimeMs: stat.mtimeMs, size: stat.size });
      }
    }
  };
  walk(root);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, cap);
}

// Provider event shapes differ; extraction is defensive by design. Text is
// every string found in the event, joined — search never depends on shape.
function flattenText(value, acc = [], depth = 0) {
  if (depth > 6 || acc.length > 200) return acc;
  if (typeof value === 'string') acc.push(value);
  else if (Array.isArray(value)) for (const item of value) flattenText(item, acc, depth + 1);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) flattenText(item, acc, depth + 1);
  return acc;
}

function eventFields(parsed) {
  const message = parsed?.message && typeof parsed.message === 'object' ? parsed.message : null;
  return {
    role: message?.role || parsed?.role || null,
    kind: parsed?.type || parsed?.kind || null,
    timestamp: parsed?.timestamp || parsed?.ts || parsed?.created_at || null
  };
}

async function searchFile(file, { needle, role, kind, dateFrom, dateTo, limit }, out) {
  const stream = fs.createReadStream(file.path, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of lines) {
    lineNo += 1;
    if (out.length >= limit) break;
    if (needle && !line.toLowerCase().includes(needle)) continue;
    let parsed = null;
    try { parsed = JSON.parse(line); } catch { /* raw line still searchable */ }
    const fields = parsed ? eventFields(parsed) : { role: null, kind: null, timestamp: null };
    if (role && fields.role !== role) continue;
    if (kind && fields.kind !== kind) continue;
    if ((dateFrom || dateTo) && fields.timestamp) {
      const ts = String(fields.timestamp);
      if (dateFrom && ts < dateFrom) continue;
      if (dateTo && ts > dateTo + '￿') continue;
    }
    const text = parsed ? flattenText(parsed).join(' ') : line;
    const at = needle ? text.toLowerCase().indexOf(needle) : 0;
    const start = Math.max(0, at - 120);
    out.push({
      session: file.name,
      path: file.path,
      line: lineNo,
      ...fields,
      snippet: text.slice(start, start + 400)
    });
  }
  lines.close();
  stream.destroy();
}

export const plugin = {
  id: 'transcript-search',
  label: 'Transcript search',
  order: 85,
  scope: 'workspace',
  surface: 'main',
  category: 'evidence',
  description: 'Deep search over the native session transcripts of every bot on this machine. Read-only: provider logs stay authoritative and untouched.',
  async action({ action, payload }) {
    const roots = providerRoots();
    if (action === 'catalog') {
      const providers = Object.entries(roots).map(([name, root]) => {
        const exists = fs.existsSync(root);
        const sessions = exists ? sessionFiles(root) : [];
        return { provider: name, root, rootExists: exists, sessionCount: sessions.length,
          sessions: sessions.slice(0, 100).map(s => ({ name: s.name, path: s.path, mtimeMs: s.mtimeMs, size: s.size })) };
      });
      return { providers };
    }
    if (action === 'search') {
      const provider = String(payload.provider || '');
      const root = roots[provider];
      if (!root) throw new Error(`Unknown provider: ${provider} (one of: ${Object.keys(roots).join(', ')})`);
      const limit = Math.min(Number(payload.limit) || 50, 200);
      const filters = {
        needle: String(payload.query || '').toLowerCase() || null,
        role: payload.role || null,
        kind: payload.kind || null,
        dateFrom: payload.dateFrom || null,
        dateTo: payload.dateTo || null,
        limit
      };
      let files;
      if (payload.session) {
        const target = path.resolve(String(payload.session));
        if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('Session path is outside the provider root');
        files = [{ path: target, name: path.basename(target) }];
      } else {
        // Unindexed deep scan is bounded: the newest sessions only. An FTS
        // index over the whole corpus is the search-engine plugin's job.
        files = sessionFiles(root, 12);
      }
      const results = [];
      for (const file of files) {
        if (results.length >= limit) break;
        await searchFile(file, filters, results);
      }
      return { provider, scanned: files.length, limit, results };
    }
    throw new Error(`Unknown transcript-search action: ${action}`);
  }
};
