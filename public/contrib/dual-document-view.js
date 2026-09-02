// Contribution: the Revision Center's dual-document presentation, ported.
// Preserved (base) beside New (working), split into markdown blocks, aligned,
// each block marked eq / ins / del / chg. Modes: Preserved | New, Original
// document, Session transcript (from the revision service's transcript index,
// which degrades honestly when unavailable). Where the base comes from is the
// revision service's business (git HEAD, else promoted bytes); pass
// config.base = 'promoted' to force the registry's promoted version — that is
// how the Validation Center reuses this exact contribution.
import { alignBlocks, renderBlock } from '/contrib/lib/blocks.js';

export function mount(el, ctx) {
  let doc = null;       // revision service 'open' payload
  // The diff reads split (Preserved | New) or unified — owner's choice, and
  // the choice sticks per browser.
  let mode = 'dual';
  try { if (localStorage.getItem('ro.diffMode') === 'unified') mode = 'unified'; } catch { /* storage may be unavailable */ }
  let sessions = [];    // transcript sessions for this path
  let sessionNote = null;
  let session = null;   // picked session id
  let events = [];
  let editing = false;  // the New pane swapped for a governed textarea
  let draft = null;     // typed-but-unsaved working text; survives repaints
  let editPath = null;  // path the open edit belongs to

  const escape = ctx.esc;
  const editDirty = () => editing && draft != null && draft !== (doc?.working?.text ?? '');

  async function load() {
    doc = null; sessions = []; session = null; events = []; sessionNote = null;
    if (!ctx.selection) return;
    doc = await ctx.action('revision', 'open', {
      path: ctx.selection.path, rootPath: ctx.workspace?.root_path,
      preferBase: ctx.config.base || 'auto'
    });
    const s = await ctx.action('revision', 'sessions', { path: ctx.selection.path });
    sessions = s.sessions || [];
    sessionNote = s.note || null;
    if (sessions.length) await pickSession(sessions[0].session);
  }

  async function pickSession(sid) {
    session = sid;
    const data = await ctx.action('revision', 'events', { session: sid, path: ctx.selection.path });
    events = data.events || [];
    if (mode === 'transcript') paint();
  }

  function header() {
    return `<div class="dual-tabs">
      <button data-mode="dual" class="${mode === 'dual' ? 'active' : ''}">Preserved | New</button>
      <button data-mode="unified" class="${mode === 'unified' ? 'active' : ''}">Unified</button>
      <button data-mode="original" class="${mode === 'original' ? 'active' : ''}">Original document</button>
      <button data-mode="transcript" class="${mode === 'transcript' ? 'active' : ''}">Session transcript</button>
    </div>`;
  }

  function paintDual(host) {
    const rows = alignBlocks(doc.base.text, doc.working.text);
    const counts = { eq: 0, ins: 0, del: 0, chg: 0 };
    for (const row of rows) counts[row.op]++;
    let left = '', right = '';
    rows.forEach((row, i) => {
      const cls = row.op === 'eq' ? '' : row.op;
      left += `<div class="blk ${cls}${row.left == null ? ' gap' : ''}" data-blk="${i}">${row.left == null ? '&nbsp;' : renderBlock(row.left)}</div>`;
      right += `<div class="blk ${cls}${row.right == null ? ' gap' : ''}" data-blk="${i}">${row.right == null ? '&nbsp;' : renderBlock(row.right)}</div>`;
    });
    host.innerHTML = `
      <div class="muted" style="margin-bottom:6px">blocks: ${counts.eq} same, ${counts.ins} added, ${counts.del} removed, ${counts.chg} changed</div>
      <div class="dual">
        <div><div class="pane-label"><span>PRESERVED — ${escape(doc.base.from)}</span>
          <span class="mono">${escape((doc.base.sha256 || '').slice(0, 12))}</span></div>
          <div class="doc-col" data-col="left">${left || '<div class="empty">The preserved side is empty.</div>'}</div></div>
        <div><div class="pane-label"><span>NEW — ${escape(doc.working.from)}</span>
          <span class="pane-actions"><span class="mono">${escape(doc.working.sha256.slice(0, 12))}</span>
            ${!ctx.selection ? '' : editing
              ? `<button data-role="save-working" class="primary">Save</button>
                 <button data-role="cancel-working">Cancel</button>`
              : `<button data-role="edit-working" title="Edit the working document in place">✎ Edit</button>`}
          </span></div>
          ${editing
            ? `<div data-role="conflict" hidden></div>
               <textarea data-role="working-edit" class="working-edit" spellcheck="false"></textarea>`
            : `<div class="doc-col" data-col="right">${right}</div>`}</div>
      </div>`;
    host.dataset.rows = JSON.stringify(rows.map(r => r.right)); // for card highlighting
    if (editing) {
      const area = host.querySelector('[data-role="working-edit"]');
      area.value = draft ?? doc.working.text;
      area.oninput = () => { draft = area.value; };
      host.querySelector('[data-role="save-working"]').onclick = () => saveWorking(host, area);
      host.querySelector('[data-role="cancel-working"]').onclick = () => {
        if (editDirty() && !confirm('Discard unsaved changes?')) return;
        editing = false; draft = null; editPath = null;
        paint();
      };
    } else if (ctx.selection) {
      host.querySelector('[data-role="edit-working"]').onclick = () => {
        editing = true; draft = null; editPath = ctx.selection.path;
        paint();
      };
    }
  }

  // Governed save of the edited working text: same checksum-guarded PUT the
  // markdown editor uses. A stale base (the file changed under this edit) is
  // a frozen-reference conflict — both SHAs shown, nothing overwritten.
  async function saveWorking(host, area) {
    try {
      await ctx.saveFile(area.value);
      editing = false; draft = null; editPath = null;
      reload();
    } catch (error) {
      if (error.data?.error === 'STALE_BASE') {
        const box = host.querySelector('[data-role="conflict"]');
        box.hidden = false;
        box.innerHTML = `
          <div class="conflict">
            <strong>Frozen base conflict.</strong> The file changed since you loaded it — saving now would overwrite someone else's bytes.
            <div class="keyval mono"><div class="key">your base</div><div>${escape(error.data.expected)}</div></div>
            <div class="keyval mono"><div class="key">on disk</div><div>${escape(error.data.actual)}</div></div>
            <button data-role="reload-disk">Load the disk version (discards this edit)</button>
          </div>`;
        box.querySelector('[data-role="reload-disk"]').onclick = async () => {
          editing = false; draft = null; editPath = null;
          await ctx.refreshSelection();
        };
      } else {
        ctx.notify(`${error.data?.error || 'ERROR'}: ${error.message}`, 'error');
        if (error.data?.preflight) alert(`${error.message}\n\n${JSON.stringify(error.data.preflight, null, 2)}`);
      }
    }
  }

  // One column, changes in reading order: a changed block shows its removed
  // text then its added text — the same rows the split view aligns.
  function paintUnified(host) {
    const rows = alignBlocks(doc.base.text, doc.working.text);
    const counts = { eq: 0, ins: 0, del: 0, chg: 0 };
    for (const row of rows) counts[row.op]++;
    let out = '';
    for (const row of rows) {
      if (row.op === 'chg') {
        out += `<div class="blk del">${renderBlock(row.left)}</div><div class="blk ins">${renderBlock(row.right)}</div>`;
      } else if (row.op === 'del') {
        out += `<div class="blk del">${renderBlock(row.left)}</div>`;
      } else {
        out += `<div class="blk ${row.op === 'ins' ? 'ins' : ''}">${renderBlock(row.right)}</div>`;
      }
    }
    host.innerHTML = `
      <div class="muted" style="margin-bottom:6px">blocks: ${counts.eq} same, ${counts.ins} added, ${counts.del} removed, ${counts.chg} changed</div>
      <div class="pane-label"><span>UNIFIED — ${escape(doc.base.from)} → ${escape(doc.working.from)}</span>
        <span class="mono">${escape(doc.working.sha256.slice(0, 12))}</span></div>
      <div class="doc-col">${out || '<div class="empty">Both sides are empty.</div>'}</div>`;
  }

  function paintOriginal(host) {
    if (!doc.hasBase) {
      host.innerHTML = `<div class="empty">There is no preserved version of this file on its own — ${escape(doc.base.from)}.</div>`;
      return;
    }
    host.innerHTML = `<div class="pane-label"><span>ORIGINAL — ${escape(doc.base.from)}</span></div>
      <div class="doc-col">${alignBlocks(doc.base.text, '').map(r => r.left == null ? '' : `<div class="blk">${renderBlock(r.left)}</div>`).join('')}</div>`;
  }

  function paintTranscript(host) {
    if (!sessions.length) {
      host.innerHTML = `<div class="empty">${escape(sessionNote || 'No transcript in the index names this file in a Write or Edit call.')}</div>`;
      return;
    }
    const picker = sessions.length > 1
      ? `<div style="margin-bottom:8px">sessions that touched this file: ` + sessions.map(s =>
          `<a href="#" data-sess="${escape(s.session)}" style="margin-right:8px">${escape(s.session.slice(0, 8))}${s.wrote ? ` (wrote ×${s.wrote})` : ` (mentioned ×${s.mentioned})`}</a>`).join('') + '</div>'
      : '';
    host.innerHTML = picker + events.map(e => `
      <div class="ev ${escape(e.kind)}${e.wrote ? ' wrote' : ''}" id="ev-${e.n}">
        <div class="muted"><b>#${e.n}</b> ${escape(e.kind)} · line ${e.line} · ${escape(e.ts)} · sha ${escape(e.sha256)}
          ${e.wrote ? ' · <span class="ok">WROTE THIS FILE</span>' : ''}</div>
        <pre>${escape(e.text.slice(0, 4000))}${e.truncated ? '\n… (truncated)' : ''}</pre>
      </div>`).join('') || '<div class="empty">This session has no visible events.</div>';
    host.querySelectorAll('[data-sess]').forEach(a => a.onclick = event => {
      event.preventDefault();
      pickSession(a.dataset.sess).catch(e => ctx.notify(e.message, 'error'));
    });
  }

  function paint() {
    if (!ctx.selection) { el.innerHTML = '<div class="empty">Select a file to review it.</div>'; return; }
    if (!doc) { el.innerHTML = '<div class="empty">Reading…</div>'; return; }
    if (!doc.supported) {
      el.innerHTML = `<div class="card"><h3>${escape(ctx.selection.path.split('/').pop())}</h3>
        <div class="muted">${escape(doc.note)}</div></div>`;
      return;
    }
    el.innerHTML = header() + '<div data-role="pane"></div>';
    el.querySelectorAll('[data-mode]').forEach(button => button.onclick = () => {
      mode = button.dataset.mode;
      if (mode === 'dual' || mode === 'unified') {
        try { localStorage.setItem('ro.diffMode', mode); } catch { /* storage may be unavailable */ }
      }
      paint();
    });
    const pane = el.querySelector('[data-role="pane"]');
    if (mode === 'dual') paintDual(pane);
    else if (mode === 'unified') paintUnified(pane);
    else if (mode === 'original') paintOriginal(pane);
    else paintTranscript(pane);
  }

  // A selected card lights the New-side blocks its text literally contains
  // (exact substring only, same rule as the Revision Center — no guessing).
  function highlightFrom(cardText) {
    const pane = el.querySelector('[data-role="pane"]');
    if (!pane || mode !== 'dual' || !cardText) return;
    el.querySelectorAll('.blk.from').forEach(x => x.classList.remove('from'));
    let rows;
    try { rows = JSON.parse(pane.dataset.rows || '[]'); } catch { return; }
    let first = null;
    rows.forEach((rightText, i) => {
      if (!rightText || rightText.length < 24) return;
      if (cardText.indexOf(rightText) >= 0) {
        pane.querySelectorAll(`[data-col="right"] .blk[data-blk="${i}"]`).forEach(node => {
          node.classList.add('from');
          if (!first) first = node;
        });
      }
    });
    if (first) first.scrollIntoView({ block: 'center' });
  }

  const reload = () => {
    // Never rebuild over an unsaved working edit — the checksum guard catches
    // any divergence at save time instead.
    if (editDirty()) return;
    paint();
    load().then(paint).catch(e => ctx.notify(e.message, 'error'));
  };
  ctx.onDirty(editDirty);
  ctx.bus.on('selection', () => {
    // Switching files closes the editor (same behavior as markdown-editor);
    // a same-path refresh with a dirty draft is skipped by the reload guard.
    if (editing && ctx.selection?.path !== editPath) { editing = false; draft = null; editPath = null; }
    reload();
  });
  ctx.bus.on('file-saved', reload);
  ctx.bus.on('card-text', ({ original, text }) => highlightFrom(original || text));
  ctx.bus.on('goto-event', ({ n }) => {
    mode = 'transcript';
    paint();
    const target = el.querySelector(`#ev-${n}`);
    if (target) { target.classList.add('from'); target.scrollIntoView({ block: 'center' }); }
  });
  reload();
}
