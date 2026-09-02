// The board's rules, defined once. The server (plugins/server/board.mjs) and
// the whiteboard's memory store (board-store.js) both import this file, so a
// cap or a parse rule cannot drift between the two. Nothing here touches the
// filesystem, sqlite, or the DOM; Node loads it by relative path and the
// browser fetches it as /contrib/lib/board-rules.js.
import { STICKY_COLORS } from './sticky.js';

export { STICKY_COLORS };

// Lanes nest at most three deep on a surface (ADR-029). Depth 3 holds cards only.
export const MAX_DEPTH = 3;
export const MAX_FIELDS = 4;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const NAMED_ICONS = ['file', 'folder', 'note', 'link', 'image'];
const ORIENTATIONS = ['horizontal', 'vertical'];
// The canvas (ADR-043): a top-level lane sits at x, y in canvas pixels; a
// lane without a position is placed to the right of the placed ones.
export const LANE_GAP = 24;
export const LANE_DEFAULT_W = 280;

const IMAGE_EXT = { png: 'png', jpeg: 'jpg', jpg: 'jpg', gif: 'gif', webp: 'webp', 'svg+xml': 'svg', bmp: 'bmp', avif: 'avif' };

export function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// A file or folder name: one path segment, never dot or dot-dot.
export function needName(raw) {
  const name = String(raw || '').trim();
  if (!name) throw fail('BOARD_BAD_INPUT', 'A name is required');
  if (name === '.' || name === '..' || /[\\/]/.test(name)) {
    throw fail('BOARD_BAD_INPUT', 'A name is one path segment');
  }
  return name;
}

export function needLaneName(raw) {
  const name = String(raw || '').trim();
  if (!name) throw fail('BOARD_BAD_INPUT', 'A lane needs a name');
  return name;
}

// Two lanes side by side with one name would be told apart by nothing.
export function refuseDuplicateLane(name, siblings) {
  if (siblings.some(l => l.name === name)) throw fail('BOARD_BAD_INPUT', `A lane named ${name} is already here`);
  return name;
}

// The first line of a text as a slug: lowercase, runs of anything but a-z 0-9 become one dash.
export function slugText(text) {
  const first = String(text || '').trim().split(/\n/)[0];
  return first.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// A lane's slug on its surface: the name's slug, then -2, -3 ... past the taken ones.
export function laneSlug(name, taken) {
  const base = slugText(name) || 'lane';
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

// A canvas coordinate or width: a whole number of pixels, never negative; null clears it.
export function parseCoord(raw, what) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw fail('BOARD_BAD_INPUT', `${what} is a number of pixels`);
  return Math.round(n);
}

// Where a new top-level lane lands: right of every placed lane on the surface.
export function nextSpot(placed) {
  let right = 0;
  for (const l of placed) if (l.x != null) right = Math.max(right, l.x + (l.w ?? LANE_DEFAULT_W));
  return { x: right ? right + LANE_GAP : LANE_GAP, y: LANE_GAP };
}

// Rows from before the canvas: top-level lanes with no position take the
// next spot in sort order, lanes with no slug take one. Returns the rows it
// changed so a caller can write them once.
export function settleLanes(lanes) {
  const changed = new Set();
  const ordered = [...lanes].sort((a, b) => a.sort_order - b.sort_order || a.lane_id - b.lane_id);
  const bySurface = new Map();
  for (const l of ordered) {
    if (!bySurface.has(l.surface)) bySurface.set(l.surface, []);
    bySurface.get(l.surface).push(l);
  }
  for (const rows of bySurface.values()) {
    const taken = new Set(rows.map(l => l.slug).filter(Boolean));
    for (const l of rows) {
      if (l.x === undefined || l.y === undefined || l.w === undefined) { l.x ??= null; l.y ??= null; l.w ??= null; changed.add(l); }
      if (!l.slug) { l.slug = laneSlug(l.name, taken); taken.add(l.slug); changed.add(l); }
      if (l.parent_lane_id == null && l.x == null) {
        Object.assign(l, nextSpot(rows.filter(r => r.parent_lane_id == null)));
        changed.add(l);
      }
    }
  }
  return [...changed];
}

export function idOrNull(raw) {
  return raw == null || raw === '' ? null : Number(raw);
}

// A workspace-relative path with no empty, dot, or dot-dot segments. '' is the root.
export function relPath(raw, what) {
  const s = String(raw || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!s || s === '.') return '';
  const parts = s.split('/');
  for (const p of parts) {
    if (!p || p === '.' || p === '..') throw fail('BOARD_BAD_INPUT', `${what} is a path inside the workspace`);
  }
  return parts.join('/');
}

export function childRel(parentRel, name) {
  return parentRel ? `${parentRel}/${name}` : name;
}

export function defaultFace(kind) {
  return kind === 'folder' ? 'sticky' : 'card';
}

export function defaultIcon(kind) {
  return NAMED_ICONS.includes(kind) ? kind : 'file';
}

export function parseFace(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const face = String(raw);
  if (face !== 'card' && face !== 'sticky') throw fail('BOARD_BAD_INPUT', `Unknown face: ${face}`);
  return face;
}

export function parseIcon(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const icon = String(raw);
  if (NAMED_ICONS.includes(icon)) return icon;
  if ([...icon].length === 1) return icon;
  throw fail('BOARD_BAD_INPUT', `Unknown icon: ${icon}`);
}

export function parseFields(payload, existingJson) {
  if (payload.fields === undefined && payload.fields_json === undefined) {
    return existingJson ?? '[]';
  }
  let arr;
  if (payload.fields !== undefined) arr = payload.fields;
  else if (payload.fields_json == null || payload.fields_json === '') arr = [];
  else if (typeof payload.fields_json === 'string') {
    try { arr = JSON.parse(payload.fields_json); }
    catch { throw fail('BOARD_BAD_INPUT', 'fields_json is not JSON'); }
  } else arr = payload.fields_json;
  if (!Array.isArray(arr)) throw fail('BOARD_BAD_INPUT', 'fields must be an array');
  if (arr.length > MAX_FIELDS) throw fail('BOARD_BAD_INPUT', 'A card holds at most four fields');
  return JSON.stringify(arr.map(item => {
    if (!item || typeof item !== 'object') throw fail('BOARD_BAD_INPUT', 'Each field needs a label and a value');
    return { label: String(item.label ?? ''), value: String(item.value ?? '') };
  }));
}

export function parseColor(raw) {
  if (raw == null) return null;
  const color = String(raw);
  if (!STICKY_COLORS.includes(color)) throw fail('BOARD_BAD_INPUT', `Not a sticky color: ${color}`);
  return color;
}

export function parseOrientation(raw) {
  const orientation = String(raw || '');
  if (!ORIENTATIONS.includes(orientation)) throw fail('BOARD_BAD_INPUT', `Unknown orientation: ${orientation}`);
  return orientation;
}

// An image card's displayed width in CSS pixels; null means the stylesheet's default.
export function parseWidth(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw fail('BOARD_BAD_INPUT', 'Width is a positive number of pixels');
  return Math.round(n);
}

export function viewCard(row) {
  if (!row) return row;
  return {
    ...row,
    face: row.face || null,
    icon: row.icon || defaultIcon(row.kind),
    fields_json: row.fields_json || '[]'
  };
}

// New siblings land after the last one, with a gap the client can drag into.
export function nextOrder(top) {
  return top == null ? 100 : Number(top) + 10;
}

// parentOf(laneId) returns the parent's id or null and throws for a missing lane.
export function laneDepth(laneId, parentOf) {
  let depth = 0;
  let cursor = laneId;
  while (cursor != null) { depth++; cursor = parentOf(cursor); }
  return depth;
}

// childrenOf(laneId) returns the ids of the lanes directly under it.
export function subtreeHeight(laneId, childrenOf) {
  let deepest = 0;
  for (const child of childrenOf(laneId)) deepest = Math.max(deepest, subtreeHeight(child, childrenOf));
  return 1 + deepest;
}

export function assertDepth(depth) {
  if (depth > MAX_DEPTH) throw fail('BOARD_DEPTH', `Lanes nest at most ${MAX_DEPTH} deep`);
  return depth;
}

// Walk the ancestor chain of the destination; hitting the moving lane
// (including the destination itself) would make it its own descendant.
export function assertNoCycle(laneId, toParentId, parentOf) {
  let cursor = toParentId;
  while (cursor != null) {
    if (cursor === laneId) throw fail('BOARD_CYCLE', 'Cannot move a lane under itself or its own descendant');
    cursor = parentOf(cursor);
  }
}

// A pasted or dropped image travels as a data URL. The byte count comes from
// the base64 length, so the cap is checked the same way in the browser and
// on the server, before anything decodes it.
export function imageDataUrl(ref) {
  const m = /^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/.exec(String(ref || ''));
  if (!m) throw fail('BOARD_BAD_INPUT', 'An image card needs a data URL');
  const base64 = m[2];
  const pad = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const bytes = Math.floor(base64.length * 3 / 4) - pad;
  if (bytes > MAX_IMAGE_BYTES) throw fail('BOARD_BAD_INPUT', 'Image is larger than 2 MB');
  return { mime: m[1].toLowerCase(), base64 };
}

// The file an image card becomes: the title's stem with the extension the
// bytes actually have, so a pasted JPEG is never written as .png.
export function imageFileName(title, mime) {
  const ext = IMAGE_EXT[mime] || mime.replace(/[^a-z0-9]+/g, '');
  const t = String(title || '').trim().split(/[\\/]/).pop() || '';
  const stem = t.replace(/\.[^.]*$/, '').trim();
  return `${stem === '.' || stem === '..' ? 'image' : stem || 'image'}.${ext}`;
}

// Rows already ordered by sort_order become the nested tree the view paints.
export function nestTree(surface, lanes, cards) {
  const byId = new Map(lanes.map(l => [l.lane_id, { ...l, lanes: [], cards: [] }]));
  const floor = [];
  for (const card of cards) {
    const viewed = viewCard(card);
    if (card.lane_id == null) floor.push(viewed);
    else byId.get(card.lane_id)?.cards.push(viewed);
  }
  const roots = [];
  for (const node of byId.values()) {
    if (node.parent_lane_id != null && byId.has(node.parent_lane_id)) byId.get(node.parent_lane_id).lanes.push(node);
    else roots.push(node);
  }
  return { surface, lanes: roots, cards: floor };
}
