// One data-access seam for the board plugin. Board mode forwards verbs to the
// board service. Whiteboard mode keeps the same rows in memory and
// localStorage, keyed by workspace root. Save to project is the only crossing.
import {
  fail, needName, needLaneName, refuseDuplicateLane, idOrNull, relPath, childRel,
  parseColor, parseOrientation, parseFace, parseIcon, parseFields, parseWidth, defaultIcon, viewCard,
  nextOrder, laneDepth, subtreeHeight, assertDepth, assertNoCycle, imageDataUrl, imageFileName, nestTree
} from './board-rules.js';

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

function topOrder(rows, pred) {
  let top = null;
  for (const row of rows) {
    if (!pred(row)) continue;
    if (top == null || row.sort_order > top) top = row.sort_order;
  }
  return top;
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

const parentOf = state => id => mustLane(state, id).parent_lane_id;
const childrenOf = state => id => state.lanes.filter(l => l.parent_lane_id === id).map(l => l.lane_id);

function treeFrom(state, surface) {
  return nestTree(
    surface,
    state.lanes.filter(l => l.surface === surface).sort((a, b) => a.sort_order - b.sort_order || a.lane_id - b.lane_id),
    state.cards.filter(c => c.surface === surface).sort((a, b) => a.sort_order - b.sort_order || a.card_id - b.card_id)
  );
}

function readStorage(key) {
  try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
}

function writeStorage(key, value) {
  try { globalThis.localStorage?.setItem(key, value); } catch { /* unavailable */ }
}

function apply(state, action, payload) {
  const now = () => new Date().toISOString();
  const surface = relPath(payload.surface, 'A surface');

  if (action === 'tree') return treeFrom(state, surface);

  if (action === 'add-lane') {
    const parentLaneId = idOrNull(payload.parentLaneId);
    if (parentLaneId != null) {
      laneOn(state, parentLaneId, surface);
      assertDepth(laneDepth(parentLaneId, parentOf(state)) + 1);
    }
    const siblings = state.lanes.filter(l => l.surface === surface && l.parent_lane_id === parentLaneId);
    const row = {
      lane_id: state.nextLane++,
      surface,
      parent_lane_id: parentLaneId,
      name: refuseDuplicateLane(needLaneName(payload.name), siblings),
      orientation: payload.orientation == null ? 'vertical' : parseOrientation(payload.orientation),
      sort_order: nextOrder(topOrder(state.lanes, l => l.surface === surface && l.parent_lane_id === parentLaneId)),
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
    if (kind === 'folder') {
      const name = needName(payload.name);
      ref = childRel(surface, name);
      if (title == null) title = name;
    } else if (kind === 'file') {
      ref = childRel(surface, needName(payload.name));
      // The same refusal the server gives a re-dropped file, so Save never
      // has to rename a second copy.
      const carded = state.cards.find(c => c.surface === surface && c.kind === 'file' && c.ref === ref);
      if (carded) {
        const where = carded.lane_id == null ? 'on the floor' : `in lane ${mustLane(state, carded.lane_id).name}`;
        throw fail('BOARD_DUPLICATE', `${ref} is already on this surface, ${where}`);
      }
      body = payload.body == null ? '' : String(payload.body);
      if (title == null && body.trim()) title = body.trim().split('\n')[0];
    } else if (kind === 'image') {
      ref = String(payload.ref || '').trim();
      title = imageFileName(title, imageDataUrl(ref).mime);
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
      face: parseFace(payload.face, null),
      icon: parseIcon(payload.icon, defaultIcon(kind)),
      fields_json: parseFields(payload, '[]'),
      width: null,
      sort_order: nextOrder(topOrder(state.cards, c => c.surface === surface && c.lane_id === laneId)),
      created_at: now()
    };
    if (kind === 'file') row.body = body;
    state.cards.push(row);
    return viewCard(row);
  }

  if (action === 'rename') {
    const lane = mustLane(state, Number(payload.laneId));
    const siblings = state.lanes.filter(l => l !== lane && l.surface === lane.surface && l.parent_lane_id === lane.parent_lane_id);
    lane.name = refuseDuplicateLane(needLaneName(payload.name), siblings);
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
    // The sticky face's text. A note is its text, a link shows it as the
    // title, and a file card keeps it on the row (ADR-023: the whiteboard
    // never calls the stickies service); an emptied text clears it.
    if (payload.text !== undefined && payload.text !== null) {
      const t = String(payload.text).trim();
      if (card.kind === 'file') card.text = t;
      else if (t) {
        if (card.kind === 'note') {
          card.ref = t;
          if (payload.name === undefined) card.title = t;
        } else if (card.kind === 'link' && payload.name === undefined) {
          card.title = t;
        }
      }
    }
    if (payload.body !== undefined) card.body = String(payload.body);
    if (payload.width !== undefined) card.width = parseWidth(payload.width);
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
      assertNoCycle(lane.lane_id, toParentId, parentOf(state));
      assertDepth(laneDepth(toParentId, parentOf(state)) + subtreeHeight(lane.lane_id, childrenOf(state)));
    }
    refuseDuplicateLane(lane.name, state.lanes.filter(l => l !== lane && l.surface === lane.surface && l.parent_lane_id === toParentId));
    lane.parent_lane_id = toParentId;
    lane.sort_order = sortOrder;
    return lane;
  }

  if (action === 'remove') {
    if (payload.cardId != null) {
      mustCard(state, Number(payload.cardId));
      state.cards = state.cards.filter(c => c.card_id !== Number(payload.cardId));
      return { removed: 'card', cardId: Number(payload.cardId) };
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
      card.sort_order = nextOrder(topOrder(state.cards, c => c.surface === lane.surface && c.lane_id == null));
      card.lane_id = null;
    }
    state.lanes = state.lanes.filter(l => !ids.has(l.lane_id));
    return { removed: 'lane', laneId, cards: 'floor' };
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
            parent: payload.parent,
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
