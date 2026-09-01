// revision-service: the adapter around the Revision Center's useful domain
// operations. The station talks to this service and never learns where the
// records physically live:
//   - base/working documents: git HEAD when the file is in a git work tree,
//     otherwise the last promoted bytes from our own registry (candidate file
//     preferred as the working side, matching :8880's behavior)
//   - session transcripts and cards: proxied read-only from the live Revision
//     Center at :8880 (its transcript index over ~/.claude/projects). When
//     that app is down or refuses the path, the answer degrades honestly to
//     an empty list with a note — never a thrown error.
//   - amendments and decisions stay in THIS app's store (append-only), so
//     nothing here ever writes into /apps/revision-center/state.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const REVISION_CENTER = process.env.REVISION_CENTER_BASE || 'http://127.0.0.1:8880';
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

function gitHead(filePath) {
  try {
    const dir = path.dirname(filePath);
    const top = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const rel = path.relative(top, filePath);
    const text = execFileSync('git', ['-C', top, 'show', `HEAD:${rel}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
    return { text, sha256: sha256(text), from: `git HEAD (${top})` };
  } catch {
    return null; // not in git, not tracked, or git absent — all honest reasons
  }
}

async function proxy(pathname) {
  let response;
  try {
    response = await fetch(REVISION_CENTER + pathname, { signal: AbortSignal.timeout(10_000) });
  } catch {
    return { unavailable: `The Revision Center at ${REVISION_CENTER} is not reachable, so transcript data is unavailable here.` };
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { unavailable: data.error || `The Revision Center refused this path (status ${response.status}).` };
  }
  return data;
}

export const plugin = {
  id: 'revision',
  label: 'Revision service',
  order: 45,
  scope: 'file',
  category: 'document',
  requiresFile: true,
  description: 'Adapter over revision-domain operations: base/working document pairs, and the Revision Center transcript index (read-only proxy).',

  async action({ action, payload, store }) {
    if (action === 'open') {
      const { rootPath, path: filePath } = payload;
      if (!filePath) throw new Error('open needs a path');
      const target = path.resolve(filePath);
      let workingText = null, workingFrom = 'the working file';
      const candidate = target + '.candidate';
      const source = fs.existsSync(candidate) ? (workingFrom = 'the .candidate file', candidate)
        : fs.existsSync(target) ? target : null;
      if (source) {
        const bytes = fs.readFileSync(source);
        try { workingText = bytes.toString('utf8'); } catch { workingText = null; }
        if (workingText !== null && workingText.includes('�')) workingText = null;
      }
      if (workingText === null) {
        return { path: target, supported: false,
          note: source ? 'This file is not UTF-8 text, so it cannot be reviewed as a document.'
                       : 'This file does not exist on disk.' };
      }
      let base = payload.preferBase === 'promoted' ? null : gitHead(target);
      if (!base && rootPath) {
        const promoted = store.getPromotedVersion?.(target);
        if (promoted) {
          // node:sqlite hands BLOBs back as Uint8Array, not Buffer
          const text = typeof promoted.content === 'string' ? promoted.content : Buffer.from(promoted.content).toString('utf8');
          base = { text, sha256: promoted.checksum, from: `promoted version (${promoted.created_at})` };
        }
      }
      return {
        path: target, supported: true,
        base: base || { text: '', sha256: null, from: 'no preserved version — not tracked by git and never promoted' },
        working: { text: workingText, sha256: sha256(workingText), from: workingFrom },
        hasBase: !!base
      };
    }

    if (action === 'sessions') {
      const data = await proxy(`/api/sessions?path=${encodeURIComponent(payload.path)}`);
      if (data.unavailable) return { sessions: [], note: data.unavailable };
      return { sessions: data.sessions || [], index: data.index || null };
    }
    if (action === 'cards') {
      const data = await proxy(`/api/cards/${encodeURIComponent(payload.session)}?path=${encodeURIComponent(payload.path)}`);
      if (data.unavailable) return { cards: [], note: data.unavailable };
      return { cards: data.cards || [], session: data.session };
    }
    if (action === 'events') {
      const data = await proxy(`/api/session/${encodeURIComponent(payload.session)}?path=${encodeURIComponent(payload.path)}`);
      if (data.unavailable) return { events: [], note: data.unavailable };
      return { events: data.events || [], session: data.session, jsonl: data.jsonl };
    }
    throw new Error(`Unknown revision action: ${action}`);
  }
};
