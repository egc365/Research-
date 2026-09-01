// Pure library shared by document contributions (not a contribution itself):
// markdown block splitting and block alignment. Coded once — dual-document-view,
// diff-renderer and card-rail all import from here.

// Markdown blocks: blank-line separated, fenced code kept in one piece.
// Same semantics as the revision center's split_blocks.
export function splitBlocks(text) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    if (lines[i].trimStart().startsWith('```')) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trimStart().startsWith('```')) j++;
      out.push(lines.slice(i, Math.min(j + 1, lines.length)).join('\n'));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].trim()) j++;
    out.push(lines.slice(i, j).join('\n'));
    i = j;
  }
  return out;
}

// Longest-common-subsequence alignment over two block lists.
// Ops: eq, ins, del, chg (a paired del+ins becomes chg).
export function alignBlocks(leftText, rightText) {
  const L = splitBlocks(leftText);
  const R = splitBlocks(rightText);
  const n = L.length, m = R.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = L[i] === R[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const rows = [];
  let i = 0, j = 0;
  const flush = (dels, inss) => {
    const paired = Math.min(dels.length, inss.length);
    for (let k = 0; k < paired; k++) rows.push({ op: 'chg', left: dels[k], right: inss[k] });
    for (let k = paired; k < dels.length; k++) rows.push({ op: 'del', left: dels[k], right: null });
    for (let k = paired; k < inss.length; k++) rows.push({ op: 'ins', left: null, right: inss[k] });
  };
  let dels = [], inss = [];
  while (i < n || j < m) {
    if (i < n && j < m && L[i] === R[j]) {
      flush(dels, inss); dels = []; inss = [];
      rows.push({ op: 'eq', left: L[i], right: R[j] });
      i++; j++;
    } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      inss.push(R[j]); j++;
    } else {
      dels.push(L[i]); i++;
    }
  }
  flush(dels, inss);
  return rows;
}

// Small markdown block renderer, ported from the Revision Center's browser
// side: headings, lists, tables, fenced code, rules, paragraphs. Enough to
// read a document; deliberately not a full markdown engine.
const escHtml = t => String(t ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(t) {
  return escHtml(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

export function renderBlock(src) {
  if (src == null) return '';
  const lines = src.split('\n');
  if (lines[0].trimStart().startsWith('```')) {
    const inner = lines.slice(1, lines[lines.length - 1].trimStart().startsWith('```')
      ? lines.length - 1 : lines.length);
    return '<pre>' + escHtml(inner.join('\n')) + '</pre>';
  }
  const h = /^(#{1,6})\s+(.*)$/.exec(lines[0]);
  if (h && lines.length === 1) {
    const level = Math.min(h[1].length, 3);
    return `<h${level}>` + inline(h[2]) + `</h${level}>`;
  }
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(lines[0].trim())) return '<hr>';
  if (lines.length > 1 && /^\s*\|/.test(lines[0]) && /^\s*\|?[\s:|-]+\|/.test(lines[1] || '')) {
    const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    let out = '<table><tr>' + cells(lines[0]).map(c => '<th>' + inline(c) + '</th>').join('') + '</tr>';
    for (let i = 2; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      out += '<tr>' + cells(lines[i]).map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>';
    }
    return out + '</table>';
  }
  if (lines.every(l => /^\s*([-*+]|\d+\.)\s+/.test(l))) {
    return '<ul>' + lines.map(l => '<li>' + inline(l.replace(/^\s*([-*+]|\d+\.)\s+/, '')) + '</li>').join('') + '</ul>';
  }
  const body = lines.map(l => {
    const hh = /^(#{1,6})\s+(.*)$/.exec(l);
    if (hh) { const level = Math.min(hh[1].length, 3); return `<h${level}>` + inline(hh[2]) + `</h${level}>`; }
    return inline(l);
  }).join('<br>');
  return '<p>' + body + '</p>';
}

// Stable card id for a block: its position plus a content fingerprint head,
// so a card survives reloads unchanged but changes identity when its text does.
export async function cardId(index, blockText) {
  const bytes = new TextEncoder().encode(blockText);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `b${index + 1}-${hex.slice(0, 12)}`;
}
