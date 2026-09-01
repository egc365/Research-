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

// Stable card id for a block: its position plus a content fingerprint head,
// so a card survives reloads unchanged but changes identity when its text does.
export async function cardId(index, blockText) {
  const bytes = new TextEncoder().encode(blockText);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `b${index + 1}-${hex.slice(0, 12)}`;
}
