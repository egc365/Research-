// Contribution: continuous block-aligned diff between the preserved (promoted)
// version and the working bytes.
import { alignBlocks } from '/contrib/lib/blocks.js';

export function mount(el, ctx) {
  async function paint() {
    const f = ctx.selection;
    if (!f) { el.innerHTML = '<div class="empty">Select a file to see its diff.</div>'; return; }
    const result = await ctx.action('diff', 'promoted-vs-current', { path: f.path, rootPath: ctx.workspace.root_path });
    if (!result.promoted) {
      el.innerHTML = '<div class="card"><h3>Continuous diff</h3><div class="muted">No promoted version yet — the whole file is new.</div></div>';
      return;
    }
    const promotedText = result.rows.filter(r => r.type !== 'add').map(r => r.text).join('\n');
    const rows = alignBlocks(promotedText, f.content);
    const changed = rows.filter(r => r.op !== 'eq').length;
    el.innerHTML = `<div class="card"><h3>Continuous diff — ${changed} changed block(s)</h3>
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
