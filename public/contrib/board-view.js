// Contribution: the planning board — card workshop unwound. Groups and
// subgroups of cards that are real files, links and notes; a group lays its
// children out horizontally (hierarchy, kanban-like columns) or vertically
// (serial execution order). Click a group title to drill in, breadcrumb to
// climb back, drag cards to reorder or move between groups. Every mutation
// goes through the 'board' service and the whole view repaints from 'tree'.
import { styleSticky, paletteEl, stickyKey, isolateStickyPointer, colorForLabel, DEFAULT_COLOR } from '/contrib/lib/sticky.js';

const GLYPH = { file: '\u{1F5CE}', link: '\u{1F517}', note: '\u{1F4DD}' };

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
  let editingCardId = null;
  let addingGroupId = null;
  let addKind = 'note';
  let addRef = '';
  let addBody = '';
  let addColor = null;
  let editColor = undefined;
  let namingParent = undefined;
  let namingTitle = '';
  let renamingGroupId = null;
  let pendingRemove = null;
  let removeTimer = 0;
  let dragCardId = null;
  let dragGroupId = null;

  const root = () => ctx.workspace?.root_path;
  const call = (action, payload = {}) => ctx.action('board', action, { rootPath: root(), ...payload });
  const editorOpen = () => editingCardId != null || addingGroupId != null
    || renamingGroupId != null || namingParent !== undefined;
  const mutate = (action, payload) => call(action, payload)
    .then(repaint)
    .catch(error => { ctx.notify(error.message, 'error'); repaint(); });

  function stopEditing() {
    editingCardId = null;
    addingGroupId = null;
    renamingGroupId = null;
    namingParent = undefined;
    namingTitle = '';
    editColor = undefined;
  }

  function resolveColor(card) {
    if (card.color) return card.color;
    if (card.kind === 'file') {
      const r = root();
      const key = String(card.ref || '');
      const abs = r && key && !key.startsWith('/') ? `${r}/${key}` : key;
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
    if (card.kind === 'link') {
      try { return new URL(card.ref).host || card.ref; } catch { return card.ref; }
    }
    return String(card.ref || '').split('\n')[0] || '';
  }

  function faceBody(card) {
    if (card.kind === 'file') {
      const key = stickyKey(root(), card.ref);
      return stickies.notes?.[key]?.text || '';
    }
    if (card.kind === 'link') return card.title || '';
    const text = card.ref || '';
    const i = text.indexOf('\n');
    return i === -1 ? '' : text.slice(i + 1);
  }

  function editValue(card) {
    if (card.kind === 'file') {
      const key = stickyKey(root(), card.ref);
      return stickies.notes?.[key]?.text || '';
    }
    if (card.kind === 'link') return card.title || '';
    return card.ref || '';
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
    const b = btn(armed ? 'delete?' : '✕', armed ? 'Confirm remove' : idleTitle, e => {
      e.stopPropagation();
      if (pendingRemove && pendingRemove.kind === kind && pendingRemove.id === id) {
        clearTimeout(removeTimer);
        pendingRemove = null;
        mutate('remove', kind === 'group' ? { groupId: id } : { cardId: id });
        return;
      }
      clearTimeout(removeTimer);
      pendingRemove = { kind, id };
      b.textContent = 'delete?';
      b.title = 'Confirm remove';
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

  function groupNameEl(parentId) {
    const form = document.createElement('form');
    form.className = 'board-add-group';
    form.style.cssText = 'display:inline-flex;margin-left:4px';
    isolateStickyPointer(form);
    form.addEventListener('submit', e => {
      e.preventDefault();
      const t = namingTitle.trim();
      if (!t) return;
      namingParent = undefined;
      namingTitle = '';
      mutate('add-group', parentId == null ? { title: t } : { parentId, title: t });
    });
    form.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); namingParent = undefined; namingTitle = ''; paint(); }
    });
    const input = document.createElement('input');
    input.className = 'board-inline-name';
    input.value = namingTitle;
    input.placeholder = 'Group title';
    input.style.cssText = 'width:120px;background:rgba(255,255,255,.55);color:#222;border:1px solid rgba(0,0,0,.3);border-radius:4px;padding:2px 6px;font:inherit';
    input.oninput = () => { namingTitle = input.value; };
    form.appendChild(input);
    return form;
  }

  function saveCardBody(card, text) {
    const colorPick = editColor;
    editColor = undefined;
    editingCardId = null;
    const next = { ...card, color: colorPick !== undefined ? colorPick : card.color };
    const patch = { cardId: card.card_id };
    if (colorPick !== undefined) patch.color = colorPick;
    if (card.kind === 'file') {
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

  function cardEl(card, group) {
    const c = document.createElement('div');
    c.className = 'board-card card';
    c.dataset.kind = card.kind;
    c.dataset.ref = card.kind === 'file' ? (stickyKey(root(), card.ref) || card.ref) : card.ref;
    const editing = editingCardId === card.card_id;
    const shownColor = editing && editColor !== undefined ? editColor : card.color;
    styleSticky(c, resolveColor({ ...card, color: shownColor }));
    c.draggable = !editorOpen();
    if (editing) c.draggable = false;
    c.addEventListener('dragstart', e => {
      e.stopPropagation();
      if (editorOpen()) { e.preventDefault(); return; }
      dragCardId = card.card_id;
    });
    c.addEventListener('dragend', () => { dragCardId = null; });
    acceptDrag(c);
    c.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation();
      if (dragGroupId != null) { dropGroup(group); return; } // a group dropped on a card nests in the card's group
      dropCard(group, card);
    });

    const glyph = document.createElement('span');
    glyph.className = 'board-card-glyph';
    glyph.textContent = GLYPH[card.kind] || '';

    let title;
    if (card.kind === 'link') {
      title = document.createElement('a');
      title.href = card.ref;
      title.target = '_blank';
      title.rel = 'noopener';
    } else {
      title = document.createElement('span');
    }
    title.className = 'board-card-title';
    title.textContent = faceTitle(card);

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
        if (e.target.closest('.board-card-body, .board-card-palette')) return;
        select(e);
      });
      c.addEventListener('dblclick', e => {
        if (e.target.closest('.board-card-body, .board-card-palette')) return;
        open(e);
      });
    }

    c.append(glyph, title);

    const body = document.createElement('div');
    body.className = 'board-card-body';
    isolateStickyPointer(body);

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
      body.textContent = faceBody(card);
      body.onclick = () => { stopEditing(); editingCardId = card.card_id; paint(); };
    }
    c.appendChild(body);

    const palWrap = document.createElement('div');
    palWrap.className = 'board-card-palette';
    isolateStickyPointer(palWrap);
    const mountPalette = () => {
      const current = editing && editColor !== undefined ? editColor : card.color;
      palWrap.replaceChildren(paletteEl(current, color => {
        if (editingCardId === card.card_id) {
          editColor = color;
          c.style.background = resolveColor({ ...card, color });
          mountPalette();
          return;
        }
        mutate('set-color', { cardId: card.card_id, color });
      }), removeBtn('card', card.card_id, 'Remove card'));
    };
    mountPalette();
    c.appendChild(palWrap);
    return c;
  }

  function openAdd(group) {
    stopEditing();
    addingGroupId = group.group_id;
    addBody = '';
    addColor = null;
    if (ctx.selection) {
      addKind = 'file';
      addRef = stickyKey(root(), ctx.selection.path);
    } else {
      addKind = 'note';
      addRef = '';
    }
    paint();
  }

  async function submitAdd(group) {
    const kind = addKind;
    const body = addBody;
    const color = addColor;
    const raw = addRef.trim();
    let ref;
    let title = null;
    if (kind === 'note') {
      ref = body.trim();
      if (!ref) { ctx.notify('A note needs some text', 'error'); return; }
      title = ref.split('\n')[0];
    } else if (kind === 'file') {
      if (!raw) { ctx.notify('A file card needs a path', 'error'); return; }
      ref = stickyKey(root(), raw) || raw;
      title = null;
    } else {
      if (!raw) { ctx.notify('A link card needs a URL', 'error'); return; }
      ref = raw;
      title = body.trim() || null;
    }
    try {
      await call('add-card', { groupId: group.group_id, kind, ref, title, color });
    } catch (error) {
      ctx.notify(error.message, 'error');
      return;
    }
    if (kind === 'file' && body.trim()) {
      const key = stickyKey(root(), raw);
      if (key && !key.startsWith('/')) {
        try {
          await ctx.action('stickies', 'set', { rootPath: root(), path: key, text: body, color: resolveColor({ kind: 'file', ref, color }) });
        } catch (error) { ctx.notify(error.message, 'error'); }
      }
    }
    addingGroupId = null;
    addKind = 'note';
    addRef = '';
    addBody = '';
    addColor = null;
    repaint();
  }

  function addFormEl(group) {
    const form = document.createElement('form');
    form.className = 'board-add-card';
    styleSticky(form, resolveColor({ kind: addKind, ref: addRef, color: addColor }));
    isolateStickyPointer(form);
    form.addEventListener('submit', e => { e.preventDefault(); submitAdd(group); });
    form.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); addingGroupId = null; paint(); }
      if (e.key === 'Enter' && !e.shiftKey && e.target.tagName === 'TEXTAREA') {
        e.preventDefault();
        form.requestSubmit();
      }
    });

    const kinds = div('display:flex;gap:4px;margin-bottom:4px');
    for (const kind of ['file', 'link', 'note']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = kind;
      b.setAttribute('aria-pressed', addKind === kind ? 'true' : 'false');
      b.onclick = () => { addKind = kind; paint(); };
      kinds.appendChild(b);
    }
    form.appendChild(kinds);

    if (addKind !== 'note') {
      const lab = document.createElement('label');
      lab.append(addKind === 'file' ? 'Path' : 'URL');
      const input = document.createElement('input');
      input.type = 'text';
      input.value = addRef;
      input.oninput = () => { addRef = input.value; };
      lab.appendChild(input);
      form.appendChild(lab);
    }

    const bodyLab = document.createElement('label');
    bodyLab.append('Body');
    const area = document.createElement('textarea');
    area.rows = 3;
    area.value = addBody;
    area.oninput = () => { addBody = area.value; };
    bodyLab.appendChild(area);
    form.appendChild(bodyLab);

    form.appendChild(paletteEl(addColor, color => { addColor = color; paint(); }));

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = 'Stick it';
    form.appendChild(submit);
    return form;
  }

  function headerEl(group) {
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
    h.appendChild(btn('✎', 'Rename group', e => {
      e.stopPropagation();
      stopEditing();
      renamingGroupId = group.group_id;
      paint();
    }));
    h.appendChild(btn('＋', 'Add card', () => openAdd(group)));
    h.appendChild(btn('⊞', 'Add subgroup', () => {
      stopEditing();
      namingParent = group.group_id;
      namingTitle = '';
      paint();
    }));
    if (namingParent === group.group_id) h.appendChild(groupNameEl(group.group_id));
    h.appendChild(btn(`⇄ ${group.orientation}`, `Orientation: ${group.orientation} (toggle)`, e => {
      e.stopPropagation();
      mutate('set-orientation', { groupId: group.group_id, orientation: group.orientation === 'vertical' ? 'horizontal' : 'vertical' });
    }));
    h.appendChild(removeBtn('group', group.group_id, 'Remove group'));
    return h;
  }

  function bodyEl(group) {
    const horizontal = group.orientation === 'horizontal';
    const body = div(`display:flex;flex-direction:${horizontal ? 'row' : 'column'};align-items:${horizontal ? 'flex-start' : 'stretch'};flex-wrap:${horizontal ? 'wrap' : 'nowrap'};padding:4px;min-height:40px`);
    body.className = 'cards';
    for (const sub of group.groups) body.appendChild(groupEl(sub));
    for (const card of group.cards) body.appendChild(cardEl(card, group));
    if (addingGroupId === group.group_id) body.appendChild(addFormEl(group));
    if (!group.groups.length && !group.cards.length && addingGroupId !== group.group_id) {
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

  function groupEl(group) {
    const tile = div('border:1px solid #3a3a3a;border-radius:8px;margin:6px;background:#1f1f23;min-width:180px;flex:0 1 auto');
    tile.className = 'board-group group';
    tile.dataset.groupId = String(group.group_id);
    tile.dataset.orientation = group.orientation;
    tile.draggable = !editorOpen();
    tile.addEventListener('dragstart', e => {
      e.stopPropagation();
      if (editorOpen()) { e.preventDefault(); return; }
      dragGroupId = group.group_id;
    });
    tile.addEventListener('dragend', () => { dragGroupId = null; });
    tile.appendChild(headerEl(group));
    tile.appendChild(bodyEl(group));
    return tile;
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
    const add = btn('＋ group', 'Add top-level group', () => {
      stopEditing();
      namingParent = null;
      namingTitle = '';
      paint();
    });
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
      pane.appendChild(headerEl(open.node));
      pane.appendChild(bodyEl(open.node));
      el.appendChild(pane);
    } else if (!data.groups.length) {
      el.appendChild(addTopGroupBtn());
      if (namingParent === null) el.appendChild(groupNameEl(null));
    } else {
      el.appendChild(breadcrumbEl());
      const top = div('display:flex;flex-direction:row;flex-wrap:wrap;align-items:flex-start;min-height:60px');
      for (const g of data.groups) top.appendChild(groupEl(g));
      acceptDrag(top);
      top.addEventListener('drop', e => { e.preventDefault(); if (dragGroupId != null) dropGroup(null); });
      el.appendChild(top);
      el.appendChild(addTopGroupBtn());
      if (namingParent === null) el.appendChild(groupNameEl(null));
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
    repaint();
  });
  repaint();
  return () => { disposed = true; clearTimeout(removeTimer); };
}
