// Sticky-note rendering, shared by the card view's faces and sources. The
// palette is defined here and imported by plugins/server/stickies.mjs (the
// server refuses anything off it), so a note can never render in an
// unreadable color. Red, yellow, green first; pink stays so stored rows
// still match a swatch.
export const STICKY_COLORS = ['#ff7675', '#f6e58d', '#badc58', '#7ed6df', '#e6a8f7', '#ffbe76', '#ffb8b8'];
const STICKY_TITLES = ['red', 'yellow', 'green', 'cyan', 'purple', 'orange', 'pink'];
export const DEFAULT_STICKY_COLOR = '#f6e58d';

// A stable "color by function": the same label always yields the same sticky
// color, so folders sharing a function share a look without any rules engine.
export function colorForLabel(label) {
  if (!label) return DEFAULT_STICKY_COLOR;
  let h = 0;
  for (const ch of String(label)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return STICKY_COLORS[h % STICKY_COLORS.length];
}

export function styleSticky(el, color) {
  el.style.cssText += `;background:${color || DEFAULT_STICKY_COLOR};color:#222;border:none;border-radius:2px;` +
    'box-shadow:1px 2px 4px rgba(0,0,0,.45);padding:8px 10px;font-size:13px;line-height:1.35;' +
    'white-space:pre-wrap;word-break:break-word';
}

// A row of palette dots; clicking one reports the color. Clicking the dot of
// the current color reports null (clear back to default).
export function paletteEl(current, onPick) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:4px;padding:2px 0';
  for (let i = 0; i < STICKY_COLORS.length; i++) {
    const color = STICKY_COLORS[i];
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.title = STICKY_TITLES[i];
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
