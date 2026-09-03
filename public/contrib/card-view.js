// Contribution: the one card view. config.view names the source that yields
// the cards (board, folder, blocks, queue; see ./sources) and
// config.appearance the face every card takes unless it carries its own:
// card (the file), sticky (the folder), icon (compact glyph plus title).
// The source hands over card records and the verbs it supports; the faces
// here draw a record and call the verbs without knowing which source it is.
import { styleSticky, paletteEl, isolateStickyPointer, colorForLabel, DEFAULT_STICKY_COLOR } from './lib/sticky.js';
import { NAMED_ICONS, MAX_FIELDS, defaultFace } from './lib/board-rules.js';

const SOURCES = ['board', 'folder', 'blocks', 'queue'];
const APPEARANCES = ['card', 'sticky', 'icon'];
// The named icons draw as symbols; a one-character icon draws as itself.
const GLYPHS = { file: '📄', folder: '📁', note: '📝', link: '🔗', image: '🖼' };
const CONTROLS = '.text, .body, .fields, .tags, .flip, .icon, .open, .board-card-palette';
// The card face previews this many lines of a file; the stylesheet caps the
// body at the same count of visual lines and scrolls the rest (.board-card .body).
const PREVIEW_LINES = 12;

export async function mount(el, ctx) {
  const which = String(ctx.config.view || '');
  if (!SOURCES.includes(which)) throw new Error(`Unknown card source: ${which || '(none)'}`);
  const { open } = await import(`./sources/${which}.js`);
  const appearance = APPEARANCES.includes(ctx.config.appearance) ? ctx.config.appearance : null;

  let disposed = false;
  let editingId = null;
  let editColor;
  let previews = new Map();
  const faces = new Map();
  let pendingRemove = null;
  let removeTimer = 0;

  const root = () => ctx.workspace?.root_path;
  const editorOpen = () => editingId != null || source.editing();
  const faceOf = card => {
    if (appearance === 'icon') return 'icon';
    return card.face || faces.get(card.id) || appearance || defaultFace(card.kind);
  };
  const resolveColor = (card, color = card.color) => color || colorForLabel(card.tags[0]?.label) || DEFAULT_STICKY_COLOR;

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
  const badge = (text, cls = '') => {
    const s = document.createElement('span');
    s.className = `badge ${cls}`.trim();
    s.textContent = text;
    return s;
  };

  function stopEditing() {
    editingId = null;
    editColor = undefined;
  }

  const run = promise => Promise.resolve(promise)
    .then(repaint)
    .catch(error => { ctx.notify(error.message, 'error'); repaint(); });
  const act = promise => Promise.resolve(promise).catch(error => ctx.notify(error.message, 'error'));

  // Two clicks remove: the first arms the button for two seconds.
  function removeBtn(key, { title, armedLabel, armedTitle, act }) {
    const armed = pendingRemove === key;
    const b = btn(armed ? armedLabel : '✕', armed ? armedTitle : title, e => {
      e.stopPropagation();
      clearTimeout(removeTimer);
      if (pendingRemove === key) { pendingRemove = null; run(act()); return; }
      pendingRemove = key;
      b.textContent = armedLabel;
      b.title = armedTitle;
      removeTimer = setTimeout(() => {
        if (pendingRemove !== key) return;
        pendingRemove = null;
        if (b.isConnected) { b.textContent = '✕'; b.title = title; } else if (!disposed) paint();
      }, 2000);
    });
    return b;
  }

  function loadPreview(card) {
    if (card.kind !== 'file' || card.image || card.missing || card.body != null || !card.path || !root()) return;
    if (previews.has(card.path)) return;
    previews.set(card.path, '');
    ctx.request(`/api/file?root=${encodeURIComponent(root())}&path=${encodeURIComponent(card.path)}`)
      .then(rec => {
        const text = String(rec.content || '').split('\n').slice(0, PREVIEW_LINES).join('\n');
        previews.set(card.path, text);
        const body = el.querySelector(`.board-card[data-card-id="${CSS.escape(String(card.id))}"] .body`);
        if (body && !body.querySelector('textarea')) body.textContent = text;
      })
      .catch(() => {});
  }

  const cardBody = card => card.body != null ? String(card.body) : previews.get(card.path) || '';

  function persist(card, patch) {
    if (source.patch) return run(source.patch(card, patch));
    if (patch.face) faces.set(card.id, patch.face);
    paint();
  }

  function flipEl(card, face) {
    const flip = document.createElement('span');
    flip.className = 'flip';
    flip.title = face === 'sticky' ? 'Show card face' : 'Show sticky face';
    flip.onclick = e => {
      e.stopPropagation();
      const next = face === 'sticky' ? 'card' : 'sticky';
      const host = flip.closest('.board-card');
      let done = false;
      const go = () => { if (done) return; done = true; persist(card, { face: next }); };
      if (!host) return go();
      host.style.animation = 'board-card-flip .25s ease';
      host.addEventListener('animationend', go, { once: true });
      setTimeout(go, 300);
    };
    return flip;
  }

  function iconEl(card) {
    const wrap = document.createElement('span');
    wrap.className = 'icon';
    wrap.dataset.icon = card.icon;
    wrap.textContent = GLYPHS[card.icon] ?? card.icon;
    isolateStickyPointer(wrap);
    if (!source.patch) return wrap;
    wrap.onclick = e => {
      e.stopPropagation();
      if (wrap.querySelector('.icon-picker')) {
        wrap.querySelector('.icon-picker').remove();
        wrap.textContent = GLYPHS[card.icon] ?? card.icon;
        return;
      }
      wrap.textContent = '';
      const picker = document.createElement('span');
      picker.className = 'icon-picker';
      for (const name of NAMED_ICONS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = `${GLYPHS[name]} ${name}`;
        b.onclick = ev => { ev.stopPropagation(); persist(card, { icon: name }); };
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
          persist(card, { icon: v });
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
    const labels = card.path && source.labels;
    if (!card.tags.length && !labels) return null;
    const row = document.createElement('div');
    row.className = 'tags';
    isolateStickyPointer(row);
    for (const a of card.tags) {
      const chip = document.createElement('span');
      chip.className = 'label-chip';
      if (a.color) { chip.style.borderColor = a.color; chip.style.color = a.color; }
      chip.textContent = a.label;
      row.appendChild(chip);
    }
    if (!labels) return row;
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'tag-add';
    add.textContent = '＋ tag';
    add.onclick = e => { e.stopPropagation(); ctx.bus.emit('open-labels', { path: card.path }); };
    row.appendChild(add);
    return row;
  }

  function fieldsEl(card) {
    if (!card.fields.length && !source.patch) return null;
    const row = document.createElement('div');
    row.className = 'fields';
    isolateStickyPointer(row);
    for (const field of card.fields) {
      const item = document.createElement('span');
      item.className = 'field';
      item.textContent = `${field.label}: ${field.value}`;
      row.appendChild(item);
    }
    if (!source.patch) return row;
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'field-add';
    add.textContent = '＋ field';
    add.onclick = e => {
      e.stopPropagation();
      if (card.fields.length >= MAX_FIELDS) { ctx.notify('A card holds at most four fields', 'error'); return; }
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
        persist(card, { fields: [...card.fields, { label, value }] });
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

  // The sticky text. Empty text shows the title dimmed so a card is never a
  // bare kind word (a folder, whose name line is drawn above, shows "note");
  // the editor still opens on the empty note.
  function textEl(card) {
    const body = document.createElement('div');
    body.className = 'text';
    isolateStickyPointer(body);
    if (editingId === card.id) {
      const area = document.createElement('textarea');
      area.rows = 3;
      area.value = card.text;
      area.style.cssText = 'width:100%;background:rgba(255,255,255,.55);color:#222;border:1px solid rgba(0,0,0,.3);border-radius:4px;padding:2px 4px;font:inherit;resize:vertical';
      isolateStickyPointer(area);
      let cancelled = false;
      area.onkeydown = e => {
        if (e.key === 'Escape') { e.preventDefault(); cancelled = true; stopEditing(); paint(); }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); area.blur(); }
      };
      area.onblur = () => {
        if (cancelled || !area.isConnected) return;
        const color = editColor;
        stopEditing();
        run(source.text(card, area.value, color));
      };
      body.appendChild(area);
      return body;
    }
    body.textContent = card.text || (card.kind === 'folder' ? 'note' : card.title);
    if (!card.text) body.classList.add('placeholder');
    if (source.text) {
      body.onclick = () => { source.stopEditing?.(); stopEditing(); editingId = card.id; paint(); };
    }
    return body;
  }

  function openEl(card) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'open';
    b.textContent = 'open';
    b.title = source.openTitle(card);
    b.onclick = e => { e.stopPropagation(); act(source.open(card)); };
    return b;
  }

  function paletteWrap(card) {
    const editing = editingId === card.id;
    const palette = source.color || (editing && source.text);
    if (!palette && !source.remove) return null;
    const wrap = document.createElement('div');
    wrap.className = 'board-card-palette';
    isolateStickyPointer(wrap);
    const mountPalette = () => {
      wrap.replaceChildren();
      if (palette) {
        const current = editing && editColor !== undefined ? editColor : card.color;
        wrap.appendChild(paletteEl(current, color => {
          if (editing) { editColor = color; mountPalette(); return; }
          run(source.color(card, color));
        }));
      }
      if (source.remove) {
        wrap.appendChild(removeBtn(`card:${card.id}`, {
          title: source.remove.title(card),
          armedLabel: source.remove.armedLabel,
          armedTitle: source.remove.armedTitle,
          act: () => source.remove.run(card)
        }));
      }
    };
    mountPalette();
    wrap.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      wrap.closest('.board-card')?.focus();
    });
    return wrap;
  }

  function imageEl(card) {
    const wrap = document.createElement('div');
    wrap.className = 'board-image';
    isolateStickyPointer(wrap);
    const img = document.createElement('img');
    img.alt = card.title || 'image';
    img.src = card.image;
    img.draggable = false;
    if (card.width) wrap.style.width = `${card.width}px`;
    wrap.appendChild(img);
    if (!source.patch) return wrap;
    const handle = document.createElement('span');
    handle.className = 'board-image-handle';
    handle.title = 'Resize';
    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = wrap.getBoundingClientRect().width;
      const widthAt = ev => Math.max(80, Math.round(startW + ev.clientX - startX));
      const move = ev => { wrap.style.width = `${widthAt(ev)}px`; };
      const up = ev => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        persist(card, { width: widthAt(ev) });
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    wrap.appendChild(handle);
    return wrap;
  }

  // A foot line is text, or { text, act } drawn as a link.
  function footEl(line) {
    const d = div('font-size:11px;opacity:.7;margin-top:4px');
    if (typeof line === 'string') { d.textContent = line; return d; }
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = line.text;
    a.onclick = e => { e.preventDefault(); e.stopPropagation(); act(line.act()); };
    d.appendChild(a);
    return d;
  }

  function titleEl(card) {
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = card.title;
    for (const b of card.badges) title.append(' ', badge(b.text, b.cls));
    if (card.missing) title.append(' ', badge('missing', 'missing'));
    return title;
  }

  const FACES = {
    card: card => {
      const inner = document.createDocumentFragment();
      const head = document.createElement('div');
      head.className = 'id';
      if (card.kind === 'link') {
        const a = document.createElement('a');
        a.href = card.ref;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = card.head;
        head.appendChild(a);
      } else {
        head.textContent = card.head;
      }
      inner.append(head, titleEl(card));
      const tags = tagsEl(card);
      if (tags) inner.appendChild(tags);
      const fields = fieldsEl(card);
      if (fields) inner.appendChild(fields);
      if (card.image) {
        inner.appendChild(imageEl(card));
      } else {
        const body = document.createElement('div');
        body.className = 'body';
        body.textContent = cardBody(card);
        inner.appendChild(body);
        loadPreview(card);
      }
      for (const line of card.foot) inner.appendChild(footEl(line));
      if (card.kind === 'folder' && source.open) inner.appendChild(openEl(card));
      inner.appendChild(flipEl(card, 'card'));
      const palette = paletteWrap(card);
      if (palette) inner.appendChild(palette);
      return inner;
    },
    sticky: card => {
      const inner = document.createDocumentFragment();
      const icon = iconEl(card);
      if (card.missing) icon.append(' ', badge('missing', 'missing'));
      if (card.kind === 'folder') {
        const head = div('display:flex;gap:6px;align-items:baseline');
        head.append(icon, titleEl(card));
        inner.append(head, textEl(card));
      } else {
        inner.append(icon, textEl(card));
      }
      if (card.image) inner.appendChild(imageEl(card));
      if (card.kind === 'folder' && source.open) inner.appendChild(openEl(card));
      inner.appendChild(flipEl(card, 'sticky'));
      const palette = paletteWrap(card);
      if (palette) inner.appendChild(palette);
      return inner;
    },
    icon: card => {
      const inner = document.createDocumentFragment();
      inner.append(iconEl(card), titleEl(card));
      const palette = paletteWrap(card);
      if (palette) inner.appendChild(palette);
      return inner;
    }
  };

  // `holder` is whatever the source groups cards by (a lane, or null).
  function cardEl(card, holder) {
    const c = document.createElement('div');
    const face = faceOf(card);
    c.className = 'board-card card' + (face === 'sticky' ? ' sticky' : '') + (face === 'icon' ? ' compact' : '')
      + (source.selected() === card.id ? ' selected' : '');
    c.dataset.cardId = String(card.id);
    c.dataset.kind = card.kind;
    c.dataset.face = face;
    c.dataset.icon = card.icon;
    c.dataset.ref = card.ref;
    if (card.image) c.dataset.image = '1';
    if (card.missing) c.dataset.missing = '1';
    const editing = editingId === card.id;
    if (face === 'sticky') styleSticky(c, resolveColor(card, editing && editColor !== undefined ? editColor : card.color));
    if (source.drag) {
      c.draggable = !editorOpen();
      c.addEventListener('dragstart', e => {
        e.stopPropagation();
        if (editorOpen()) { e.preventDefault(); return; }
        source.drag.start(card, e);
      });
      c.addEventListener('dragend', () => source.drag.end());
      c.addEventListener('dragover', e => source.drag.over(e));
      c.addEventListener('drop', e => source.drag.drop(card, e, holder));
    }
    if (source.select) {
      c.addEventListener('click', e => {
        if (e.target.closest(CONTROLS)) return;
        e.stopPropagation();
        act(source.select(card));
      });
    }
    if (source.open) {
      c.addEventListener('dblclick', e => {
        if (e.target.closest(CONTROLS)) return;
        e.preventDefault();
        e.stopPropagation();
        act(source.open(card));
      });
    }
    c.appendChild(FACES[face](card));
    if (c.querySelector('.board-card-palette')) c.tabIndex = 0;
    return c;
  }

  // Keyboard focus outlives a repaint: the same card, or the same palette
  // dot on it, takes it back.
  function focused() {
    const a = document.activeElement;
    const card = a && el.contains(a) ? a.closest('.board-card') : null;
    if (!card) return null;
    return { id: card.dataset.cardId, dot: a.matches('.board-card-palette button') ? a.getAttribute('aria-label') : null };
  }
  function refocus({ id, dot }) {
    const card = el.querySelector(`.board-card[data-card-id="${CSS.escape(id)}"]`);
    if (!card) return;
    const target = dot ? card.querySelector(`.board-card-palette button[aria-label="${CSS.escape(dot)}"]`) : null;
    (target || card).focus();
  }

  function chipsEl(chips) {
    const row = document.createElement('div');
    row.className = 'chip-row';
    for (const chip of chips) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.chip = chip.id;
      b.className = chip.active ? 'active' : '';
      b.textContent = chip.label;
      b.onclick = () => { loaded = source.filter(chip.id); paint(); };
      row.appendChild(b);
    }
    return row;
  }

  let loaded = { groups: [], note: null, empty: '' };

  function paintGroups() {
    const panel = document.createElement('div');
    panel.className = 'card card-view';
    if (loaded.chips) panel.appendChild(chipsEl(loaded.chips));
    if (loaded.note) panel.appendChild(div('margin:6px 0;opacity:.7', loaded.note));
    const groups = loaded.groups.filter(g => g.cards.length);
    if (!groups.length && loaded.empty) panel.appendChild(div('opacity:.7', loaded.empty));
    for (const group of groups) {
      if (group.title) {
        const head = div('margin:6px 0');
        head.appendChild(badge(group.title, group.cls));
        panel.appendChild(head);
      }
      const grid = div();
      grid.className = 'card-view-grid';
      for (const card of group.cards) grid.appendChild(cardEl(card, group));
      panel.appendChild(grid);
    }
    el.appendChild(panel);
  }

  function paint() {
    if (disposed) return;
    const had = focused();
    el.innerHTML = '';
    if (!root()) { el.appendChild(div('opacity:.6;padding:8px', 'No workspace.')); return; }
    if (source.paint) source.paint(el, cardEl); else paintGroups();
    const area = el.querySelector('.board-card textarea');
    if (area) queueMicrotask(() => area.focus());
    else if (had) refocus(had);
  }

  function repaint() {
    if (disposed) return;
    if (!root()) { paint(); return; }
    return Promise.resolve(source.load())
      .then(result => { if (disposed) return; if (result) loaded = result; paint(); })
      .catch(error => { if (!disposed) el.textContent = `${source.name} failed: ${error.message}`; });
  }

  const view = { btn, div, removeBtn, run, repaint, paint, stopEditing, editing: () => editingId != null };
  const source = await open(ctx, ctx.config, view);

  for (const event of source.events) ctx.bus.on(event, () => repaint());
  for (const event of source.marks) {
    ctx.bus.on(event, () => {
      const id = source.selected();
      el.querySelectorAll('.board-card').forEach(node => node.classList.toggle('selected', node.dataset.cardId === String(id)));
    });
  }
  ctx.bus.on('workspace', () => {
    stopEditing();
    pendingRemove = null;
    clearTimeout(removeTimer);
    previews = new Map();
    source.reset?.();
    repaint();
  });
  await repaint();
  return () => { disposed = true; clearTimeout(removeTimer); source.dispose?.(); };
}
