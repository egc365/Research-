// Contribution: the planning board — card workshop unwound. Groups and
// subgroups of cards that are real files, links and notes; a group lays its
// children out horizontally (hierarchy, kanban-like columns) or vertically
// (serial execution order). Click a group title to drill in, breadcrumb to
// climb back, drag cards to reorder or move between groups. Every mutation
// goes through the 'board' service and the whole view repaints from 'tree'.
import { styleSticky, paletteEl, stickyKey, isolateStickyPointer, colorForLabel, DEFAULT_COLOR } from '/contrib/lib/sticky.js';

const NAMED_ICONS = ['file', 'folder', 'note', 'link'];
const MAX_FIELDS = 4;

export function mount(el, ctx) {
  let disposed = false;
  let crumb = [];      // [{group_id, title}] from root down to the open group
  function emitPath() {
    ctx.bus.emit('board-path', { path: crumb.map(step => step.group_id) });
  }
  ctx.bus.on('board-path', msg => {
    if (!msg || msg.source !== 'history') return;
    const ids = msg.path || [];
    if (!ids.length) { crumb = []; paint(); return; }
    const found = findPath(data.groups, Number(ids[ids.length - 1]));
    crumb = found ? found.trail : [];
    paint();
  });
  let data = { groups: [] };
  let stickies = { notes: {} };
  let labels = {};
  let previews = new Map();
  let editingCardId = null;
  let adding = null; // { groupId: number|null } null groupId is the board floor
  let addKind = 'folder';
  let addRef = '';
  let addBody = '';
  let addColor = null;
  let editColor = undefined;
  let renamingGroupId = null;
  let pendingRemove = null;
  let removeTimer = 0;
  let dragCardId = null;
  let dragGroupId = null;

  const root = () => ctx.workspace?.root_path;
  const call = (action, payload = {}) => ctx.action('board', action, { rootPath: root(), ...payload });
  const editorOpen = () => editingCardId != null || adding != null
    || renamingGroupId != null;
  const mutate = (action, payload) => call(action, payload)
    .then(repaint)
    .catch(error => { ctx.notify(error.message, 'error'); repaint(); });

  function stopEditing() {
    editingCardId = null;
    adding = null;
    renamingGroupId = null;
    editColor = undefined;
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
    if (card.kind === 'file') {
      const ref = String(card.ref || '');
      return ref.split('/').filter(Boolean).pop() || ref;
    }
    if (card.kind === 'folder') return card.title || card.ref || '';
    if (card.kind === 'link') {
      try { return new URL(card.ref).host || card.ref; } catch { return card.ref; }
    }
    return String(card.ref || '').split('\n')[0] || '';
  }

  function idLine(card) {
    if (card.kind === 'file') return card.ref || '';
    if (card.kind === 'folder') return card.ref || card.title || '';
    if (card.kind === 'link') {
      try { return new URL(card.ref).host || card.ref; } catch { return card.ref || ''; }
    }
    return 'note';
  }

  function stickyText(card) {
    if (card.kind === 'file' || card.kind === 'folder') {
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
    if (card.kind === 'file') return previews.get(pathAbs(card)) || '';
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

  function editValue(card) {
    return stickyText(card);
  }

  function folderCard(group) {
    return {
      kind: 'folder',
      card_id: null,
      group_id: group.group_id,
      ref: group.folder_path || '',
      title: group.title,
      color: group.color,
      face: group.face || 'sticky',
      icon: group.icon || 'folder',
      fields_json: group.fields_json || '[]',
      group
    };
  }

  function persistAppearance(card, patch) {
    if (card.kind === 'folder') return mutate('update-card', { groupId: card.group_id, ...patch });
    return mutate('update-card', { cardId: card.card_id, ...patch });
  }

  function loadPreview(card) {
    if (card.kind !== 'file') return;
    const abs = pathAbs(card);
    if (!abs || previews.has(abs)) return;
    previews.set(abs, '');
    ctx.request(`/api/file?root=${encodeURIComponent(root())}&path=${encodeURIComponent(abs)}`)
      .then(rec => {
        const text = String(rec.content || '').split('\n').slice(0, 8).join('\n');
        previews.set(abs, text);
        const node = el.querySelector(`.board-card[data-kind="file"][data-ref="${CSS.escape(stickyKey(root(), card.ref) || card.ref)}"] .body`);
        if (node && !node.querySelector('textarea')) node.textContent = text;
      })
      .catch(() => {});
  }

  function findPath(groups, id, trail = []) {
    for (const g of groups) {
      const here = [...trail, { group_id: g.group_id, title: g.title }];
      if (g.group_id === id) return { node: g, trail: here };
      const deeper = findPath(g.groups, id, here);
      if (deeper) return deeper;
    }
    return null;
  }

  // ---- drag and drop -------------------------------------------------------
  function orderAfterDrop(group, beforeCard) {
    // Desired sequence: the group's cards minus the dragged one, dragged
    // inserted before `beforeCard` (or appended when dropped on empty space).
    const rest = group.cards.filter(c => c.card_id !== dragCardId);
    const at = beforeCard ? rest.findIndex(c => c.card_id === beforeCard.card_id) : rest.length;
    const prev = at > 0 ? rest[at - 1].sort_order : null;
    const next = at < rest.length ? rest[at].sort_order : null;
    if (prev == null && next == null) return { sortOrder: 100 };
    if (prev == null) return { sortOrder: next - 10 }; // may go negative; that's fine
    if (next == null) return { sortOrder: prev + 10 };
    const mid = Math.floor((prev + next) / 2);
    if (mid > prev && mid < next) return { sortOrder: mid };
    return { renumber: rest, at }; // cramped: no integer gap left
  }

  async function dropCard(group, beforeCard) {
    if (dragCardId == null) return;
    if (beforeCard && beforeCard.card_id === dragCardId) { dragCardId = null; return; } // dropped on itself
    const plan = orderAfterDrop(group, beforeCard);
    try {
      if (plan.renumber) {
        // Renumber the whole group with gaps of 10, dragged card in place.
        const seq = [...plan.renumber];
        seq.splice(plan.at, 0, { card_id: dragCardId });
        for (let i = 0; i < seq.length; i++) {
          await call('move', { cardId: seq[i].card_id, toGroupId: group.group_id, sortOrder: (i + 1) * 10 });
        }
      } else {
        await call('move', { cardId: dragCardId, toGroupId: group.group_id, sortOrder: plan.sortOrder });
      }
    } catch (error) { ctx.notify(error.message, 'error'); }
    dragCardId = null;
    repaint();
  }

  // A group tile drags like a card; dropping it on another group nests it
  // there, dropping it on the board floor makes it top-level. The server
  // enforces cycles and the 3-deep cap — a refusal surfaces as a notify.
  async function dropGroup(targetGroup) {
    if (dragGroupId == null) return;
    if (targetGroup && targetGroup.group_id === dragGroupId) { dragGroupId = null; return; }
    const siblings = targetGroup ? targetGroup.groups : data.groups;
    const top = siblings.reduce((max, g) => Math.max(max, g.sort_order), 0);
    const moved = dragGroupId;
    dragGroupId = null;
    await mutate('move', { groupId: moved, toParentId: targetGroup ? targetGroup.group_id : null, sortOrder: top + 10 });
  }

  const acceptDrag = node => {
    node.addEventListener('dragover', e => { if (dragCardId != null || dragGroupId != null) e.preventDefault(); });
  };

  // ---- rendering (DOM API + textContent, so titles/refs need no escaping) --
  const div = (style, text) => {
    const d = document.createElement('div');
    if (style) d.style.cssText = style;
    if (text != null) d.textContent = text;
    return d;
  };
  const btn = (glyph, title, onclick) => {
    const b = document.createElement('button');
    b.textContent = glyph; b.title = title; b.onclick = onclick;
    b.style.cssText = 'background:none;border:1px solid #444;border-radius:4px;color:inherit;cursor:pointer;padding:0 6px;margin-left:4px;font-size:12px';
    return b;
  };

  function removeBtn(kind, id, idleTitle) {
    const armed = pendingRemove && pendingRemove.kind === kind && pendingRemove.id === id;
    const b = btn(armed ? 'board only?' : '✕', armed ? 'Remove from the board. Files and folders stay on disk.' : idleTitle, e => {
      e.stopPropagation();
      if (pendingRemove && pendingRemove.kind === kind && pendingRemove.id === id) {
        clearTimeout(removeTimer);
        pendingRemove = null;
        mutate('remove', kind === 'group' ? { groupId: id } : { cardId: id });
        return;
      }
      clearTimeout(removeTimer);
      pendingRemove = { kind, id };
      b.textContent = 'board only?';
      b.title = 'Remove from the board. Files and folders stay on disk.';
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

  function hasReadme(group) {
    const cards = group ? group.cards : (data.cards || []);
    return cards.some(c => c.kind === 'file' && String(c.ref || '').split('/').pop() === 'README.md');
  }

  function saveCardBody(card, text) {
    const colorPick = editColor;
    editColor = undefined;
    editingCardId = null;
    const next = { ...card, color: colorPick !== undefined ? colorPick : card.color };
    const identity = card.kind === 'folder' ? { groupId: card.group_id } : { cardId: card.card_id };
    const patch = { ...identity };
    if (colorPick !== undefined) patch.color = colorPick;
    if (card.kind === 'file' || card.kind === 'folder') {
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

  function bindEl(card) {
    if (card.kind !== 'folder' || card.ref) return null;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'bind';
    b.textContent = 'bind to folder';
    b.onclick = e => {
      e.stopPropagation();
      mutate('bind-group', { groupId: card.group_id });
    };
    return b;
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
    const row = document.createElement('div');
    row.className = 'tags';
    isolateStickyPointer(row);
    const abs = pathAbs(card);
    const pathLabels = abs ? (labels[abs] || labels[card.ref] || []) : [];
    for (const a of pathLabels) {
      const chip = document.createElement('span');
      chip.className = 'label-chip';
      chip.style.borderColor = a.color;
      chip.style.color = a.color;
      chip.textContent = a.label;
      row.appendChild(chip);
    }
    if (abs) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'tag-add';
      add.textContent = '＋ tag';
      add.onclick = e => {
        e.stopPropagation();
        ctx.bus.emit('open-labels', { path: abs });
      };
      row.appendChild(add);
    }
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
      const save = () => {
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
    const editing = editingCardId === (card.kind === 'folder' ? `g${card.group_id}` : card.card_id);
    if (editing) {
      const area = document.createElement('textarea');
      area.rows = 3;
      area.value = editValue(card);
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
        editingCardId = card.kind === 'folder' ? `g${card.group_id}` : card.card_id;
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
    b.onclick = e => {
      e.stopPropagation();
      const found = findPath(data.groups, card.group_id);
      crumb = found ? found.trail : [];
      emitPath();
      paint();
    };
    return b;
  }

  function paletteWrap(card) {
    const palWrap = document.createElement('div');
    palWrap.className = 'board-card-palette';
    isolateStickyPointer(palWrap);
    const identity = card.kind === 'folder' ? { groupId: card.group_id } : { cardId: card.card_id };
    const editing = editingCardId === (card.kind === 'folder' ? `g${card.group_id}` : card.card_id);
    const mountPalette = () => {
      const current = editing && editColor !== undefined ? editColor : card.color;
      palWrap.replaceChildren(paletteEl(current, color => {
        if (editing) {
          editColor = color;
          mountPalette();
          return;
        }
        mutate('update-card', { ...identity, color });
      }));
      if (card.kind === 'folder') palWrap.appendChild(removeBtn('group', card.group_id, 'Remove group from the board. The folder stays on disk.'));
      else palWrap.appendChild(removeBtn('card', card.card_id, 'Remove card'));
    };
    mountPalette();
    return palWrap;
  }

  const FACES = {
    sticky: card => {
      const inner = document.createDocumentFragment();
      inner.append(iconPicker(card), stickyTextEl(card));
      const bind = bindEl(card);
      if (bind) inner.appendChild(bind);
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
      const body = document.createElement('div');
      body.className = 'body';
      body.textContent = cardBody(card);
      inner.append(id, title, tagsEl(card), fieldsEl(card), body);
      const bind = bindEl(card);
      if (bind) inner.appendChild(bind);
      if (card.kind === 'folder') inner.appendChild(openEl(card));
      inner.append(flipEl(card), paletteWrap(card));
      if (card.kind === 'file') loadPreview(card);
      return inner;
    }
  };

  function cardEl(card, group) {
    const c = document.createElement('div');
    const face = card.face === 'sticky' ? 'sticky' : 'card';
    c.className = 'board-card card' + (face === 'sticky' ? ' sticky' : '');
    c.dataset.kind = card.kind;
    c.dataset.face = face;
    c.dataset.icon = card.icon || card.kind;
    if (card.kind === 'file') c.dataset.ref = stickyKey(root(), card.ref) || card.ref;
    else if (card.kind === 'folder') {
      c.dataset.groupId = String(card.group_id);
      if (card.ref) c.dataset.folder = card.ref;
    } else c.dataset.ref = card.ref;
    const editing = editingCardId === (card.kind === 'folder' ? `g${card.group_id}` : card.card_id);
    const shownColor = editing && editColor !== undefined ? editColor : card.color;
    if (face === 'sticky') styleSticky(c, resolveColor({ ...card, color: shownColor }));
    c.draggable = !editorOpen();
    if (editing) c.draggable = false;
    c.addEventListener('dragstart', e => {
      e.stopPropagation();
      if (editorOpen()) { e.preventDefault(); return; }
      if (card.kind === 'folder') dragGroupId = card.group_id;
      else dragCardId = card.card_id;
    });
    c.addEventListener('dragend', () => { dragCardId = null; dragGroupId = null; });
    acceptDrag(c);
    c.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation();
      if (card.kind === 'folder') {
        if (dragGroupId != null) { dropGroup(card.group); return; }
        dropCard(card.group, null);
        return;
      }
      if (dragGroupId != null) { dropGroup(group); return; }
      dropCard(group, card);
    });

    if (card.kind === 'file') {
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

    c.appendChild(FACES[face](card));
    return c;
  }

  function openAdd(group, depth) {
    stopEditing();
    adding = { groupId: group ? group.group_id : null };
    addBody = '';
    addColor = null;
    if (!group) {
      addKind = 'folder';
      addRef = '';
    } else {
      addKind = 'file';
      addRef = hasReadme(group) ? '' : 'README.md';
    }
    paint();
  }

  async function submitAdd(group) {
    const kind = addKind;
    const body = addBody;
    const color = addColor;
    const raw = addRef.trim();
    const groupId = group ? group.group_id : null;
    try {
      if (kind === 'folder') {
        if (!raw) { ctx.notify('A folder needs a name', 'error'); return; }
        await call('add-card', { kind: 'folder', groupId, name: raw });
      } else if (kind === 'file') {
        if (!raw) { ctx.notify('A file needs a name', 'error'); return; }
        await call('add-card', { kind: 'file', groupId, name: raw, body, color });
      } else if (kind === 'note') {
        const ref = body.trim();
        if (!ref) { ctx.notify('A note needs some text', 'error'); return; }
        await call('add-card', { groupId, kind, ref, title: ref.split('\n')[0], color });
      } else {
        if (!raw) { ctx.notify('A link card needs a URL', 'error'); return; }
        await call('add-card', { groupId, kind, ref: raw, title: body.trim() || null, color });
      }
    } catch (error) {
      ctx.notify(error.message, 'error');
      return;
    }
    adding = null;
    addKind = 'folder';
    addRef = '';
    addBody = '';
    addColor = null;
    repaint();
  }

  function addFormEl(group, depth) {
    const form = document.createElement('form');
    form.className = 'board-add-card';
    form.dataset.depth = String(depth);
    styleSticky(form, resolveColor({ kind: addKind === 'folder' ? 'note' : addKind, ref: addRef, color: addColor }));
    isolateStickyPointer(form);
    form.addEventListener('submit', e => { e.preventDefault(); submitAdd(group); });
    form.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); adding = null; paint(); }
      if (e.key === 'Enter' && !e.shiftKey && e.target.tagName === 'TEXTAREA') {
        e.preventDefault();
        form.requestSubmit();
      }
    });

    const kinds = div('display:flex;gap:4px;margin-bottom:4px');
    const offered = depth < 3 ? ['folder', 'file', 'link', 'note'] : ['file', 'link', 'note'];
    for (const kind of offered) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = kind;
      b.dataset.kind = kind;
      b.setAttribute('aria-pressed', addKind === kind ? 'true' : 'false');
      b.onclick = () => {
        addKind = kind;
        if (kind === 'file' && !addRef) addRef = hasReadme(group) ? '' : 'README.md';
        if (kind === 'folder') addRef = addRef === 'README.md' ? '' : addRef;
        paint();
      };
      kinds.appendChild(b);
    }
    form.appendChild(kinds);

    if (addKind === 'folder' || addKind === 'file' || addKind === 'link') {
      const lab = document.createElement('label');
      lab.append(addKind === 'folder' ? 'Name' : addKind === 'file' ? 'Name' : 'URL');
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'board-inline-name';
      input.value = addRef;
      input.placeholder = addKind === 'file' ? 'README.md' : addKind === 'folder' ? 'folder' : 'https://';
      input.oninput = () => { addRef = input.value; };
      lab.appendChild(input);
      form.appendChild(lab);
    }

    if (addKind === 'file' || addKind === 'note' || addKind === 'link') {
      const bodyLab = document.createElement('label');
      bodyLab.append(addKind === 'file' ? 'First line' : 'Body');
      const area = document.createElement('textarea');
      area.rows = addKind === 'file' ? 1 : 3;
      area.value = addBody;
      area.oninput = () => { addBody = area.value; };
      bodyLab.appendChild(area);
      form.appendChild(bodyLab);
    }

    if (addKind === 'file' || addKind === 'note' || addKind === 'link') {
      form.appendChild(paletteEl(addColor, color => { addColor = color; paint(); }));
    }

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = addKind === 'folder' ? 'Create folder' : addKind === 'file' ? 'Create file' : 'Stick it';
    form.appendChild(submit);
    return form;
  }

  function headerEl(group, depth) {
    const h = document.createElement('header');
    h.style.cssText = 'display:flex;align-items:center;gap:4px;padding:4px 6px;border-bottom:1px solid #333';
    if (renamingGroupId === group.group_id) {
      const input = document.createElement('input');
      input.className = 'board-group-title-edit';
      input.value = group.title;
      input.style.cssText = 'flex:1;background:rgba(255,255,255,.55);color:#222;border:1px solid rgba(0,0,0,.3);border-radius:4px;padding:2px 6px;font:inherit';
      isolateStickyPointer(input);
      const save = () => {
        const v = input.value.trim();
        renamingGroupId = null;
        if (v && v !== group.title) mutate('rename', { groupId: group.group_id, title: v });
        else paint();
      };
      input.onkeydown = e => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
        if (e.key === 'Escape') { e.preventDefault(); renamingGroupId = null; paint(); }
      };
      input.onblur = () => { if (renamingGroupId === group.group_id && input.isConnected) save(); };
      h.appendChild(input);
    } else {
      const title = div('font-weight:600;cursor:pointer;flex:1', group.title);
      title.title = 'Open';
      title.onclick = () => {
        const found = findPath(data.groups, group.group_id);
        crumb = found ? found.trail : [];
        emitPath();
        paint();
      };
      h.appendChild(title);
    }
    if (!group.folder_path) {
      const mark = div('font-size:11px;opacity:.7', 'unbound');
      mark.className = 'board-unbound';
      h.appendChild(mark);
      h.appendChild(btn('bind to folder', 'Create the folder by this group name', e => {
        e.stopPropagation();
        mutate('bind-group', { groupId: group.group_id });
      }));
    }
    h.appendChild(btn('✎', 'Rename group', e => {
      e.stopPropagation();
      stopEditing();
      renamingGroupId = group.group_id;
      paint();
    }));
    h.appendChild(btn('＋', 'Add file or folder', () => openAdd(group, depth)));
    h.appendChild(btn(`⇄ ${group.orientation}`, `Orientation: ${group.orientation} (toggle)`, e => {
      e.stopPropagation();
      mutate('set-orientation', { groupId: group.group_id, orientation: group.orientation === 'vertical' ? 'horizontal' : 'vertical' });
    }));
    h.appendChild(removeBtn('group', group.group_id, 'Remove group from the board. The folder stays on disk.'));
    return h;
  }

  function bodyEl(group, depth) {
    const horizontal = group.orientation === 'horizontal';
    const body = div(`display:flex;flex-direction:${horizontal ? 'row' : 'column'};align-items:${horizontal ? 'flex-start' : 'stretch'};flex-wrap:${horizontal ? 'wrap' : 'nowrap'};padding:4px;min-height:40px`);
    body.className = 'cards';
    for (const sub of group.groups) body.appendChild(cardEl(folderCard(sub), sub));
    for (const card of group.cards) body.appendChild(cardEl(card, group));
    if (adding && adding.groupId === group.group_id) body.appendChild(addFormEl(group, depth));
    if (!group.groups.length && !group.cards.length && !(adding && adding.groupId === group.group_id)) {
      body.appendChild(div('opacity:.5;font-size:12px;padding:6px', 'empty — drop cards here'));
    }
    acceptDrag(body);
    body.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation();
      if (dragGroupId != null) { dropGroup(group); return; }
      dropCard(group, null);
    });
    return body;
  }

  function breadcrumbEl() {
    const bar = div('display:flex;align-items:center;gap:6px;padding:4px 2px;font-size:13px');
    const home = document.createElement('a');
    home.href = '#'; home.textContent = 'Board';
    home.onclick = e => { e.preventDefault(); crumb = []; emitPath(); paint(); };
    bar.appendChild(home);
    crumb.forEach((step, i) => {
      bar.appendChild(div('opacity:.5', '›'));
      const a = document.createElement('a');
      a.href = '#'; a.textContent = step.title;
      a.onclick = e => { e.preventDefault(); crumb = crumb.slice(0, i + 1); emitPath(); paint(); };
      bar.appendChild(a);
    });
    return bar;
  }

  function addTopGroupBtn() {
    const add = btn('＋ group', 'Add a folder or file at the workspace root', () => openAdd(null, 0));
    add.style.margin = '6px';
    return add;
  }

  function paint() {
    if (disposed) return;
    el.innerHTML = '';
    if (!root()) { el.appendChild(div('opacity:.6;padding:8px', 'No workspace.')); return; }
    const open = crumb.length ? findPath(data.groups, crumb[crumb.length - 1].group_id) : null;
    if (crumb.length && !open) { crumb = []; } // stale crumb (group removed elsewhere)
    if (open) {
      crumb = open.trail;
      el.appendChild(breadcrumbEl());
      const pane = div('');
      pane.appendChild(headerEl(open.node, crumb.length));
      pane.appendChild(bodyEl(open.node, crumb.length));
      el.appendChild(pane);
    } else if (!data.groups.length && !(data.cards || []).length) {
      el.appendChild(addTopGroupBtn());
      if (adding && adding.groupId == null) el.appendChild(addFormEl(null, 0));
    } else {
      el.appendChild(breadcrumbEl());
      const top = div('display:flex;flex-direction:row;flex-wrap:wrap;align-items:flex-start;min-height:60px');
      top.className = 'cards';
      for (const g of data.groups) top.appendChild(cardEl(folderCard(g), g));
      for (const card of data.cards || []) top.appendChild(cardEl(card, { group_id: null, cards: data.cards, groups: data.groups }));
      acceptDrag(top);
      top.addEventListener('drop', e => { e.preventDefault(); if (dragGroupId != null) dropGroup(null); });
      el.appendChild(top);
      el.appendChild(addTopGroupBtn());
      if (adding && adding.groupId == null) el.appendChild(addFormEl(null, 0));
    }
    const focus = el.querySelector('.board-card textarea')
      || el.querySelector('.board-add-card input, .board-add-card textarea')
      || el.querySelector('.board-group-title-edit, .board-inline-name');
    if (focus) queueMicrotask(() => focus.focus());
  }

  function repaint() {
    if (!root()) { paint(); return; }
    Promise.all([
      call('tree'),
      ctx.action('stickies', 'list', { rootPath: root() }).catch(() => ({ notes: {} })),
      ctx.request('/api/path-labels?root=' + encodeURIComponent(root())).catch(() => ({})),
    ])
      .then(([t, s, l]) => {
        if (disposed) return;
        data = t; stickies = s; labels = l;
        const wanted = ctx.boardPath || [];
        if (wanted.length) {
          const found = findPath(data.groups, Number(wanted[wanted.length - 1]));
          crumb = found ? found.trail : [];
        }
        paint();
      })
      .catch(error => { if (!disposed) { el.textContent = `Board failed: ${error.message}`; } });
  }

  ctx.bus.on('workspace', () => {
    crumb = [];
    stopEditing();
    pendingRemove = null;
    clearTimeout(removeTimer);
    previews = new Map();
    repaint();
  });
  ctx.bus.on('labels-changed', () => { if (!disposed) repaint(); });
  repaint();
  return () => { disposed = true; clearTimeout(removeTimer); };
}
