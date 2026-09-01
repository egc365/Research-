// Contribution: the validation queue as a card wall — registered artifacts
// grouped by lifecycle state, candidates and validated first. Each card shows
// path, state, current SHA, promoted SHA when one exists, last run/span and
// drift (promoted bytes that no longer match the disk). Clicking a card
// selects the file for every other mounted behavior.
const order = ['candidate', 'validated', 'working', 'promoted', 'superseded', 'archived'];

export function mount(el, ctx) {
  async function paint() {
    if (!ctx.workspace) { el.innerHTML = '<div class="empty">No workspace.</div>'; return; }
    const rows = await ctx.action('registry', 'list', { rootPath: ctx.workspace.root_path });
    el.innerHTML = '<div class="card"><h3>Validation queue</h3><div data-role="list"></div></div>';
    const host = el.querySelector('[data-role="list"]');
    if (!rows.length) { host.innerHTML = '<div class="muted">Nothing registered yet — open or create a file to register it.</div>'; return; }
    for (const state of order) {
      const group = rows.filter(row => row.state === state);
      if (!group.length) continue;
      const head = document.createElement('div');
      head.innerHTML = `<span class="badge ${ctx.esc(state)}" style="margin:6px 0">${ctx.esc(state)} · ${group.length}</span>`;
      host.append(head);
      for (const row of group) {
        const drifted = row.promoted_checksum && row.checksum !== row.promoted_checksum;
        const item = document.createElement('div');
        item.className = 'block-card queue-card' + (ctx.selection?.path === row.path ? ' selected' : '');
        item.dataset.path = row.path;
        item.innerHTML = `
          <div><strong>${ctx.esc(row.path.replace(ctx.workspace.root_path + '/', ''))}</strong>
            ${drifted ? '<span class="badge working" title="The bytes on disk no longer match the promoted SHA">drifted</span>' : ''}</div>
          <div class="meta muted mono">sha ${ctx.esc((row.checksum || '—').slice(0, 12))}${row.promoted_checksum ? ` · promoted ${ctx.esc(row.promoted_checksum.slice(0, 12))}` : ''}</div>
          <div class="meta muted">${row.last_run_id ? `run ${ctx.esc(row.last_run_id)} · ` : ''}${row.last_span_id ? `span ${ctx.esc(row.last_span_id)} · ` : ''}${ctx.esc(row.updated_at || '')}</div>`;
        item.onclick = () => ctx.selectFile(row.path).catch(e => ctx.notify(e.message, 'error'));
        host.append(item);
      }
    }
  }
  const repaint = () => paint().catch(e => ctx.notify(e.message, 'error'));
  ctx.bus.on('selection', () => {
    el.querySelectorAll('.queue-card').forEach(node =>
      node.classList.toggle('selected', node.dataset.path === ctx.selection?.path));
  });
  ctx.bus.on('file-saved', repaint);
  ctx.bus.on('artifact-changed', repaint);
  return repaint();
}
