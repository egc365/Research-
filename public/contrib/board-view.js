// Contribution: the planning board — card workshop unwound. Groups and
// subgroups of cards that are real files, links and notes; a group lays its
// children out horizontally (hierarchy, kanban-like columns) or vertically
// (serial execution order). Click a group title to drill in, breadcrumb to
// climb back, drag cards to reorder or move between groups. Every mutation
// goes through the 'board' service and the whole view repaints from 'tree'.
import { styleSticky, paletteEl, stickyKey, mountPathSticky, DEFAULT_COLOR } from '/contrib/lib/sticky.js';

export function mount(el, ctx) {
  let disposed = false;
  let crumb = [];      // [{group_id, title}] from root down to the open group
  let data = { groups: [] };
  let stickies = { notes: {} };
  let editingKey = null;
  let dragCardId = null;
  let dragGroupId = null;

  const root = () => ctx.workspace?.root_path;
  const call = (action, payload = {}) => ctx.action('board', action, { rootPath: root(), ...payload });
  // File cards store workspace-relative refs; a selection path that carries
  // the workspace root is trimmed down to one.
  const relative = p => {
    const r = root();
    return r && p.startsWith(r + '/') ? p.slice(r.length + 1) : p;
  };
  const mutate = (action, payload) => call(action, payload)
    .then(repaint)
    .catch(error => { ctx.notify(error.message, 'error'); repaint(); });

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

  function cardEl(card, group) {
    const c = div('border:1px solid #3a3a3a;border-radius:6px;padding:6px 8px;margin:4px;background:#26262b;cursor:grab;font-size:13px');
    c.className = 'board-card';
    c.dataset.kind = card.kind;
    c.draggable = true;
    c.addEventListener('dragstart', e => {
      e.stopPropagation(); // don't also start the parent tile's group drag
      if (e.target.closest('[data-sticky]')) { e.preventDefault(); return; }
      dragCardId = card.card_id;
    });
    c.addEventListener('dragend', () => { dragCardId = null; });
    acceptDrag(c);
    c.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation();
      if (dragGroupId != null) { dropGroup(group); return; } // a group dropped on a card nests in the card's group
      dropCard(group, card);
    });

    if (card.kind === 'file') {
      // Basename on the card; the full ref stays in the tooltip.
      c.textContent = `\u{1F5CE} ${card.title || card.ref.split('/').pop()}`;
      c.title = card.ref;
      c.style.cursor = 'pointer';
      c.onclick = () => ctx.selectFile(card.ref).catch(error => ctx.notify(error.message, 'error'));
      const key = stickyKey(root(), card.ref);
      if (key) {
        const note = stickies.notes?.[key];
        if (editingKey === key) c.draggable = false;
        const area = mountPathSticky(c, {
          note,
          defaultColor: DEFAULT_COLOR,
          editing: editingKey === key,
          placeholder: 'A few words on this file…',
          onBeginEdit: () => { editingKey = key; paint(); },
          onCancel: () => { editingKey = null; paint(); },
          onSave: (text, color) => {
            ctx.action('stickies', 'set', { rootPath: root(), path: key, text, color })
              .then(() => { editingKey = null; repaint(); })
              .catch(error => { ctx.notify(error.message, 'error'); editingKey = null; repaint(); });
          },
        });
        if (area) queueMicrotask(() => area.focus());
      }
    } else if (card.kind === 'link') {
      const a = document.createElement('a');
      a.href = card.ref; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = `\u{1F517} ${card.title || card.ref}`;
      c.appendChild(a);
    } else { // note: a sticky — colored, writable surface; dblclick edits in place
      styleSticky(c, card.color);
      c.style.minHeight = '56px';
      const face = div('', card.title || card.ref);
      c.appendChild(face);
      c.appendChild(paletteEl(card.color, color => mutate('set-color', { cardId: card.card_id, color })));
      c.ondblclick = () => {
        const input = document.createElement('textarea');
        input.value = card.title || card.ref;
        input.rows = 3;
        input.style.cssText = 'width:100%;background:rgba(255,255,255,.55);color:#222;border:1px solid rgba(0,0,0,.3);border-radius:4px;padding:2px 4px;font:inherit;resize:vertical';
        face.textContent = ''; face.appendChild(input); input.focus();
        const commit = () => { const v = input.value.trim(); v && v !== (card.title || card.ref) ? mutate('rename', { cardId: card.card_id, title: v }) : repaint(); };
        input.onblur = commit;
        input.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) input.blur(); if (e.key === 'Escape') repaint(); };
      };
    }
    return c;
  }

  function addCardFlow(group) {
    let kind, ref, title = null;
    if (ctx.selection && confirm(`Card from current selection?\n${ctx.selection.path}`)) {
      kind = 'file'; ref = relative(ctx.selection.path);
    } else {
      kind = (prompt('Card kind: file / link / note', 'note') || '').trim();
      if (!['file', 'link', 'note'].includes(kind)) return kind && ctx.notify(`Unknown kind: ${kind}`, 'error');
      ref = (prompt(kind === 'file' ? 'Workspace-relative path' : kind === 'link' ? 'URL' : 'Note text') || '').trim();
      if (!ref) return;
      if (kind !== 'note') title = prompt('Title (optional)') || null;
    }
    mutate('add-card', { groupId: group.group_id, kind, ref, title });
  }

  function headerEl(group) {
    const h = div('display:flex;align-items:center;gap:4px;padding:4px 6px;border-bottom:1px solid #333');
    const title = div('font-weight:600;cursor:pointer;flex:1', group.title);
    title.title = 'Open';
    title.onclick = () => { const found = findPath(data.groups, group.group_id); crumb = found ? found.trail : []; paint(); };
    title.ondblclick = e => {
      e.stopPropagation();
      const v = prompt('Group title', group.title);
      if (v && v.trim() && v.trim() !== group.title) mutate('rename', { groupId: group.group_id, title: v.trim() });
    };
    h.appendChild(title);
    h.appendChild(btn('＋', 'Add card', () => addCardFlow(group)));
    h.appendChild(btn('⊞', 'Add subgroup', () => {
      const t = prompt('Subgroup title');
      if (t && t.trim()) mutate('add-group', { parentId: group.group_id, title: t.trim() });
    }));
    h.appendChild(btn('⇄', `Orientation: ${group.orientation} (toggle)`, () =>
      mutate('set-orientation', { groupId: group.group_id, orientation: group.orientation === 'vertical' ? 'horizontal' : 'vertical' })));
    h.appendChild(btn('✕', 'Remove group', () => {
      if (confirm(`Remove "${group.title}" and everything inside it?`)) mutate('remove', { groupId: group.group_id });
    }));
    return h;
  }

  function bodyEl(group) {
    const horizontal = group.orientation === 'horizontal';
    const body = div(`display:flex;flex-direction:${horizontal ? 'row' : 'column'};align-items:${horizontal ? 'flex-start' : 'stretch'};flex-wrap:${horizontal ? 'wrap' : 'nowrap'};padding:4px;min-height:40px`);
    for (const sub of group.groups) body.appendChild(groupEl(sub));
    for (const card of group.cards) body.appendChild(cardEl(card, group));
    if (!group.groups.length && !group.cards.length) body.appendChild(div('opacity:.5;font-size:12px;padding:6px', 'empty — drop cards here'));
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
    tile.draggable = true;
    tile.addEventListener('dragstart', e => { e.stopPropagation(); dragGroupId = group.group_id; });
    tile.addEventListener('dragend', () => { dragGroupId = null; });
    tile.appendChild(headerEl(group));
    tile.appendChild(bodyEl(group));
    return tile;
  }

  function breadcrumbEl() {
    const bar = div('display:flex;align-items:center;gap:6px;padding:4px 2px;font-size:13px');
    const home = document.createElement('a');
    home.href = '#'; home.textContent = 'Board';
    home.onclick = e => { e.preventDefault(); crumb = []; paint(); };
    bar.appendChild(home);
    crumb.forEach((step, i) => {
      bar.appendChild(div('opacity:.5', '›'));
      const a = document.createElement('a');
      a.href = '#'; a.textContent = step.title;
      a.onclick = e => { e.preventDefault(); crumb = crumb.slice(0, i + 1); paint(); };
      bar.appendChild(a);
    });
    return bar;
  }

  function paint() {
    if (disposed) return;
    el.innerHTML = '';
    if (!root()) { el.appendChild(div('opacity:.6;padding:8px', 'No workspace.')); return; }
    el.appendChild(breadcrumbEl());
    const open = crumb.length ? findPath(data.groups, crumb[crumb.length - 1].group_id) : null;
    if (crumb.length && !open) { crumb = []; } // stale crumb (group removed elsewhere)
    if (open) {
      crumb = open.trail;
      const pane = div('');
      pane.appendChild(headerEl(open.node));
      pane.appendChild(bodyEl(open.node));
      el.appendChild(pane);
    } else {
      const top = div('display:flex;flex-direction:row;flex-wrap:wrap;align-items:flex-start;min-height:60px');
      for (const g of data.groups) top.appendChild(groupEl(g));
      acceptDrag(top);
      top.addEventListener('drop', e => { e.preventDefault(); if (dragGroupId != null) dropGroup(null); });
      el.appendChild(top);
      const add = btn('＋ group', 'Add top-level group', () => {
        const t = prompt('Group title');
        if (t && t.trim()) mutate('add-group', { title: t.trim() });
      });
      add.style.margin = '6px';
      el.appendChild(add);
    }
  }

  function repaint() {
    if (!root()) { paint(); return; }
    Promise.all([
      call('tree'),
      ctx.action('stickies', 'list', { rootPath: root() }).catch(() => ({ notes: {} })),
    ])
      .then(([t, s]) => { if (!disposed) { data = t; stickies = s; paint(); } })
      .catch(error => { if (!disposed) { el.textContent = `Board failed: ${error.message}`; } });
  }

  ctx.bus.on('workspace', () => { crumb = []; editingKey = null; repaint(); });
  repaint();
  return () => { disposed = true; };
}
