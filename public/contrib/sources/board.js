// Card source: the planning board. A surface is the workspace folder the
// board shows (the root or any folder). Lanes on a surface arrange cards:
// vertical is serial order, horizontal is parallel work, lanes nest three
// deep and write nothing to disk. A file card is a real file and a folder
// card is a real folder, both directly under the surface's folder; opening
// a folder card drills into its surface. Cards drag between lanes and to
// the floor; the sidebar tree's file rows drop in as file cards. Every
// mutation goes through the board store and the view repaints from 'tree'.
// config.mode 'whiteboard' keeps the same rows in memory until Save to project.
import { styleSticky, paletteEl, stickyKey, isolateStickyPointer, colorForLabel, DEFAULT_STICKY_COLOR } from '../lib/sticky.js';
import { boardStore } from '../lib/board-store.js';
import { MAX_DEPTH } from '../lib/board-rules.js';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
const CARD_MIME = 'x-ro-card';

export function open(ctx, config, view) {
  let surface = '';
  let data = { surface: '', lanes: [], cards: [] };
  let stickies = { notes: {} };
  let labels = {};
  let listed = null; // relative paths directly under the surface, null on the whiteboard
  let adding = null; // { laneId: number|null } null laneId is the floor
  let addKind = 'file';
  let addRef = '';
  let addBody = '';
  let addColor = null;
  let namingLane = null; // { parentLaneId: number|null }
  let renamingLaneId = null;
  let dragCardId = null;
  let dragLaneId = null;

  const root = () => ctx.workspace?.root_path;
  const access = boardStore(ctx, config);
  const isWhiteboard = access.mode === 'whiteboard';
  const call = (action, payload = {}) => access.call(action, { surface, ...payload });
  const mutate = (action, payload) => view.run(call(action, payload));
  const { btn, div } = view;

  function stopEditing() {
    adding = null;
    namingLane = null;
    renamingLaneId = null;
  }
  const editing = () => adding != null || renamingLaneId != null || namingLane != null;

  function emitPath() {
    ctx.bus.emit('board-path', { path: surface.split('/').filter(Boolean) });
  }
  ctx.bus.on('board-path', msg => {
    if (!msg || msg.source !== 'history') return;
    surface = (msg.path || []).map(String).join('/');
    view.repaint();
  });

  function openSurface(next) {
    surface = next;
    stopEditing();
    view.stopEditing();
    emitPath();
    view.repaint();
  }

  // ---- card records ----------------------------------------------------------
  const isPathKind = row => row.kind === 'file' || row.kind === 'folder';

  function pathAbs(row) {
    if (!isPathKind(row)) return null;
    const r = root();
    const key = String(row.ref || '');
    if (!key) return null;
    return r && !key.startsWith('/') ? `${r}/${key}` : key;
  }

  function isImage(row) {
    if (row.kind === 'image') return true;
    return row.kind === 'file' && IMAGE_EXT.test(String(row.ref || '').split('/').pop() || '');
  }

  function imageSrc(row) {
    if (row.kind === 'image' || String(row.ref || '').startsWith('data:')) return row.ref;
    const abs = pathAbs(row);
    return abs ? `/api/file?root=${encodeURIComponent(root())}&path=${encodeURIComponent(abs)}&raw=1` : '';
  }

  function title(row) {
    if (row.kind === 'image') return row.title || 'image';
    if (row.kind === 'folder' && row.title) return row.title;
    if (isPathKind(row)) {
      const ref = String(row.ref || '');
      return ref.split('/').filter(Boolean).pop() || ref;
    }
    if (row.kind === 'link') {
      try { return new URL(row.ref).host || row.ref; } catch { return row.ref; }
    }
    return String(row.ref || '').split('\n')[0] || '';
  }

  function head(row) {
    if (row.kind === 'image') return row.title || 'image';
    if (isPathKind(row)) return row.ref || '';
    if (row.kind === 'link') return title(row);
    return 'note';
  }

  function stickyText(row) {
    if (row.kind === 'image') return row.title || '';
    if (row.kind === 'folder') return title(row);
    if (row.kind === 'file') {
      if (isWhiteboard) return row.text || '';
      return stickies.notes?.[stickyKey(root(), row.ref)]?.text || '';
    }
    if (row.kind === 'link') return row.title || '';
    return row.ref || '';
  }

  function body(row) {
    if (row.kind === 'note') {
      const text = row.ref || '';
      const i = text.indexOf('\n');
      return i === -1 ? '' : text.slice(i + 1);
    }
    if (row.kind === 'link') return row.title || '';
    if (row.kind === 'image') return '';
    if (row.kind === 'file') return isWhiteboard ? String(row.body ?? '') : null;
    return stickyText(row);
  }

  function fields(row) {
    try {
      const arr = JSON.parse(row.fields_json || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function toCard(row) {
    const path = pathAbs(row);
    return {
      id: row.card_id,
      kind: row.kind,
      ref: isPathKind(row) ? (stickyKey(root(), row.ref) || row.ref) : row.ref,
      path,
      head: head(row),
      title: title(row),
      body: body(row),
      text: stickyText(row),
      color: row.color || null,
      face: row.face,
      icon: row.icon || row.kind,
      fields: fields(row),
      tags: path && !isWhiteboard ? labels[path] || labels[row.ref] || [] : [],
      image: isImage(row) ? imageSrc(row) : null,
      width: row.width || null,
      missing: isPathKind(row) && (!row.ref || gone(row.ref)),
      badges: [],
      foot: []
    };
  }

  // A card directly under the surface is missing when the surface listing
  // lacks it; a deeper ref (a tree drop is a prefix match) is not judged.
  function gone(ref) {
    if (!listed) return false;
    const parent = ref.split('/').slice(0, -1).join('/');
    return parent === surface && !listed.has(ref);
  }

  function allRows(lanes = data.lanes, out = [...(data.cards || [])]) {
    for (const lane of lanes) { out.push(...lane.cards); allRows(lane.lanes, out); }
    return out;
  }

  const hasReadme = () => allRows().some(c => c.kind === 'file' && String(c.ref || '').split('/').pop() === 'README.md');

  // ---- verbs -------------------------------------------------------------------
  function select(card) {
    if (card.kind === 'file' && !isWhiteboard) return ctx.selectFile(card.ref);
  }

  function openCard(card) {
    if (card.kind === 'folder') { openSurface(card.ref); return; }
    if (card.kind === 'file' && !isWhiteboard) {
      return ctx.selectFile(card.ref).then(() => ctx.activateStation('revision-center'));
    }
  }

  // The sticky editor saved: a folder renames, a file writes its sticky note
  // (or its memory row on the whiteboard, ADR-023), a note or link updates.
  function text(card, value, colorPick) {
    const patch = { cardId: card.id };
    if (colorPick !== undefined) patch.color = colorPick;
    if (card.kind === 'folder') {
      const v = String(value || '').trim();
      if (v && v !== card.title) patch.name = v;
      if (patch.color === undefined && patch.name === undefined) return;
      return call('update-card', patch);
    }
    if (card.kind === 'file') {
      if (isWhiteboard) { patch.text = value; return call('update-card', patch); }
      const writes = [];
      if (colorPick !== undefined) writes.push(call('update-card', patch));
      const key = stickyKey(root(), card.ref);
      if (key && !key.startsWith('/')) {
        const picked = colorPick !== undefined ? colorPick : card.color;
        writes.push(ctx.action('stickies', 'set', { rootPath: root(), path: key, text: value, color: picked || colorForLabel(card.tags[0]?.label) }));
      }
      return Promise.all(writes);
    }
    const v = value.trim();
    if (v) {
      if (card.kind === 'note') patch.text = v;
      else patch.name = v;
    }
    if (patch.color === undefined && patch.text === undefined && patch.name === undefined) return;
    return call('update-card', patch);
  }

  const color = (card, value) => call('update-card', { cardId: card.id, color: value });
  const patch = (card, changes) => call('update-card', { cardId: card.id, ...changes });

  // Titles name where the thing lives: the whiteboard has no disk to mention.
  function removeTitle(what) {
    if (isWhiteboard) return `Remove the ${what} from the whiteboard.`;
    if (what === 'lane') return 'Remove the lane and its cards from the board. Files and folders stay on disk.';
    if (what === 'card') return 'Remove card';
    return `Remove from the board. The ${what} stays on disk.`;
  }
  const remove = {
    title: card => removeTitle(isPathKind(card) ? card.kind : 'card'),
    armedLabel: isWhiteboard ? 'remove?' : 'board only?',
    armedTitle: isWhiteboard ? 'Remove from the whiteboard.' : 'Remove from the board. Files and folders stay on disk.',
    run: card => call('remove', { cardId: card.id })
  };
  const laneRemoveBtn = lane => view.removeBtn(`lane:${lane.lane_id}`, {
    title: removeTitle('lane'),
    armedLabel: remove.armedLabel,
    armedTitle: remove.armedTitle,
    act: () => call('remove', { laneId: lane.lane_id })
  });

  // ---- drag and drop -------------------------------------------------------
  // `holder` is the lane whose cards are the siblings, or null for the floor.
  const holderCards = holder => holder ? holder.cards : (data.cards || []);
  const holderId = holder => holder ? holder.lane_id : null;

  function orderAfterDrop(holder, beforeCard) {
    const rest = holderCards(holder).filter(c => c.card_id !== dragCardId);
    const at = beforeCard ? rest.findIndex(c => c.card_id === beforeCard.id) : rest.length;
    const prev = at > 0 ? rest[at - 1].sort_order : null;
    const next = at < rest.length ? rest[at].sort_order : null;
    if (prev == null && next == null) return { sortOrder: 100 };
    if (prev == null) return { sortOrder: next - 10 };
    if (next == null) return { sortOrder: prev + 10 };
    const mid = Math.floor((prev + next) / 2);
    if (mid > prev && mid < next) return { sortOrder: mid };
    return { renumber: rest, at };
  }

  async function dropCard(holder, beforeCard) {
    if (dragCardId == null) return;
    if (beforeCard && beforeCard.id === dragCardId) { dragCardId = null; return; }
    const plan = orderAfterDrop(holder, beforeCard);
    const toLaneId = holderId(holder);
    try {
      if (plan.renumber) {
        const seq = [...plan.renumber];
        seq.splice(plan.at, 0, { card_id: dragCardId });
        for (let i = 0; i < seq.length; i++) {
          await call('move-card', { cardId: seq[i].card_id, toLaneId, sortOrder: (i + 1) * 10 });
        }
      } else {
        await call('move-card', { cardId: dragCardId, toLaneId, sortOrder: plan.sortOrder });
      }
    } catch (error) { ctx.notify(error.message, 'error'); }
    dragCardId = null;
    view.repaint();
  }

  // A lane drags as a whole; dropping it in another lane nests it there,
  // dropping it on the floor makes it top-level. The store refuses cycles
  // and the 3-deep cap, and a refusal surfaces as a notify.
  async function dropLane(targetLane) {
    if (dragLaneId == null) return;
    if (targetLane && targetLane.lane_id === dragLaneId) { dragLaneId = null; return; }
    const siblings = targetLane ? targetLane.lanes : data.lanes;
    const top = siblings.reduce((max, l) => Math.max(max, l.sort_order), 0);
    const moved = dragLaneId;
    dragLaneId = null;
    await mutate('move-lane', { laneId: moved, toParentLaneId: targetLane ? targetLane.lane_id : null, sortOrder: top + 10 });
  }

  function cardPayload(e) {
    const raw = e.dataTransfer?.getData(CARD_MIME);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  async function dropTreeFile(payload, holder) {
    const r = root();
    if (!payload?.path || !r) return;
    if (isWhiteboard) { ctx.notify('The whiteboard writes nothing to disk; save it as a board before dropping files in', 'error'); return; }
    const rel = payload.path.startsWith(`${r}/`) ? payload.path.slice(r.length + 1) : payload.path;
    await mutate('add-card', { kind: 'file', laneId: holderId(holder), ref: rel });
  }

  // Every drop lands here: a card, a lane, a tree file, or (whiteboard) an image file.
  function handleDrop(e, holder, beforeCard) {
    e.preventDefault();
    e.stopPropagation();
    if (isWhiteboard && e.dataTransfer.files?.length) { ingestFiles(e.dataTransfer.files, holderId(holder)); return; }
    if (dragLaneId != null) { dropLane(holder); return; }
    if (dragCardId != null) { dropCard(holder, beforeCard); return; }
    const payload = cardPayload(e);
    if (payload) dropTreeFile(payload, holder);
  }

  function dragOver(e) {
    const types = [...(e.dataTransfer?.types || [])];
    if (dragCardId != null || dragLaneId != null || types.includes(CARD_MIME)) e.preventDefault();
    if (isWhiteboard && types.includes('Files')) e.preventDefault();
  }
  const acceptDrag = node => node.addEventListener('dragover', dragOver);

  const drag = {
    start(card, e) {
      dragCardId = card.id;
      e.dataTransfer.setData(CARD_MIME, JSON.stringify({ card_id: card.id }));
      e.dataTransfer.effectAllowed = 'move';
    },
    end() { dragCardId = null; dragLaneId = null; },
    over: dragOver,
    drop(card, e, holder) {
      if (card.kind === 'folder' && (dragCardId != null || cardPayload(e))) {
        e.preventDefault(); e.stopPropagation();
        dragCardId = null;
        ctx.notify(`Folders are opened, not dropped into. Open ${card.title} to arrange inside it.`, 'error');
        return;
      }
      handleDrop(e, holder, card);
    }
  };

  // Each image becomes a card titled with its own file name; the store keeps
  // the bytes in their source format and refuses anything over the cap.
  function ingestFiles(fileList, laneId) {
    const files = [...fileList].filter(f => f && /^image\//.test(f.type));
    if (!files.length) return;
    const jobs = files.map(file => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ file, dataUrl: reader.result });
      reader.onerror = () => reject(new Error('Could not read image'));
      reader.readAsDataURL(file);
    }));
    Promise.all(jobs).then(async items => {
      for (const item of items) {
        try { await call('add-card', { kind: 'image', laneId, ref: item.dataUrl, title: item.file.name }); }
        catch (error) { ctx.notify(error.message, 'error'); }
      }
      view.repaint();
    }).catch(error => ctx.notify(error.message, 'error'));
  }

  // ---- adding ------------------------------------------------------------------
  function openAdd(lane, kind) {
    stopEditing();
    view.stopEditing();
    adding = { laneId: lane ? lane.lane_id : null };
    addKind = kind || 'file';
    addBody = '';
    addColor = null;
    addRef = addKind === 'file' && !hasReadme() ? 'README.md' : '';
    view.paint();
  }

  function openNameLane(parentLane) {
    stopEditing();
    view.stopEditing();
    namingLane = { parentLaneId: parentLane ? parentLane.lane_id : null };
    view.paint();
  }

  async function submitAdd(lane) {
    const kind = addKind;
    const body = addBody;
    const color = addColor;
    const raw = addRef.trim();
    const laneId = lane ? lane.lane_id : null;
    try {
      if (kind === 'folder') {
        if (!raw) { ctx.notify('A folder needs a name', 'error'); return; }
        await call('add-card', { kind: 'folder', laneId, name: raw, color });
      } else if (kind === 'file') {
        if (!raw) { ctx.notify('A file needs a name', 'error'); return; }
        await call('add-card', { kind: 'file', laneId, name: raw, body, color });
      } else if (kind === 'note') {
        const ref = body.trim();
        if (!ref) { ctx.notify('A note needs some text', 'error'); return; }
        await call('add-card', { laneId, kind, ref, title: ref.split('\n')[0], color });
      } else {
        if (!raw) { ctx.notify('A link card needs a URL', 'error'); return; }
        await call('add-card', { laneId, kind, ref: raw, title: body.trim() || null, color });
      }
    } catch (error) {
      ctx.notify(error.message, 'error');
      return;
    }
    adding = null;
    addKind = 'file';
    addRef = '';
    addBody = '';
    addColor = null;
    view.repaint();
  }

  function addFormEl(lane) {
    const form = document.createElement('form');
    form.className = 'board-add-card';
    styleSticky(form, addColor || DEFAULT_STICKY_COLOR);
    isolateStickyPointer(form);
    form.addEventListener('submit', e => { e.preventDefault(); submitAdd(lane); });
    form.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); adding = null; view.paint(); }
      if (e.key === 'Enter' && !e.shiftKey && e.target.tagName === 'TEXTAREA') {
        e.preventDefault();
        form.requestSubmit();
      }
    });

    const kinds = div('display:flex;gap:4px;margin-bottom:4px');
    for (const kind of ['file', 'folder', 'link', 'note']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = kind;
      b.dataset.kind = kind;
      b.setAttribute('aria-pressed', addKind === kind ? 'true' : 'false');
      b.onclick = () => {
        addKind = kind;
        if (kind === 'file' && !addRef) addRef = hasReadme() ? '' : 'README.md';
        if (kind === 'folder') addRef = addRef === 'README.md' ? '' : addRef;
        view.paint();
      };
      kinds.appendChild(b);
    }
    form.appendChild(kinds);

    if (addKind !== 'note') {
      const lab = document.createElement('label');
      lab.append(addKind === 'link' ? 'URL' : 'Name');
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'board-inline-name';
      input.value = addRef;
      input.placeholder = addKind === 'file' ? 'README.md' : addKind === 'folder' ? 'folder' : 'https://';
      input.oninput = () => { addRef = input.value; };
      lab.appendChild(input);
      form.appendChild(lab);
    }

    if (addKind !== 'folder') {
      const bodyLab = document.createElement('label');
      bodyLab.append(addKind === 'file' ? 'First line' : 'Body');
      const area = document.createElement('textarea');
      area.rows = addKind === 'file' ? 1 : 3;
      area.value = addBody;
      area.oninput = () => { addBody = area.value; };
      bodyLab.appendChild(area);
      form.appendChild(bodyLab);
    }

    form.appendChild(paletteEl(addColor, picked => { addColor = picked; view.paint(); }));

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = addKind === 'folder' ? 'Create folder' : addKind === 'file' ? 'Create file' : 'Stick it';
    form.appendChild(submit);
    const into = lane ? `lane ${lane.name}` : 'the floor';
    form.appendChild(div('font-size:11px;opacity:.7;margin-top:4px', `Written under ${surface || 'the workspace root'}, placed in ${into}`));
    return form;
  }

  // ---- lanes -------------------------------------------------------------------
  function laneNameFormEl(parentLane) {
    const form = document.createElement('form');
    form.className = 'board-lane-new';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'board-lane-name';
    input.placeholder = 'lane name';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = 'Add lane';
    form.append(input, submit);
    form.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); namingLane = null; view.paint(); } });
    form.addEventListener('submit', e => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) { ctx.notify('A lane needs a name', 'error'); return; }
      namingLane = null;
      mutate('add-lane', { parentLaneId: parentLane ? parentLane.lane_id : null, name });
    });
    return form;
  }

  function laneHeaderEl(lane, depth) {
    const h = document.createElement('header');
    h.className = 'board-lane-head';
    if (renamingLaneId === lane.lane_id) {
      const input = document.createElement('input');
      input.className = 'board-lane-title-edit';
      input.value = lane.name;
      input.style.cssText = 'flex:1;background:rgba(255,255,255,.55);color:#222;border:1px solid rgba(0,0,0,.3);border-radius:4px;padding:2px 6px;font:inherit';
      isolateStickyPointer(input);
      const save = () => {
        const v = input.value.trim();
        renamingLaneId = null;
        if (v && v !== lane.name) mutate('rename', { laneId: lane.lane_id, name: v });
        else view.paint();
      };
      input.onkeydown = e => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
        if (e.key === 'Escape') { e.preventDefault(); renamingLaneId = null; view.paint(); }
      };
      input.onblur = () => { if (renamingLaneId === lane.lane_id && input.isConnected) save(); };
      h.appendChild(input);
    } else {
      const name = div('font-weight:600;flex:1', lane.name);
      name.className = 'board-lane-title';
      name.title = 'Drag to move the lane';
      h.appendChild(name);
    }
    h.appendChild(btn('✎', 'Rename lane', e => {
      e.stopPropagation();
      stopEditing();
      view.stopEditing();
      renamingLaneId = lane.lane_id;
      view.paint();
    }));
    h.appendChild(btn('＋', 'Add a file, folder, link, or note to this lane', () => openAdd(lane)));
    if (depth < MAX_DEPTH) h.appendChild(btn('＋ lane', 'Add a lane inside this lane', () => openNameLane(lane)));
    h.appendChild(btn(`⇄ ${lane.orientation}`, `Orientation: ${lane.orientation} (toggle)`, e => {
      e.stopPropagation();
      mutate('set-orientation', { laneId: lane.lane_id, orientation: lane.orientation === 'vertical' ? 'horizontal' : 'vertical' });
    }));
    h.appendChild(laneRemoveBtn(lane));
    return h;
  }

  function laneEl(lane, depth, cardEl, editorOpen) {
    const tile = document.createElement('section');
    tile.className = 'board-lane';
    tile.dataset.laneId = String(lane.lane_id);
    tile.dataset.name = lane.name;
    tile.dataset.orientation = lane.orientation;
    tile.dataset.depth = String(depth);
    tile.draggable = !editorOpen;
    tile.addEventListener('dragstart', e => {
      e.stopPropagation();
      if (editing() || view.editing()) { e.preventDefault(); return; }
      dragLaneId = lane.lane_id;
      e.dataTransfer.effectAllowed = 'move';
    });
    tile.addEventListener('dragend', () => { dragCardId = null; dragLaneId = null; });
    tile.appendChild(laneHeaderEl(lane, depth));
    const horizontal = lane.orientation === 'horizontal';
    const body = div(`display:flex;flex-direction:${horizontal ? 'row' : 'column'};align-items:${horizontal ? 'flex-start' : 'stretch'};flex-wrap:${horizontal ? 'wrap' : 'nowrap'};padding:4px;min-height:40px`);
    body.className = 'cards';
    for (const sub of lane.lanes) body.appendChild(laneEl(sub, depth + 1, cardEl, editorOpen));
    if (namingLane && namingLane.parentLaneId === lane.lane_id) body.appendChild(laneNameFormEl(lane));
    for (const row of lane.cards) body.appendChild(cardEl(toCard(row), lane));
    if (adding && adding.laneId === lane.lane_id) body.appendChild(addFormEl(lane));
    if (!lane.lanes.length && !lane.cards.length && !(adding && adding.laneId === lane.lane_id) && !(namingLane && namingLane.parentLaneId === lane.lane_id)) {
      body.appendChild(div('opacity:.5;font-size:12px;padding:6px', 'empty, drop cards here'));
    }
    acceptDrag(body);
    body.addEventListener('drop', e => handleDrop(e, lane, null));
    tile.appendChild(body);
    return tile;
  }

  function surfaceBarEl() {
    const bar = div('display:flex;align-items:center;gap:6px;padding:4px 2px;font-size:13px;flex-wrap:wrap');
    bar.className = 'board-surface-bar';
    const home = document.createElement('a');
    home.href = '#'; home.textContent = isWhiteboard ? 'Whiteboard' : 'Board';
    home.onclick = e => { e.preventDefault(); openSurface(''); };
    bar.appendChild(home);
    const parts = surface.split('/').filter(Boolean);
    parts.forEach((part, i) => {
      bar.appendChild(div('opacity:.5', '›'));
      const a = document.createElement('a');
      a.href = '#'; a.textContent = part;
      a.onclick = e => { e.preventDefault(); openSurface(parts.slice(0, i + 1).join('/')); };
      bar.appendChild(a);
    });
    bar.appendChild(div('flex:1'));
    bar.appendChild(btn('＋ lane', 'Add a lane on this surface', () => openNameLane(null)));
    bar.appendChild(btn('＋ file', `Create a file under ${surface || 'the workspace root'}`, () => openAdd(null, 'file')));
    bar.appendChild(btn('＋ folder', `Create a folder under ${surface || 'the workspace root'}`, () => openAdd(null, 'folder')));
    if (isWhiteboard) {
      const save = btn('Save to project', 'Create a project folder holding this sketch as files, then open it as a Board', () => openSaveDialog());
      save.className = 'primary';
      bar.appendChild(save);
    }
    return bar;
  }

  let host = null;

  function openSaveDialog() {
    host.querySelector('.board-save-dialog')?.remove();
    const dlg = document.createElement('dialog');
    dlg.className = 'board-save-dialog';
    const dlgHead = document.createElement('div');
    dlgHead.className = 'pm-head';
    const dlgTitle = document.createElement('strong');
    dlgTitle.textContent = 'Save to project';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    close.onclick = () => dlg.close();
    dlgHead.append(dlgTitle, close);
    const dlgBody = document.createElement('div');
    dlgBody.className = 'pm-body';
    const destLab = document.createElement('label');
    destLab.textContent = 'Parent folder';
    const destInput = document.createElement('input');
    destInput.type = 'text';
    destInput.placeholder = 'projects';
    destInput.value = 'projects';
    destLab.appendChild(destInput);
    const treeHost = document.createElement('div');
    treeHost.className = 'board-save-tree';
    const nameLab = document.createElement('label');
    nameLab.textContent = 'Project name';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Q3 plan';
    nameLab.appendChild(nameInput);
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'primary';
    go.textContent = 'Save to project';
    const status = document.createElement('div');
    status.className = 'muted';
    const hint = document.createElement('div');
    hint.className = 'muted';
    const showHint = () => { hint.textContent = `Creates ${[destInput.value.trim(), nameInput.value.trim() || 'the project name'].filter(Boolean).join('/')} and opens the Board there.`; };
    destInput.oninput = showHint;
    nameInput.oninput = showHint;
    showHint();
    dlgBody.append(destLab, treeHost, nameLab, hint, go, status);
    dlg.append(dlgHead, dlgBody);
    host.appendChild(dlg);
    dlg.showModal();

    function pick(rel) {
      destInput.value = rel === '.' ? '' : rel;
      showHint();
    }

    async function fillTree(relativePath, container, depth) {
      let entries;
      try {
        entries = await ctx.request(`/api/tree?root=${encodeURIComponent(root())}&path=${encodeURIComponent(relativePath)}`);
      } catch (error) {
        container.textContent = error.message;
        return;
      }
      for (const entry of entries) {
        if (entry.type !== 'directory') continue;
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'board-save-folder';
        row.style.marginLeft = `${depth * 12}px`;
        row.textContent = entry.name;
        row.onclick = () => {
          pick(entry.relativePath);
          if (row.dataset.open === '1') {
            row.dataset.open = '';
            while (row.nextSibling && row.nextSibling.dataset?.parent === entry.relativePath) row.nextSibling.remove();
            return;
          }
          row.dataset.open = '1';
          const nest = document.createElement('div');
          nest.dataset.parent = entry.relativePath;
          row.after(nest);
          fillTree(entry.relativePath, nest, depth + 1);
        };
        container.appendChild(row);
      }
    }

    const rootPick = document.createElement('button');
    rootPick.type = 'button';
    rootPick.className = 'board-save-folder';
    rootPick.textContent = 'workspace root';
    rootPick.onclick = () => pick('.');
    treeHost.appendChild(rootPick);
    fillTree('.', treeHost, 1);

    go.onclick = async () => {
      const parent = destInput.value.trim();
      const name = nameInput.value.trim();
      if (!name) { status.textContent = 'A project name is required.'; return; }
      go.disabled = true;
      try {
        const saved = await call('save-to-project', { parent: parent === '.' ? '' : parent, name });
        dlg.close();
        ctx.notify(`Saved ${saved.destination}.`, 'ok');
        ctx.activateStation('dashboard-viewer', { path: saved.destination.split('/').filter(Boolean) });
      } catch (error) {
        status.textContent = error.message;
        go.disabled = false;
      }
    };
  }

  // ---- paint and load ---------------------------------------------------------
  function paint(el, cardEl) {
    host = el;
    const editorOpen = editing() || view.editing();
    el.appendChild(surfaceBarEl());
    if (namingLane && namingLane.parentLaneId == null) el.appendChild(laneNameFormEl(null));
    const lanes = div('display:flex;flex-direction:row;flex-wrap:wrap;align-items:flex-start');
    lanes.className = 'board-lanes';
    for (const lane of data.lanes) lanes.appendChild(laneEl(lane, 1, cardEl, editorOpen));
    el.appendChild(lanes);
    const floor = div('display:flex;flex-direction:row;flex-wrap:wrap;align-items:flex-start;min-height:60px');
    floor.className = 'cards board-floor';
    for (const row of data.cards || []) floor.appendChild(cardEl(toCard(row), null));
    if (adding && adding.laneId == null) floor.appendChild(addFormEl(null));
    if (!data.lanes.length && !(data.cards || []).length && !adding) {
      floor.appendChild(div('opacity:.5;font-size:12px;padding:6px', `Nothing on ${surface || 'the workspace root'} yet. Add a lane, a file, or a folder.`));
    }
    acceptDrag(floor);
    floor.addEventListener('drop', e => handleDrop(e, null, null));
    el.appendChild(floor);
    const focus = el.querySelector('.board-add-card input, .board-add-card textarea')
      || el.querySelector('.board-lane-title-edit, .board-lane-name, .board-inline-name');
    if (focus) queueMicrotask(() => focus.focus());
  }

  async function load() {
    surface = (ctx.boardPath || []).map(String).join('/');
    const [t, s, l, entries] = await Promise.all([
      call('tree'),
      isWhiteboard ? { notes: {} } : ctx.action('stickies', 'list', { rootPath: root() }).catch(() => ({ notes: {} })),
      isWhiteboard ? {} : ctx.request('/api/path-labels?root=' + encodeURIComponent(root())).catch(() => ({})),
      isWhiteboard ? null : ctx.request(`/api/tree?root=${encodeURIComponent(root())}&path=${encodeURIComponent(surface || '.')}`).catch(() => [])
    ]);
    data = t; stickies = s; labels = l;
    listed = entries && new Set(entries.map(e => e.relativePath));
  }

  function onPaste(e) {
    if (!isWhiteboard) return;
    const items = [...(e.clipboardData?.items || [])];
    const files = items.filter(item => item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    ingestFiles(files, null);
  }
  document.addEventListener('paste', onPaste);

  return {
    name: 'Board',
    events: ['labels-changed'],
    marks: [],
    labels: !isWhiteboard,
    selected: () => null,
    editing,
    stopEditing,
    reset: stopEditing,
    load,
    paint,
    select,
    open: openCard,
    openTitle: card => `Open the board inside ${card.ref}`,
    text,
    color,
    patch,
    remove,
    drag,
    dispose: () => document.removeEventListener('paste', onPaste)
  };
}
