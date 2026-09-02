// Service: sticky notes — a folder or file front can carry one small colored
// note, so the filesystem itself communicates a little planning information.
// Per the data rule this is CONTENT: notes live in the workspace's own
// <root>/.research-ops/stickies.sqlite3, keyed by workspace-relative path.
// One note per path; setting empty text removes it.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const handles = new Map();

// The sticky palette: classic office colors. The client offers exactly these;
// the server accepts any of them (or null = default) and nothing else, so a
// note never renders in an unreadable color.
export const STICKY_COLORS = ['#f6e58d', '#ffb8b8', '#badc58', '#7ed6df', '#e6a8f7', '#ffbe76'];
const DEFAULT_COLOR = STICKY_COLORS[0];

function stickyDb(rootPath) {
  const root = path.resolve(String(rootPath || ''));
  if (!rootPath || !fs.existsSync(root)) throw new Error(`Stickies need an existing workspace rootPath, got: ${rootPath}`);
  let db = handles.get(root);
  if (db) return db;
  const home = path.join(root, '.research-ops');
  fs.mkdirSync(home, { recursive: true });
  db = new DatabaseSync(path.join(home, 'stickies.sqlite3'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS sticky_notes (
      path TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      color TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  handles.set(root, db);
  return db;
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export const plugin = {
  id: 'stickies',
  label: 'Sticky notes',
  order: 76,
  scope: 'workspace',
  surface: 'main',
  category: 'planning',
  requiresWorkspace: true,
  description: 'One sticky note per file or folder path, stored per workspace in .research-ops/stickies.sqlite3. Owner writes; agents read.',
  async action({ action, payload, surface }) {
    // Whitelist, not per-action gates: any future mutation defaults to refused.
    if (surface === 'agent' && action !== 'list') {
      throw fail('OWNER_SURFACE_ONLY', 'Sticky notes are written on the owner surface; agents may only read them.');
    }
    const db = stickyDb(payload.rootPath);

    if (action === 'list') {
      const notes = {};
      for (const row of db.prepare('SELECT * FROM sticky_notes ORDER BY path').all()) notes[row.path] = row;
      return { notes, colors: STICKY_COLORS };
    }

    if (action === 'set') {
      const notePath = String(payload.path || '').trim();
      if (!notePath) throw fail('STICKY_BAD_INPUT', 'A sticky needs a workspace-relative path');
      if (notePath.startsWith('/') || notePath.split('/').includes('..')) {
        throw fail('STICKY_BAD_INPUT', 'Sticky paths are workspace-relative');
      }
      const text = String(payload.text ?? '').trim();
      if (!text) { // an emptied sticky comes off the folder
        db.prepare('DELETE FROM sticky_notes WHERE path=?').run(notePath);
        return { removed: notePath };
      }
      const color = payload.color == null ? DEFAULT_COLOR : String(payload.color);
      if (!STICKY_COLORS.includes(color)) throw fail('STICKY_BAD_INPUT', `Not a sticky color: ${color}`);
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO sticky_notes (path, text, color, updated_at) VALUES (?,?,?,?)
        ON CONFLICT(path) DO UPDATE SET text=excluded.text, color=excluded.color, updated_at=excluded.updated_at
      `).run(notePath, text, color, now);
      return db.prepare('SELECT * FROM sticky_notes WHERE path=?').get(notePath);
    }

    if (action === 'remove') {
      const notePath = String(payload.path || '').trim();
      if (!notePath) throw fail('STICKY_BAD_INPUT', 'Remove needs a path');
      db.prepare('DELETE FROM sticky_notes WHERE path=?').run(notePath);
      return { removed: notePath };
    }

    throw new Error(`Unknown stickies action: ${action}`);
  }
};
