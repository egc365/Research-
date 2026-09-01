// Contribution: THE diff renderer — the one block-aligned diff implementation
// (lib/blocks.js alignBlocks) rendered as a single column with a compact
// summary. File Workbench, Revision Center and Validation Center all mount
// this same module; where the base comes from is the revision service's
// business (config.base = 'auto' → git HEAD, else promoted; 'promoted' forces
// the registry's frozen bytes).
import { alignBlocks } from '/contrib/lib/blocks.js';

export function mount(el, ctx) {
  async function paint() {
    const f = ctx.selection;
    if (!f) { el.innerHTML = '<div class="empty">Select a file to see its diff.</div>'; return; }
    const doc = await ctx.action('revision', 'open', {
      path: f.path, rootPath: ctx.workspace.root_path, preferBase: ctx.config.base || 'auto'
    });
    if (!doc.supported) {
      el.innerHTML = `<div class="card"><h3>Diff</h3><div class="muted">${ctx.esc(doc.note)}</div></div>`;
      return;
    }
    if (!doc.hasBase) {
      el.innerHTML = `<div class="card"><h3>Diff</h3><div class="muted">${ctx.esc(doc.base.from)} — the whole file counts as new.</div></div>`;
      return;
    }
    const rows = alignBlocks(doc.base.text, doc.working.text);
    const counts = { eq: 0, ins: 0, del: 0, chg: 0 };
    for (const row of rows) counts[row.op]++;
    el.innerHTML = `<div class="card"><h3>Diff vs ${ctx.esc(doc.base.from)}</h3>
      <div class="muted">${counts.eq} same · ${counts.ins} added · ${counts.del} removed · ${counts.chg} changed</div>
      <div data-role="rows"></div></div>`;
    const host = el.querySelector('[data-role="rows"]');
    for (const row of rows) {
      if (row.op === 'chg') {
        const d = document.createElement('div'); d.className = 'diff-block del'; d.textContent = row.left; host.append(d);
        const a = document.createElement('div'); a.className = 'diff-block ins'; a.textContent = row.right; host.append(a);
      } else {
        const div = document.createElement('div');
        div.className = `diff-block ${row.op}`;
        div.textContent = row.op === 'del' ? row.left : row.right;
        host.append(div);
      }
    }
  }
  ctx.bus.on('selection', () => paint().catch(e => ctx.notify(e.message, 'error')));
  ctx.bus.on('file-saved', () => paint().catch(e => ctx.notify(e.message, 'error')));
  return paint().catch(e => ctx.notify(e.message, 'error'));
}
