// Contribution: the planning board. A surface is the workspace folder the
// board shows (the root or any folder). Lanes on a surface arrange cards:
// vertical is serial order, horizontal is parallel work, lanes nest three
// deep and write nothing to disk. A file card is a real file and a folder
// card is a real folder, both directly under the surface's folder; opening
// a folder card drills into its surface. Cards drag between lanes and to
// the floor; the sidebar tree's file rows drop in as file cards. Every
// mutation goes through the board store and the view repaints from 'tree'.
import { styleSticky, paletteEl, stickyKey, isolateStickyPointer, colorForLabel, DEFAULT_COLOR } from '/contrib/lib/sticky.js';
import { boardStore } from '/contrib/lib/board-store.js';
import { NAMED_ICONS, MAX_FIELDS, MAX_DEPTH } from '/contrib/lib/board-rules.js';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
const CARD_MIME = 'x-ro-card';

export function mount(el, ctx) {
  let disposed = false;
  let surface = '';
  let data = { surface: '', lanes: [], cards: [] };
  let stickies = { notes: {} };
  let labels = {};
  let previews = new Map();
  let editingCardId = null;
  let adding = null; // { laneId: number|null } null laneId is the floor
  let addKind = 'file';
  let addRef = '';
  let addBody = '';
  let addColor = null;
  let editColor = undefined;
  let namingLane = null; // { parentLaneId: number|null }
  let renamingLaneId = null;
  let pendingRemove = null;
  let removeTimer = 0;
  let dragCardId = null;
  let dragLaneId = null;

  const root = () => ctx.workspace?.root_path;
  const access = boardStore(ctx, ctx.config);
  const isWhiteboard = access.mode === 'whiteboard';
  const call = (action, payload = {}) => access.call(action, { surface, ...payload });
  const editorOpen = () => editingCardId != null || adding != null
    || renamingLaneId != null || namingLane != null;
  const mutate = (action, payload) => call(action, payload)
    .then(repaint)
    .catch(error => { ctx.notify(error.message, 'error'); repaint(); });

  function emitPath() {
    ctx.bus.emit('board-path', { path: surface.split('/').filter(Boolean) });
  }
  ctx.bus.on('board-path', msg => {
    if (!msg || msg.source !== 'history') return;
    surface = (msg.path || []).map(String).join('/');
    repaint();
  });

  function openSurface(next) {
    surface = next;
    stopEditing();
    emitPath();
    repaint();
  }

  function stopEditing() {
    editingCardId = null;
    adding = null;
    namingLane = null;
    renamingLaneId = null;
    editColor = undefined;
  }

  function isImageCard(card) {
    if (card.kind === 'image') return true;
    if (card.kind !== 'file') return false;
    const name = String(card.ref || '').split('/').pop() || '';
    return IMAGE_EXT.test(name);
  }

  function imageSrc(card) {
    if (card.kind === 'image' || String(card.ref || '').startsWith('data:')) return card.ref;
    const abs = pathAbs(card);
    if (!abs) return '';
    return `/api/file?root=${encodeURIComponent(root())}&path=${encodeURIComponent(abs)}&raw=1`;
  }

  function pathAbs(card) {
    if (card.kind !== 'file' && card.kind !== 'folder') return '';
    const r = root();
    const key = String(card.ref || '');
    if (!key) return '';
    return r && !key.startsWith('/') ? `${r}/${key}` : key;
  }

  function resolveColor(card) {
    if (card.color) return card.color;
    if (card.kind === 'file' || card.kind === 'folder') {
      const abs = pathAbs(card);
      const pathLabels = labels[abs] || labels[card.ref] || [];
      return colorForLabel(pathLabels[0]?.label);
    }
    return DEFAULT_COLOR;
  }

  function faceTitle(card) {
    if (card.kind === 'image') return card.title || 'image';
    if (card.kind === 'folder' && card.title) return card.title;
    if (card.kind === 'file' || card.kind === 'folder') {
      const ref = String(card.ref || '');
      return ref.split('/').filter(Boolean).pop() || ref;
    }
    if (card.kind === 'link') {
      try { return new URL(card.ref).host || card.ref; } catch { return card.ref; }
    }
    return String(card.ref || '').split('\n')[0] || '';
  }

  function idLine(card) {
    if (card.kind === 'image') return card.title || 'image';
    if (card.kind === 'file' || card.kind === 'folder') return card.ref || '';
    if (card.kind === 'link') {
      try { return new URL(card.ref).host || card.ref; } catch { return card.ref || ''; }
    }
    return 'note';
  }

  function stickyText(card) {
    if (card.kind === 'image') return card.title || '';
    if (card.kind === 'folder') return faceTitle(card);
    if (card.kind === 'file') {
      if (isWhiteboard) return card.text || '';
      const key = stickyKey(root(), card.ref);
      return stickies.notes?.[key]?.text || '';
    }
    if (card.kind === 'link') return card.title || '';
    return card.ref || '';
  }

  function noteBody(card) {
    const text = card.ref || '';
    const i = text.indexOf('\n');
    return i === -1 ? '' : text.slice(i + 1);
  }

  function cardBody(card) {
    if (card.kind === 'note') return noteBody(card);
    if (card.kind === 'link') return card.title || '';
    if (card.kind === 'image') return '';
    if (card.kind === 'file') {
      if (isWhiteboard && card.body != null) return String(card.body);
      return previews.get(pathAbs(card)) || '';
    }
    return stickyText(card);
  }

  function fieldsOf(card) {
    try {
      const arr = JSON.parse(card.fields_json || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function persistAppearance(card, patch) {
    return mutate('update-card', { cardId: card.card_id, ...patch });
  }

  function loadPreview(card) {
    if (card.kind !== 'file' || isWhiteboard || isImageCard(card)) return;
    const abs = pathAbs(card);
    if (!abs || previews.has(abs)) return;
    previews.set(abs, '');
    ctx.request(`/api/file?root=${encodeURIComponent(root())}&path=${encodeURIComponent(abs)}`)
      .then(rec => {
        const text = String(rec.content || '').split('\n').slice(0, 8).join('\n');
        previews.set(abs, text);
        const node = el.querySelector(`.board-card[data-card-id="${card.card_id}"] .body`);
        if (node && !node.querySelector('textarea')) node.textContent = text;
      })
      .catch(() => { previews.delete(abs); });
  }

  function allCards(lanes = data.lanes, out = [...(data.cards || [])]) {
    for (const lane of lanes) { out.push(...lane.cards); allCards(lane.lanes, out); }
    return out;
  }

  // ---- drag and drop -------------------------------------------------------
  // `holder` is the lane whose cards are the siblings, or null for the floor.
  const holderCards = holder => holder ? holder.cards : (data.cards || []);
  const holderId = holder => holder ? holder.lane_id : null;

  function orderAfterDrop(holder, beforeCard) {
    const rest = holderCards(holder).filter(c => c.card_id !== dragCardId);
    const at = beforeCard ? rest.findIndex(c => c.card_id === beforeCard.card_id) : rest.length;
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
    if (beforeCard && beforeCard.card_id === dragCardId) { dragCardId = null; return; }
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
    repaint();
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

  const acceptDrag = node => {
    node.addEventListener('dragover', e => {
      const types = [...(e.dataTransfer?.types || [])];
      if (dragCardId != null || dragLaneId != null || types.includes(CARD_MIME)) e.preventDefault();
      if (isWhiteboard && types.includes('Files')) e.preventDefault();
    });
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
      repaint();
    }).catch(error => ctx.notify(error.message, 'error'));
  }

  // ---- rendering (DOM API + textContent, so titles/refs need no escaping) --
  const div = (style, text) => {
    const d = document.createElement('div');
    if (style) d.style.cssText = style;
    if (text != null) d.textContent = text;
    return d;
  };
  const btn = (glyph, title, onclick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'board-head-btn';
    b.textContent = glyph; b.title = title; b.onclick = onclick;
    return b;
  };

  // Titles name where the thing lives: the whiteboard has no disk to mention.
  function removeTitle(what) {
    if (isWhiteboard) return `Remove the ${what} from the whiteboard.`;
    if (what === 'lane') return 'Remove the lane and its cards from the board. Files and folders stay on disk.';
    if (what === 'card') return 'Remove card';
    return `Remove from the board. The ${what} stays on disk.`;
  }

  function removeBtn(kind, id, idleTitle) {
    const armed = pendingRemove && pendingRemove.kind === kind && pendingRemove.id === id;
    const armedLabel = isWhiteboard ? 'remove?' : 'board only?';
    const armedTitle = isWhiteboard ? 'Remove from the whiteboard.' : 'Remove from the board. Files and folders stay on disk.';
    const b = btn(armed ? armedLabel : '✕', armed ? armedTitle : idleTitle, e => {
      e.stopPropagation();
      if (pendingRemove && pendingRemove.kind === kind && pendingRemove.id === id) {
        clearTimeout(removeTimer);
        pendingRemove = null;
        mutate('remove', kind === 'lane' ? { laneId: id } : { cardId: id });
        return;
      }
      clearTimeout(removeTimer);
      pendingRemove = { kind, id };
      b.textContent = armedLabel;
      b.title = armedTitle;
      removeTimer = setTimeout(() => {
        if (pendingRemove && pendingRemove.kind === kind && pendingRemove.id === id) {
          pendingRemove = null;
          if (b.isConnected) { b.textContent = '✕'; b.title = idleTitle; }
          else if (!disposed) paint();
        }
      }, 2000);
    });
    return b;
  }

  function hasReadme() {
    return allCards().some(c => c.kind === 'file' && String(c.ref || '').split('/').pop() === 'README.md');
  }

  function saveCardBody(card, text) {
    const colorPick = editColor;
    editColor = undefined;
    editingCardId = null;
    const next = { ...card, color: colorPick !== undefined ? colorPick : card.color };
    const patch = { cardId: card.card_id };
    if (colorPick !== undefined) patch.color = colorPick;
    if (card.kind === 'folder') {
      const v = String(text || '').trim();
      if (v && v !== faceTitle(card)) patch.name = v;
      if (patch.color === undefined && patch.name === undefined) { paint(); return; }
      call('update-card', patch).then(repaint).catch(error => { ctx.notify(error.message, 'error'); repaint(); });
      return;
    }
    if (card.kind === 'file') {
      // On the Board the text is the file's sticky note; on the whiteboard it
      // stays on the memory row and no service is called (ADR-023).
      if (isWhiteboard) {
        patch.text = text;
        call('update-card', patch).then(repaint).catch(error => { ctx.notify(error.message, 'error'); repaint(); });
        return;
      }
      const writes = [];
      if (colorPick !== undefined) writes.push(call('update-card', patch));
      const key = stickyKey(root(), card.ref);
      if (key && !key.startsWith('/')) {
        writes.push(ctx.action('stickies', 'set', { rootPath: root(), path: key, text, color: resolveColor(next) }));
      }
      if (!writes.length) { paint(); return; }
      Promise.all(writes).then(repaint).catch(error => { ctx.notify(error.message, 'error'); repaint(); });
      return;
    }
    const v = text.trim();
    if (v) {
      if (card.kind === 'note') patch.text = v;
      else patch.name = v;
    }
    if (patch.color === undefined && patch.text === undefined && patch.name === undefined) { paint(); return; }
    call('update-card', patch).then(repaint).catch(error => { ctx.notify(error.message, 'error'); repaint(); });
  }

  function flipEl(card) {
    const flip = document.createElement('span');
    flip.className = 'flip';
    flip.title = card.face === 'sticky' ? 'Show card face' : 'Show sticky face';
    flip.onclick = e => {
      e.stopPropagation();
      const next = card.face === 'sticky' ? 'card' : 'sticky';
      const host = flip.closest('.board-card');
      let done = false;
      const go = () => { if (done) return; done = true; persistAppearance(card, { face: next }); };
      if (!host) return go();
      host.style.animation = 'board-card-flip .25s ease';
      host.addEventListener('animationend', go, { once: true });
      setTimeout(go, 300);
    };
    return flip;
  }

  function iconPicker(card) {
    const wrap = document.createElement('span');
    wrap.className = 'icon';
    wrap.dataset.icon = card.icon || card.kind;
    wrap.textContent = card.icon || card.kind;
    isolateStickyPointer(wrap);
    wrap.onclick = e => {
      e.stopPropagation();
      if (wrap.querySelector('.icon-picker')) {
        wrap.querySelector('.icon-picker').remove();
        wrap.textContent = card.icon || card.kind;
        return;
      }
      wrap.textContent = '';
      const picker = document.createElement('span');
      picker.className = 'icon-picker';
      for (const name of NAMED_ICONS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = name;
        b.onclick = ev => { ev.stopPropagation(); persistAppearance(card, { icon: name }); };
        picker.appendChild(b);
      }
      const custom = document.createElement('input');
      custom.type = 'text';
      custom.maxLength = 2;
      custom.placeholder = '★';
      custom.onkeydown = ev => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          const v = custom.value.trim();
          if ([...v].length !== 1) { ctx.notify('Icon is one of file, folder, note, link, or a single character', 'error'); return; }
          persistAppearance(card, { icon: v });
        }
        if (ev.key === 'Escape') { ev.preventDefault(); paint(); }
      };
      picker.appendChild(custom);
      wrap.appendChild(picker);
      custom.focus();
    };
    return wrap;
  }

  function tagsEl(card) {
    if (isWhiteboard) return null;
    const abs = pathAbs(card);
    if (!abs) return null;
    const row = document.createElement('div');
    row.className = 'tags';
    isolateStickyPointer(row);
    const pathLabels = labels[abs] || labels[card.ref] || [];
    for (const a of pathLabels) {
      const chip = document.createElement('span');
      chip.className = 'label-chip';
      chip.style.borderColor = a.color;
      chip.style.color = a.color;
      chip.textContent = a.label;
      row.appendChild(chip);
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'tag-add';
    add.textContent = '＋ tag';
    add.onclick = e => {
      e.stopPropagation();
      ctx.bus.emit('open-labels', { path: abs });
    };
    row.appendChild(add);
    return row;
  }

  function fieldsEl(card) {
    const row = document.createElement('div');
    row.className = 'fields';
    isolateStickyPointer(row);
    const fields = fieldsOf(card);
    for (const field of fields) {
      const item = document.createElement('span');
      item.className = 'field';
      item.textContent = `${field.label}: ${field.value}`;
      row.appendChild(item);
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'field-add';
    add.textContent = '＋ field';
    add.onclick = e => {
      e.stopPropagation();
      if (fields.length >= MAX_FIELDS) {
        ctx.notify('A card holds at most four fields', 'error');
        return;
      }
      const form = document.createElement('span');
      form.className = 'field-new';
      const lab = document.createElement('input');
      lab.placeholder = 'label';
      const val = document.createElement('input');
      val.placeholder = 'value';
      let closed = false;
      const save = () => {
        if (closed) return;
        closed = true;
        form.remove();
        const label = lab.value.trim();
        const value = val.value.trim();
        if (!label && !value) { paint(); return; }
        persistAppearance(card, { fields: [...fields, { label, value }] });
      };
      lab.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); val.focus(); } if (ev.key === 'Escape') { ev.preventDefault(); paint(); } };
      val.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); save(); } if (ev.key === 'Escape') { ev.preventDefault(); paint(); } };
      val.onblur = () => { if (form.isConnected) save(); };
      form.append(lab, val);
      add.replaceWith(form);
      lab.focus();
    };
    row.appendChild(add);
    return row;
  }

  function stickyTextEl(card) {
    const body = document.createElement('div');
    body.className = 'text';
    isolateStickyPointer(body);
    if (editingCardId === card.card_id) {
      const area = document.createElement('textarea');
      area.rows = 3;
      area.value = stickyText(card);
      area.style.cssText = 'width:100%;background:rgba(255,255,255,.55);color:#222;border:1px solid rgba(0,0,0,.3);border-radius:4px;padding:2px 4px;font:inherit;resize:vertical';
      isolateStickyPointer(area);
      let cancelled = false;
      area.onkeydown = e => {
        if (e.key === 'Escape') {
          e.preventDefault();
          cancelled = true;
          stopEditing();
          paint();
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          area.blur();
        }
      };
      area.onblur = () => {
        if (cancelled || !area.isConnected) return;
        saveCardBody(card, area.value);
      };
      body.appendChild(area);
    } else {
      body.textContent = stickyText(card);
      body.onclick = () => {
        stopEditing();
        editingCardId = card.card_id;
        paint();
      };
    }
    return body;
  }

  function openEl(card) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'open';
    b.textContent = 'open';
    b.title = `Open the board inside ${card.ref}`;
    b.onclick = e => {
      e.stopPropagation();
      openSurface(String(card.ref || ''));
    };
    return b;
  }

  function paletteWrap(card) {
    const palWrap = document.createElement('div');
    palWrap.className = 'board-card-palette';
    isolateStickyPointer(palWrap);
    const editing = editingCardId === card.card_id;
    const mountPalette = () => {
      const current = editing && editColor !== undefined ? editColor : card.color;
      palWrap.replaceChildren(paletteEl(current, color => {
        if (editing) {
          editColor = color;
          mountPalette();
          return;
        }
        mutate('update-card', { cardId: card.card_id, color });
      }));
      palWrap.appendChild(removeBtn('card', card.card_id, removeTitle(card.kind === 'folder' || card.kind === 'file' ? card.kind : 'card')));
    };
    mountPalette();
    return palWrap;
  }

  function imageEl(card) {
    const wrap = document.createElement('div');
    wrap.className = 'board-image';
    isolateStickyPointer(wrap);
    const img = document.createElement('img');
    img.alt = faceTitle(card) || 'image';
    img.src = imageSrc(card);
    img.draggable = false;
    if (card.width) wrap.style.width = `${card.width}px`;
    wrap.appendChild(img);
    const handle = document.createElement('span');
    handle.className = 'board-image-handle';
    handle.title = 'Resize';
    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = wrap.getBoundingClientRect().width;
      const move = ev => {
        const next = Math.max(80, Math.round(startW + ev.clientX - startX));
        wrap.style.width = `${next}px`;
      };
      const up = ev => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        persistAppearance(card, { width: Math.max(80, Math.round(startW + ev.clientX - startX)) });
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    wrap.appendChild(handle);
    return wrap;
  }

  const FACES = {
    sticky: card => {
      const inner = document.createDocumentFragment();
      inner.append(iconPicker(card), stickyTextEl(card));
      if (isImageCard(card)) inner.appendChild(imageEl(card));
      if (card.kind === 'folder') inner.appendChild(openEl(card));
      inner.append(flipEl(card), paletteWrap(card));
      return inner;
    },
    card: card => {
      const inner = document.createDocumentFragment();
      const id = document.createElement('div');
      id.className = 'id';
      if (card.kind === 'link') {
        const a = document.createElement('a');
        a.href = card.ref;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = idLine(card);
        id.appendChild(a);
      } else {
        id.textContent = idLine(card);
      }
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = faceTitle(card);
      inner.append(id, title);
      const tags = tagsEl(card);
      if (tags) inner.appendChild(tags);
      inner.appendChild(fieldsEl(card));
      if (isImageCard(card)) {
        inner.appendChild(imageEl(card));
      } else {
        const body = document.createElement('div');
        body.className = 'body';
        body.textContent = cardBody(card);
        inner.appendChild(body);
      }
      if (card.kind === 'folder') inner.appendChild(openEl(card));
      inner.append(flipEl(card), paletteWrap(card));
      if (card.kind === 'file') loadPreview(card);
      return inner;
    }
  };

  // `holder` is the lane the card sits in, or null on the floor.
  function cardEl(card, holder) {
    const c = document.createElement('div');
    const face = card.face === 'sticky' ? 'sticky' : 'card';
    c.className = 'board-card card' + (face === 'sticky' ? ' sticky' : '');
    c.dataset.cardId = String(card.card_id);
    c.dataset.kind = card.kind;
    c.dataset.face = face;
    c.dataset.icon = card.icon || card.kind;
    c.dataset.ref = card.kind === 'file' || card.kind === 'folder' ? (stickyKey(root(), card.ref) || card.ref) : card.ref;
    if (isImageCard(card)) c.dataset.image = '1';
    const editing = editingCardId === card.card_id;
    const shownColor = editing && editColor !== undefined ? editColor : card.color;
    if (face === 'sticky') styleSticky(c, resolveColor({ ...card, color: shownColor }));
    c.draggable = !editorOpen();
    c.addEventListener('dragstart', e => {
      e.stopPropagation();
      if (editorOpen()) { e.preventDefault(); return; }
      dragCardId = card.card_id;
      e.dataTransfer.setData(CARD_MIME, JSON.stringify({ card_id: card.card_id }));
      e.dataTransfer.effectAllowed = 'move';
    });
    c.addEventListener('dragend', () => { dragCardId = null; dragLaneId = null; });
    acceptDrag(c);
    c.addEventListener('drop', e => {
      if (card.kind === 'folder' && (dragCardId != null || cardPayload(e))) {
        e.preventDefault(); e.stopPropagation();
        dragCardId = null;
        ctx.notify(`Folders are opened, not dropped into. Open ${faceTitle(card)} to arrange inside it.`, 'error');
        return;
      }
      handleDrop(e, holder, card);
    });

    if (card.kind === 'file' && !isWhiteboard) {
      const select = e => {
        e.stopPropagation();
        ctx.selectFile(card.ref).catch(error => ctx.notify(error.message, 'error'));
      };
      const open = e => {
        e.preventDefault();
        e.stopPropagation();
        ctx.selectFile(card.ref)
          .then(() => ctx.activateStation('revision-center'))
          .catch(error => ctx.notify(error.message, 'error'));
      };
      c.addEventListener('click', e => {
        if (e.target.closest('.text, .body, .fields, .tags, .flip, .icon, .open, .board-card-palette')) return;
        select(e);
      });
      c.addEventListener('dblclick', e => {
        if (e.target.closest('.text, .body, .fields, .tags, .flip, .icon, .open, .board-card-palette')) return;
        open(e);
      });
    }
    if (card.kind === 'folder') {
      c.addEventListener('dblclick', e => {
        if (e.target.closest('.text, .body, .fields, .tags, .flip, .icon, .board-card-palette')) return;
        e.preventDefault();
        openSurface(String(card.ref || ''));
      });
    }

    c.appendChild(FACES[face](card));
    return c;
  }

  function openAdd(lane, kind) {
    stopEditing();
    adding = { laneId: lane ? lane.lane_id : null };
    addKind = kind || 'file';
    addBody = '';
    addColor = null;
    addRef = addKind === 'file' && !hasReadme() ? 'README.md' : '';
    paint();
  }

  function openNameLane(parentLane) {
    stopEditing();
    namingLane = { parentLaneId: parentLane ? parentLane.lane_id : null };
    paint();
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
    repaint();
  }

  function addFormEl(lane) {
    const form = document.createElement('form');
    form.className = 'board-add-card';
    styleSticky(form, resolveColor({ kind: addKind === 'folder' ? 'note' : addKind, ref: addRef, color: addColor }));
    isolateStickyPointer(form);
    form.addEventListener('submit', e => { e.preventDefault(); submitAdd(lane); });
    form.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); adding = null; paint(); }
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
        paint();
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

    form.appendChild(paletteEl(addColor, color => { addColor = color; paint(); }));

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = addKind === 'folder' ? 'Create folder' : addKind === 'file' ? 'Create file' : 'Stick it';
    form.appendChild(submit);
    const into = lane ? `lane ${lane.name}` : 'the floor';
    form.appendChild(div('font-size:11px;opacity:.7;margin-top:4px', `Written under ${surface || 'the workspace root'}, placed in ${into}`));
    return form;
  }

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
    form.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); namingLane = null; paint(); } });
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
        else paint();
      };
      input.onkeydown = e => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
        if (e.key === 'Escape') { e.preventDefault(); renamingLaneId = null; paint(); }
      };
      input.onblur = () => { if (renamingLaneId === lane.lane_id && input.isConnected) save(); };
      h.appendChild(input);
    } else {
      const title = div('font-weight:600;flex:1', lane.name);
      title.className = 'board-lane-title';
      title.title = 'Drag to move the lane';
      h.appendChild(title);
    }
    h.appendChild(btn('✎', 'Rename lane', e => {
      e.stopPropagation();
      stopEditing();
      renamingLaneId = lane.lane_id;
      paint();
    }));
    h.appendChild(btn('＋', 'Add a file, folder, link, or note to this lane', () => openAdd(lane)));
    if (depth < MAX_DEPTH) h.appendChild(btn('＋ lane', 'Add a lane inside this lane', () => openNameLane(lane)));
    h.appendChild(btn(`⇄ ${lane.orientation}`, `Orientation: ${lane.orientation} (toggle)`, e => {
      e.stopPropagation();
      mutate('set-orientation', { laneId: lane.lane_id, orientation: lane.orientation === 'vertical' ? 'horizontal' : 'vertical' });
    }));
    h.appendChild(removeBtn('lane', lane.lane_id, removeTitle('lane')));
    return h;
  }

  function laneEl(lane, depth) {
    const tile = document.createElement('section');
    tile.className = 'board-lane';
    tile.dataset.laneId = String(lane.lane_id);
    tile.dataset.name = lane.name;
    tile.dataset.orientation = lane.orientation;
    tile.dataset.depth = String(depth);
    tile.draggable = !editorOpen();
    tile.addEventListener('dragstart', e => {
      e.stopPropagation();
      if (editorOpen()) { e.preventDefault(); return; }
      dragLaneId = lane.lane_id;
      e.dataTransfer.effectAllowed = 'move';
    });
    tile.addEventListener('dragend', () => { dragCardId = null; dragLaneId = null; });
    tile.appendChild(laneHeaderEl(lane, depth));
    const horizontal = lane.orientation === 'horizontal';
    const body = div(`display:flex;flex-direction:${horizontal ? 'row' : 'column'};align-items:${horizontal ? 'flex-start' : 'stretch'};flex-wrap:${horizontal ? 'wrap' : 'nowrap'};padding:4px;min-height:40px`);
    body.className = 'cards';
    for (const sub of lane.lanes) body.appendChild(laneEl(sub, depth + 1));
    if (namingLane && namingLane.parentLaneId === lane.lane_id) body.appendChild(laneNameFormEl(lane));
    for (const card of lane.cards) body.appendChild(cardEl(card, lane));
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
    const spacer = div('flex:1');
    bar.appendChild(spacer);
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

  function openSaveDialog() {
    el.querySelector('.board-save-dialog')?.remove();
    const dlg = document.createElement('dialog');
    dlg.className = 'board-save-dialog';
    const head = document.createElement('div');
    head.className = 'pm-head';
    const title = document.createElement('strong');
    title.textContent = 'Save to project';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    close.onclick = () => dlg.close();
    head.append(title, close);
    const body = document.createElement('div');
    body.className = 'pm-body';
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
    body.append(destLab, treeHost, nameLab, hint, go, status);
    dlg.append(head, body);
    el.appendChild(dlg);
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

  function paint() {
    if (disposed) return;
    el.innerHTML = '';
    if (!root()) { el.appendChild(div('opacity:.6;padding:8px', 'No workspace.')); return; }
    el.appendChild(surfaceBarEl());
    if (namingLane && namingLane.parentLaneId == null) el.appendChild(laneNameFormEl(null));
    const lanes = div('display:flex;flex-direction:row;flex-wrap:wrap;align-items:flex-start');
    lanes.className = 'board-lanes';
    for (const lane of data.lanes) lanes.appendChild(laneEl(lane, 1));
    el.appendChild(lanes);
    const floor = div('display:flex;flex-direction:row;flex-wrap:wrap;align-items:flex-start;min-height:60px');
    floor.className = 'cards board-floor';
    for (const card of data.cards || []) floor.appendChild(cardEl(card, null));
    if (adding && adding.laneId == null) floor.appendChild(addFormEl(null));
    if (!data.lanes.length && !(data.cards || []).length && !adding) {
      floor.appendChild(div('opacity:.5;font-size:12px;padding:6px', `Nothing on ${surface || 'the workspace root'} yet. Add a lane, a file, or a folder.`));
    }
    acceptDrag(floor);
    floor.addEventListener('drop', e => handleDrop(e, null, null));
    el.appendChild(floor);
    const focus = el.querySelector('.board-card textarea')
      || el.querySelector('.board-add-card input, .board-add-card textarea')
      || el.querySelector('.board-lane-title-edit, .board-lane-name, .board-inline-name');
    if (focus) queueMicrotask(() => focus.focus());
  }

  function repaint() {
    if (!root()) { paint(); return; }
    surface = (ctx.boardPath || []).map(String).join('/');
    Promise.all([
      call('tree'),
      isWhiteboard ? Promise.resolve({ notes: {} }) : ctx.action('stickies', 'list', { rootPath: root() }).catch(() => ({ notes: {} })),
      isWhiteboard ? Promise.resolve({}) : ctx.request('/api/path-labels?root=' + encodeURIComponent(root())).catch(() => ({})),
    ])
      .then(([t, s, l]) => {
        if (disposed) return;
        data = t; stickies = s; labels = l;
        paint();
      })
      .catch(error => { if (!disposed) { el.textContent = `Board failed: ${error.message}`; } });
  }

  ctx.bus.on('workspace', () => {
    stopEditing();
    pendingRemove = null;
    clearTimeout(removeTimer);
    previews = new Map();
    repaint();
  });
  ctx.bus.on('labels-changed', () => { if (!disposed) repaint(); });
  function onPaste(e) {
    if (!isWhiteboard || disposed) return;
    const items = [...(e.clipboardData?.items || [])];
    const files = items.filter(item => item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    ingestFiles(files, null);
  }
  document.addEventListener('paste', onPaste);
  repaint();
  return () => { disposed = true; clearTimeout(removeTimer); document.removeEventListener('paste', onPaste); };
}
