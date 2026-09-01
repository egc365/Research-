// Contribution: governed editor. Saves go through the checksum-guarded write
// path; a stale base (the file changed under you) is a frozen-reference
// conflict — both SHAs are shown and nothing is overwritten silently.
export function mount(el, ctx) {
  let dirty = false;
  let conflict = null;
  el.innerHTML = `
    <div class="editor-area">
      <div class="editor-head">
        <div class="grow"><span data-role="name" class="mono">Select a file</span>
          <span data-role="meta" class="muted mono"></span></div>
        <span data-role="badge" class="badge">—</span>
        <button data-role="save" class="primary" disabled>Save</button>
      </div>
      <div data-role="conflict" hidden></div>
      <textarea data-role="text" spellcheck="false" disabled
        placeholder="Select a file in the tree to edit it here."></textarea>
    </div>`;
  const text = el.querySelector('[data-role="text"]');
  const name = el.querySelector('[data-role="name"]');
  const meta = el.querySelector('[data-role="meta"]');
  const badge = el.querySelector('[data-role="badge"]');
  const saveBtn = el.querySelector('[data-role="save"]');
  const conflictBox = el.querySelector('[data-role="conflict"]');

  function paint() {
    const f = ctx.selection;
    if (!f) { text.disabled = true; saveBtn.disabled = true; return; }
    name.textContent = f.path.split('/').pop();
    meta.textContent = ` · sha256 ${f.checksum.slice(0, 12)}…`;
    badge.textContent = f.artifact?.state || 'working';
    badge.className = `badge ${f.artifact?.state || 'working'}`;
    text.disabled = false;
    saveBtn.disabled = false;
    if (!dirty) text.value = f.content;
    conflictBox.hidden = !conflict;
  }

  async function save() {
    if (!ctx.selection) return;
    try {
      await ctx.saveFile(text.value);
      dirty = false;
      conflict = null;
      paint();
    } catch (error) {
      if (error.data?.error === 'STALE_BASE') {
        // Frozen-reference conflict: the base this edit froze is no longer
        // what is on disk. Show both identities; the owner chooses.
        conflict = error.data;
        conflictBox.innerHTML = `
          <div class="conflict">
            <strong>Frozen base conflict.</strong> The file changed since you loaded it — saving now would overwrite someone else's bytes.
            <div class="keyval mono"><div class="key">your base</div><div>${ctx.esc(error.data.expected)}</div></div>
            <div class="keyval mono"><div class="key">on disk</div><div>${ctx.esc(error.data.actual)}</div></div>
            <button data-role="reload">Load the disk version (discards this edit)</button>
          </div>`;
        conflictBox.hidden = false;
        conflictBox.querySelector('[data-role="reload"]').onclick = async () => {
          dirty = false; conflict = null;
          await ctx.refreshSelection();
        };
      } else {
        ctx.notify(`${error.data?.error || 'ERROR'}: ${error.message}`, 'error');
        if (error.data?.preflight) alert(`${error.message}\n\n${JSON.stringify(error.data.preflight, null, 2)}`);
      }
    }
  }

  // Notify only on the clean->dirty transition — a status write per keystroke
  // stomps meaningful messages and costs a DOM update per key.
  text.addEventListener('input', () => {
    if (!dirty) { dirty = true; ctx.notify('Unsaved working changes.'); }
  });
  saveBtn.onclick = save;
  const keyHandler = event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); }
  };
  window.addEventListener('keydown', keyHandler);
  ctx.onDirty(() => dirty);
  ctx.bus.on('selection', () => { dirty = false; conflict = null; paint(); });
  paint();
  return () => window.removeEventListener('keydown', keyHandler);
}
