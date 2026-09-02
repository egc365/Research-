// One data-access seam for the board plugin. Board mode forwards verbs to the
// board service. Whiteboard mode keeps the same row fields in memory and
// localStorage, keyed by workspace root. Save to project is the only crossing.
import { STICKY_COLORS } from './sticky.js';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 3;
const MAX_FIELDS = 4;
const NAMED_ICONS = ['file', 'folder', 'note', 'link', 'image'];

function storageKey(rootPath) {
  return `ro.whiteboard.${rootPath || ''}`;
}

export function emptyModel() {
  return { groups: [], cards: [], nextGroup: 1, nextCard: 1 };
}

export function serializeModel(model) {
  const src = model && typeof model === 'object' ? model : emptyModel();
  return JSON.stringify({
    v: 1,
    groups: Array.isArray(src.groups) ? src.groups : [],
    cards: Array.isArray(src.cards) ? src.cards : [],
    nextGroup: Number(src.nextGroup || src._nextGroup) || 1,
    nextCard: Number(src.nextCard || src._nextCard) || 1
  });
}

export function parseModel(raw) {
  if (raw == null || raw === '') return emptyModel();
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!data || typeof data !== 'object') throw new Error('Whiteboard model is not an object');
  if (data.v != null && data.v !== 1) throw new Error(`Unknown whiteboard model version: ${data.v}`);
  if (!Array.isArray(data.groups) || !Array.isArray(data.cards)) {
    throw new Error('Whiteboard model needs groups and cards arrays');
  }
  return {
    groups: data.groups,
    cards: data.cards,
    nextGroup: Number(data.nextGroup) || 1,
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

function viewCard(row) {
  if (!row) return row;
  return {
    ...row,
    face: row.face || defaultFace(row.kind),
    icon: row.icon || defaultIcon(row.kind),
    fields_json: row.fields_json || '[]'
  };
}

function viewGroup(row) {
  if (!row) return row;
  return {
    ...row,
    face: row.face || 'sticky',
    icon: row.icon || 'folder',
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

function nextOrder(rows, pred) {
  let top = null;
  for (const row of rows) {
    if (!pred(row)) continue;
    if (top == null || row.sort_order > top) top = row.sort_order;
  }
  return top == null ? 100 : Number(top) + 10;
}

function groupDepth(groups, groupId) {
  let depth = 0;
  let cursor = groupId;
  const byId = new Map(groups.map(g => [g.group_id, g]));
  while (cursor != null) {
    depth++;
    const row = byId.get(cursor);
    if (!row) throw fail('BOARD_NOT_FOUND', `No such group: ${cursor}`);
    cursor = row.parent_id;
  }
  return depth;
}

function subtreeHeight(groups, groupId) {
  const children = groups.filter(g => g.parent_id === groupId);
  let deepest = 0;
  for (const child of children) deepest = Math.max(deepest, subtreeHeight(groups, child.group_id));
  return 1 + deepest;
}

function mustGroup(state, groupId) {
  const row = state.groups.find(g => g.group_id === groupId);
  if (!row) throw fail('BOARD_NOT_FOUND', `No such group: ${groupId}`);
  return viewGroup(row);
}

function mustCard(state, cardId) {
  const row = state.cards.find(c => c.card_id === cardId);
  if (!row) throw fail('BOARD_NOT_FOUND', `No such card: ${cardId}`);
  return viewCard(row);
}

function treeFrom(state) {
  const groups = [...state.groups]
    .sort((a, b) => a.sort_order - b.sort_order || a.group_id - b.group_id)
    .map(g => ({ ...viewGroup(g), groups: [], cards: [] }));
  const cards = [...state.cards]
    .sort((a, b) => a.sort_order - b.sort_order || a.card_id - b.card_id);
  const byId = new Map(groups.map(g => [g.group_id, g]));
  const rootCards = [];
  for (const card of cards) {
    const viewed = viewCard(card);
    if (card.group_id == null) rootCards.push(viewed);
    else byId.get(card.group_id)?.cards.push(viewed);
  }
  const roots = [];
  for (const node of byId.values()) {
    if (node.parent_id != null && byId.has(node.parent_id)) byId.get(node.parent_id).groups.push(node);
    else roots.push(node);
  }
  return { groups: roots, cards: rootCards };
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

  if (action === 'tree') return treeFrom(state);

  if (action === 'add-card') {
    const kind = String(payload.kind || '');
    if (kind === 'folder') {
      const name = needName(payload.name);
      const parentId = payload.groupId == null || payload.groupId === '' ? null : Number(payload.groupId);
      if (parentId != null) {
        mustGroup(state, parentId);
        if (groupDepth(state.groups, parentId) >= MAX_DEPTH) {
          throw fail('BOARD_DEPTH', `Groups nest at most ${MAX_DEPTH} deep`);
        }
      }
      const sortOrder = nextOrder(state.groups, g => g.parent_id === parentId);
      const row = {
        group_id: state.nextGroup++,
        parent_id: parentId,
        title: name,
        orientation: 'vertical',
        sort_order: sortOrder,
        folder_path: null,
        color: null,
        face: 'sticky',
        icon: 'folder',
        fields_json: '[]',
        created_at: now()
      };
      state.groups.push(row);
      return viewGroup(row);
    }

    const groupId = payload.groupId == null || payload.groupId === '' ? null : Number(payload.groupId);
    if (groupId != null) mustGroup(state, groupId);
    if (!['file', 'link', 'note', 'image'].includes(kind)) throw fail('BOARD_BAD_INPUT', `Unknown card kind: ${kind}`);
    const color = payload.color == null ? null : parseColor(payload.color);
    const sortOrder = nextOrder(state.cards, c => c.group_id === groupId);
    let ref;
    let title = payload.title == null ? null : String(payload.title);
    let body;
    let width = payload.width == null ? null : Number(payload.width);
    let height = payload.height == null ? null : Number(payload.height);
    if (kind === 'file') {
      ref = needName(payload.name);
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
      group_id: groupId,
      kind,
      ref,
      title,
      color,
      face: parseFace(payload.face, defaultFace(kind)),
      icon: parseIcon(payload.icon, defaultIcon(kind)),
      fields_json: parseFields(payload, '[]'),
      sort_order: sortOrder,
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

  if (action === 'bind-group') {
    return mustGroup(state, Number(payload.groupId));
  }

  if (action === 'rename') {
    const title = needName(payload.title);
    const group = state.groups.find(g => g.group_id === Number(payload.groupId));
    if (!group) throw fail('BOARD_NOT_FOUND', `No such group: ${payload.groupId}`);
    group.title = title;
    return viewGroup(group);
  }

  if (action === 'update-card') {
    if (payload.cardId == null && payload.groupId != null) {
      const group = state.groups.find(g => g.group_id === Number(payload.groupId));
      if (!group) throw fail('BOARD_NOT_FOUND', `No such group: ${payload.groupId}`);
      if (payload.color !== undefined) group.color = payload.color == null ? null : parseColor(payload.color);
      group.face = parseFace(payload.face, group.face);
      group.icon = parseIcon(payload.icon, group.icon);
      group.fields_json = parseFields(payload, group.fields_json);
      return viewGroup(group);
    }
    const card = state.cards.find(c => c.card_id === Number(payload.cardId));
    if (!card) throw fail('BOARD_NOT_FOUND', `No such card: ${payload.cardId}`);
    if (payload.color !== undefined) card.color = payload.color == null ? null : parseColor(payload.color);
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

  if (action === 'set-orientation') {
    const orientation = String(payload.orientation || '');
    if (!['horizontal', 'vertical'].includes(orientation)) throw fail('BOARD_BAD_INPUT', `Unknown orientation: ${orientation}`);
    const group = state.groups.find(g => g.group_id === Number(payload.groupId));
    if (!group) throw fail('BOARD_NOT_FOUND', `No such group: ${payload.groupId}`);
    group.orientation = orientation;
    return viewGroup(group);
  }

  if (action === 'move') {
    const sortOrder = Number(payload.sortOrder);
    if (!Number.isFinite(sortOrder)) throw fail('BOARD_BAD_INPUT', 'Move needs a numeric sortOrder');
    if (payload.cardId != null) {
      const card = state.cards.find(c => c.card_id === Number(payload.cardId));
      if (!card) throw fail('BOARD_NOT_FOUND', `No such card: ${payload.cardId}`);
      const toGroupId = payload.toGroupId === undefined ? card.group_id
        : payload.toGroupId == null ? null : Number(payload.toGroupId);
      if (toGroupId != null) mustGroup(state, toGroupId);
      card.group_id = toGroupId;
      card.sort_order = sortOrder;
      return viewCard(card);
    }
    const group = state.groups.find(g => g.group_id === Number(payload.groupId));
    if (!group) throw fail('BOARD_NOT_FOUND', `No such group: ${payload.groupId}`);
    const toParentId = payload.toParentId == null ? null : Number(payload.toParentId);
    if (toParentId != null) {
      let cursor = toParentId;
      while (cursor != null) {
        if (cursor === group.group_id) throw fail('BOARD_CYCLE', 'Cannot move a group under itself or its own descendant');
        cursor = mustGroup(state, cursor).parent_id;
      }
      if (groupDepth(state.groups, toParentId) + subtreeHeight(state.groups, group.group_id) > MAX_DEPTH) {
        throw fail('BOARD_DEPTH', `Groups nest at most ${MAX_DEPTH} deep`);
      }
    }
    group.parent_id = toParentId;
    group.sort_order = sortOrder;
    return viewGroup(group);
  }

  if (action === 'remove') {
    if (payload.cardId != null) {
      mustCard(state, Number(payload.cardId));
      state.cards = state.cards.filter(c => c.card_id !== Number(payload.cardId));
      return { removed: 'card', cardId: Number(payload.cardId), disk: 'none' };
    }
    const groupId = Number(payload.groupId);
    mustGroup(state, groupId);
    const ids = new Set([groupId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const g of state.groups) {
        if (g.parent_id != null && ids.has(g.parent_id) && !ids.has(g.group_id)) {
          ids.add(g.group_id);
          grew = true;
        }
      }
    }
    state.groups = state.groups.filter(g => !ids.has(g.group_id));
    state.cards = state.cards.filter(c => c.group_id == null || !ids.has(c.group_id));
    return { removed: 'group', groupId, disk: 'none' };
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
            model: treeFrom(state)
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
