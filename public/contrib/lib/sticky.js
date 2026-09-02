// Sticky-note rendering, shared by the board and the folder cards. The
// palette is defined here and imported by plugins/server/stickies.mjs (the
// server refuses anything off it), so a note can never render in an
// unreadable color. Classic office colors.
export const STICKY_COLORS = ['#f6e58d', '#ffb8b8', '#badc58', '#7ed6df', '#e6a8f7', '#ffbe76'];
export const DEFAULT_COLOR = STICKY_COLORS[0];

// A stable "color by function": the same label always yields the same sticky
// color, so folders sharing a function share a look without any rules engine.
export function colorForLabel(label) {
  if (!label) return DEFAULT_COLOR;
  let h = 0;
  for (const ch of String(label)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return STICKY_COLORS[h % STICKY_COLORS.length];
}

export function styleSticky(el, color) {
  el.style.cssText += `;background:${color || DEFAULT_COLOR};color:#222;border:none;border-radius:2px;` +
    'box-shadow:1px 2px 4px rgba(0,0,0,.45);padding:8px 10px;font-size:13px;line-height:1.35;' +
    'white-space:pre-wrap;word-break:break-word';
}

// A row of palette dots; clicking one reports the color. Clicking the dot of
// the current color reports null (clear back to default).
export function paletteEl(current, onPick) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:4px;padding:2px 0';
  for (const color of STICKY_COLORS) {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.title = color === current ? 'Clear color' : 'Set color';
    dot.style.cssText = `width:14px;height:14px;border-radius:50%;cursor:pointer;padding:0;background:${color};` +
      `border:${color === current ? '2px solid #222' : '1px solid rgba(0,0,0,.35)'}`;
    dot.onclick = e => { e.stopPropagation(); onPick(color === current ? null : color); };
    row.appendChild(dot);
  }
  return row;
}

// Board cards may store an absolute ref under the workspace root; the
// stickies service keys by the workspace-relative path folder cards already use.
export function stickyKey(rootPath, ref) {
  const key = String(ref ?? '').trim();
  if (!key) return '';
  if (rootPath && (key === rootPath || key.startsWith(rootPath + '/'))) return key.slice(rootPath.length + 1);
  return key;
}

// Keep pointer events on the note from selecting the card or starting a drag.
// preventDefault on mousedown would steal textarea focus, so skip it there.
export function isolateStickyPointer(el) {
  el.dataset.sticky = '';
  el.addEventListener('mousedown', e => {
    e.stopPropagation();
    if (e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'INPUT') e.preventDefault();
  });
  el.addEventListener('click', e => e.stopPropagation());
}

export function mountPathSticky(host, opts) {
  const {
    note,
    defaultColor = DEFAULT_COLOR,
    editing = false,
    placeholder = 'A few words…',
    onBeginEdit,
    onCancel,
    onSave,
  } = opts;

  if (editing) {
    const box = document.createElement('div');
    styleSticky(box, note?.color || defaultColor);
    box.style.marginTop = '6px';
    isolateStickyPointer(box);
    const area = document.createElement('textarea');
    area.value = note?.text || '';
    area.rows = 2;
    area.placeholder = placeholder;
    area.style.cssText = 'width:100%;background:rgba(255,255,255,.55);color:#222;border:1px solid rgba(0,0,0,.3);border-radius:4px;padding:2px 4px;font:inherit;resize:vertical';
    let color = note?.color || defaultColor;
    const palette = paletteEl(color, picked => { color = picked || defaultColor; styleSticky(box, color); });
    const save = document.createElement('button');
    save.textContent = note ? 'Save' : 'Stick it';
    save.onclick = () => onSave(area.value, color);
    area.onkeydown = e => { if (e.key === 'Escape') onCancel(); };
    box.append(area, palette, save);
    host.append(box);
    return area;
  }

  if (note) {
    const sticky = document.createElement('div');
    styleSticky(sticky, note.color);
    sticky.style.marginTop = '6px';
    sticky.textContent = note.text;
    sticky.title = 'Edit sticky';
    sticky.onclick = () => onBeginEdit();
    isolateStickyPointer(sticky);
    host.append(sticky);
    return null;
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.textContent = '＋ sticky';
  add.className = 'muted';
  add.style.cssText = 'margin-top:6px;font-size:11px;background:none;border:1px dashed #555;border-radius:4px;color:inherit;cursor:pointer;padding:1px 6px;opacity:.6';
  add.onclick = () => onBeginEdit();
  isolateStickyPointer(add);
  host.append(add);
  return null;
}
