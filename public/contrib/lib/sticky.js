// Sticky-note rendering, shared by the board and the folder cards. The
// palette mirrors plugins/server/stickies.mjs (the server refuses anything
// off it), so a note can never render in an unreadable color.
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
