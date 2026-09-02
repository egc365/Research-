// One data-access seam for the board plugin. Board mode forwards verbs to the
// board service. Whiteboard mode keeps the same rows in memory and
// localStorage, keyed by workspace root. Save to project is the only crossing.
import { STICKY_COLORS } from './sticky.js';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 3;
const MAX_FIELDS = 4;
const NAMED_ICONS = ['file', 'folder', 'note', 'link', 'image'];
const ORIENTATIONS = ['horizontal', 'vertical'];

function storageKey(rootPath) {
  return `ro.whiteboard.${rootPath || ''}`;
}

export function emptyModel() {
  return { lanes: [], cards: [], nextLane: 1, nextCard: 1 };
}

export function serializeModel(model) {
  const src = model && typeof model === 'object' ? model : emptyModel();
  return JSON.stringify({
    v: 2,
    lanes: Array.isArray(src.lanes) ? src.lanes : [],
    cards: Array.isArray(src.cards) ? src.cards : [],
    nextLane: Number(src.nextLane) || 1,
    nextCard: Number(src.nextCard) || 1
  });
}

export function parseModel(raw) {
  if (raw == null || raw === '') return emptyModel();
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!data || typeof data !== 'object') throw new Error('Whiteboard model is not an object');
  if (data.v !== 2) throw new Error(`Unknown whiteboard model version: ${data.v}`);
  if (!Array.isArray(data.lanes) || !Array.isArray(data.cards)) {
    throw new Error('Whiteboard model needs lanes and cards arrays');
  }
  return {
    lanes: data.lanes,
    cards: data.cards,
    nextLane: Number(data.nextLane) || 1,
    nextCard: Number(data.nextCard) || 1
  };
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function defaultFace(kind) {
  return kind === 'folder' ? 'sticky' : 'card';
}

function defaultIcon(kind) {
  return NAMED_ICONS.includes(kind) ? kind : 'file';
}

function parseFace(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const face = String(raw);
  if (face !== 'card' && face !== 'sticky') throw fail('BOARD_BAD_INPUT', `Unknown face: ${face}`);
  return face;
}

function parseIcon(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const icon = String(raw);
  if (NAMED_ICONS.includes(icon)) return icon;
  if ([...icon].length === 1) return icon;
  throw fail('BOARD_BAD_INPUT', `Unknown icon: ${icon}`);
}

function parseFields(payload, existingJson) {
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

function parseColor(raw) {
  if (raw == null) return null;
  const color = String(raw);
  if (!STICKY_COLORS.includes(color)) throw fail('BOARD_BAD_INPUT', `Not a sticky color: ${color}`);
  return color;
}

function parseOrientation(raw) {
  const orientation = String(raw || '');
  if (!ORIENTATIONS.includes(orientation)) throw fail('BOARD_BAD_INPUT', `Unknown orientation: ${orientation}`);
  return orientation;
}

function viewCard(row) {
  if (!row) return row;
  return {
    ...row,
    face: row.face || defaultFace(row.kind),
    icon: row.icon || defaultIcon(row.kind),
    fields_json: row.fields_json || '[]'
  };
}

function needName(raw) {
  const name = String(raw || '').trim();
  if (!name) throw fail('BOARD_BAD_INPUT', 'A name is required');
  if (name === '.' || name === '..' || /[\\/]/.test(name)) {
    throw fail('BOARD_BAD_INPUT', 'A name is one path segment');
  }
  return name;
}

function needLaneName(raw) {
  const name = String(raw || '').trim();
  if (!name) throw fail('BOARD_BAD_INPUT', 'A lane needs a name');
  return name;
}

function idOrNull(raw) {
  return raw == null || raw === '' ? null : Number(raw);
}

function relPath(raw) {
  const s = String(raw || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!s || s === '.') return '';
  const parts = s.split('/');
  for (const p of parts) {
    if (!p || p === '.' || p === '..') throw fail('BOARD_BAD_INPUT', 'A surface is a path inside the workspace');
  }
  return parts.join('/');
}

function childRel(parentRel, name) {
  return parentRel ? `${parentRel}/${name}` : name;
}

function nextOrder(rows, pred) {
  let top = null;
  for (const row of rows) {
    if (!pred(row)) continue;
    if (top == null || row.sort_order > top) top = row.sort_order;
  }
  return top == null ? 100 : Number(top) + 10;
}

function mustLane(state, laneId) {
  const row = state.lanes.find(l => l.lane_id === laneId);
  if (!row) throw fail('BOARD_NOT_FOUND', `No such lane: ${laneId}`);
  return row;
}

function laneOn(state, laneId, surface) {
  const lane = mustLane(state, laneId);
  if (lane.surface !== surface) throw fail('BOARD_BAD_INPUT', `Lane ${laneId} is on surface '${lane.surface}', not '${surface}'`);
  return lane;
}

function mustCard(state, cardId) {
  const row = state.cards.find(c => c.card_id === cardId);
  if (!row) throw fail('BOARD_NOT_FOUND', `No such card: ${cardId}`);
  return row;
}

function laneDepth(state, laneId) {
  let depth = 0;
  let cursor = laneId;
  while (cursor != null) { depth++; cursor = mustLane(state, cursor).parent_lane_id; }
  return depth;
}

function subtreeHeight(state, laneId) {
  const children = state.lanes.filter(l => l.parent_lane_id === laneId);
  let deepest = 0;
  for (const child of children) deepest = Math.max(deepest, subtreeHeight(state, child.lane_id));
  return 1 + deepest;
}

function treeFrom(state, surface) {
  const lanes = state.lanes.filter(l => l.surface === surface)
    .sort((a, b) => a.sort_order - b.sort_order || a.lane_id - b.lane_id)
    .map(l => ({ ...l, lanes: [], cards: [] }));
  const cards = state.cards.filter(c => c.surface === surface)
    .sort((a, b) => a.sort_order - b.sort_order || a.card_id - b.card_id);
  const byId = new Map(lanes.map(l => [l.lane_id, l]));
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

function dataUrlBytes(ref) {
  const s = String(ref || '');
  const i = s.indexOf(',');
  if (i < 0) return 0;
  const b64 = s.slice(i + 1);
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor(b64.length * 3 / 4) - pad;
}

function readStorage(key) {
  try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
}

function writeStorage(key, value) {
  try { globalThis.localStorage?.setItem(key, value); } catch { /* unavailable */ }
}

function apply(state, action, payload) {
  const now = () => new Date().toISOString();
  const surface = relPath(payload.surface);

  if (action === 'tree') return treeFrom(state, surface);

  if (action === 'add-lane') {
    const parentLaneId = idOrNull(payload.parentLaneId);
    if (parentLaneId != null) {
      laneOn(state, parentLaneId, surface);
      if (laneDepth(state, parentLaneId) >= MAX_DEPTH) throw fail('BOARD_DEPTH', `Lanes nest at most ${MAX_DEPTH} deep`);
    }
    const row = {
      lane_id: state.nextLane++,
      surface,
      parent_lane_id: parentLaneId,
      name: needLaneName(payload.name),
      orientation: payload.orientation == null ? 'vertical' : parseOrientation(payload.orientation),
      sort_order: nextOrder(state.lanes, l => l.surface === surface && l.parent_lane_id === parentLaneId),
      created_at: now()
    };
    state.lanes.push(row);
    return row;
  }

  if (action === 'add-card') {
    const kind = String(payload.kind || '');
    const laneId = idOrNull(payload.laneId);
    if (laneId != null) laneOn(state, laneId, surface);
    if (!['file', 'folder', 'link', 'note', 'image'].includes(kind)) throw fail('BOARD_BAD_INPUT', `Unknown card kind: ${kind}`);
    const color = parseColor(payload.color);
    let ref;
    let title = payload.title == null ? null : String(payload.title);
    let body;
    const width = payload.width == null ? null : Number(payload.width);
    const height = payload.height == null ? null : Number(payload.height);
    if (kind === 'folder') {
      const name = needName(payload.name);
      ref = childRel(surface, name);
      if (title == null) title = name;
    } else if (kind === 'file') {
      ref = childRel(surface, needName(payload.name));
      body = payload.body == null ? '' : String(payload.body);
      if (title == null && body.trim()) title = body.trim().split('\n')[0];
    } else if (kind === 'image') {
      ref = String(payload.ref || '').trim();
      if (!/^data:image\//.test(ref)) throw fail('BOARD_BAD_INPUT', 'An image card needs a data URL');
      if (dataUrlBytes(ref) > MAX_IMAGE_BYTES) throw fail('BOARD_BAD_INPUT', 'Image is larger than 2 MB');
      title = title || needName(payload.name || 'image.png');
    } else {
      ref = String(payload.ref || '').trim();
      if (!ref) throw fail('BOARD_BAD_INPUT', 'A card needs a ref (path, url, or note text)');
    }
    const row = {
      card_id: state.nextCard++,
      surface,
      lane_id: laneId,
      kind,
      ref,
      title,
      color,
      face: parseFace(payload.face, defaultFace(kind)),
      icon: parseIcon(payload.icon, defaultIcon(kind)),
      fields_json: parseFields(payload, '[]'),
      sort_order: nextOrder(state.cards, c => c.surface === surface && c.lane_id === laneId),
      created_at: now()
    };
    if (kind === 'file') row.body = body;
    if (kind === 'image') {
      if (Number.isFinite(width) && width > 0) row.width = width;
      if (Number.isFinite(height) && height > 0) row.height = height;
    }
    state.cards.push(row);
    return viewCard(row);
  }

  if (action === 'rename') {
    const lane = mustLane(state, Number(payload.laneId));
    lane.name = needLaneName(payload.name);
    return lane;
  }

  if (action === 'set-orientation') {
    const lane = mustLane(state, Number(payload.laneId));
    lane.orientation = parseOrientation(payload.orientation);
    return lane;
  }

  if (action === 'update-card') {
    const card = mustCard(state, Number(payload.cardId));
    if (payload.color !== undefined) card.color = parseColor(payload.color);
    if (payload.name !== undefined && payload.name !== null) {
      const t = String(payload.name).trim();
      if (t) card.title = t;
    }
    if (payload.text !== undefined && payload.text !== null) {
      const t = String(payload.text).trim();
      if (t) {
        if (card.kind === 'note') {
          card.ref = t;
          if (payload.name === undefined) card.title = t;
        } else if (card.kind === 'link' && payload.name === undefined) {
          card.title = t;
        }
      }
    }
    if (payload.body !== undefined) card.body = String(payload.body);
    if (payload.width !== undefined) {
      const n = Number(payload.width);
      card.width = Number.isFinite(n) && n > 0 ? n : null;
    }
    if (payload.height !== undefined) {
      const n = Number(payload.height);
      card.height = Number.isFinite(n) && n > 0 ? n : null;
    }
    card.face = parseFace(payload.face, card.face);
    card.icon = parseIcon(payload.icon, card.icon);
    card.fields_json = parseFields(payload, card.fields_json);
    return viewCard(card);
  }

  if (action === 'move-card') {
    const sortOrder = Number(payload.sortOrder);
    if (!Number.isFinite(sortOrder)) throw fail('BOARD_BAD_INPUT', 'Move needs a numeric sortOrder');
    const card = mustCard(state, Number(payload.cardId));
    const toLaneId = payload.toLaneId === undefined ? card.lane_id : idOrNull(payload.toLaneId);
    if (toLaneId != null) laneOn(state, toLaneId, card.surface);
    card.lane_id = toLaneId;
    card.sort_order = sortOrder;
    return viewCard(card);
  }

  if (action === 'move-lane') {
    const sortOrder = Number(payload.sortOrder);
    if (!Number.isFinite(sortOrder)) throw fail('BOARD_BAD_INPUT', 'Move needs a numeric sortOrder');
    const lane = mustLane(state, Number(payload.laneId));
    const toParentId = idOrNull(payload.toParentLaneId);
    if (toParentId != null) {
      laneOn(state, toParentId, lane.surface);
      let cursor = toParentId;
      while (cursor != null) {
        if (cursor === lane.lane_id) throw fail('BOARD_CYCLE', 'Cannot move a lane under itself or its own descendant');
        cursor = mustLane(state, cursor).parent_lane_id;
      }
      if (laneDepth(state, toParentId) + subtreeHeight(state, lane.lane_id) > MAX_DEPTH) {
        throw fail('BOARD_DEPTH', `Lanes nest at most ${MAX_DEPTH} deep`);
      }
    }
    lane.parent_lane_id = toParentId;
    lane.sort_order = sortOrder;
    return lane;
  }

  if (action === 'remove') {
    if (payload.cardId != null) {
      mustCard(state, Number(payload.cardId));
      state.cards = state.cards.filter(c => c.card_id !== Number(payload.cardId));
      return { removed: 'card', cardId: Number(payload.cardId), disk: 'none' };
    }
    const laneId = Number(payload.laneId);
    const lane = mustLane(state, laneId);
    const ids = new Set([laneId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const l of state.lanes) {
        if (l.parent_lane_id != null && ids.has(l.parent_lane_id) && !ids.has(l.lane_id)) {
          ids.add(l.lane_id);
          grew = true;
        }
      }
    }
    for (const card of [...state.cards].sort((a, b) => a.sort_order - b.sort_order || a.card_id - b.card_id)) {
      if (card.lane_id == null || !ids.has(card.lane_id)) continue;
      card.sort_order = nextOrder(state.cards, c => c.surface === lane.surface && c.lane_id == null);
      card.lane_id = null;
    }
    state.lanes = state.lanes.filter(l => !ids.has(l.lane_id));
    return { removed: 'lane', laneId, disk: 'none', cards: 'floor' };
  }

  throw new Error(`Unknown board action: ${action}`);
}

function memoryStore(ctx) {
  let root = null;
  let state = emptyModel();

  function load() {
    const next = ctx.workspace?.root_path || '';
    if (next === root) return;
    root = next;
    try { state = parseModel(readStorage(storageKey(root))); }
    catch { state = emptyModel(); }
  }

  function persist() {
    writeStorage(storageKey(root), serializeModel(state));
  }

  return {
    mode: 'whiteboard',
    call(action, payload = {}) {
      load();
      if (action === 'save-to-project') {
        return Promise.resolve()
          .then(() => ctx.action('board', 'save-to-project', {
            rootPath: root,
            destination: payload.destination,
            name: payload.name,
            model: { lanes: state.lanes, cards: state.cards }
          }))
          .then(result => {
            state = emptyModel();
            persist();
            return result;
          });
      }
      try {
        const result = apply(state, action, payload);
        persist();
        return Promise.resolve(result);
      } catch (error) {
        return Promise.reject(error);
      }
    }
  };
}

function serviceStore(ctx) {
  return {
    mode: 'board',
    call(action, payload = {}) {
      return ctx.action('board', action, { rootPath: ctx.workspace?.root_path, ...payload });
    }
  };
}

export function boardStore(ctx, config) {
  if (config?.mode === 'whiteboard') return memoryStore(ctx);
  return serviceStore(ctx);
}
