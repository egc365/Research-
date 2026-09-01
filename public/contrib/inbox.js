// Contribution: Inbox — what needs the owner. Candidates and validated
// artifacts waiting for a decision, then the last few registry events.
// Clicking a waiting row selects the file and jumps to the validation
// center (the kernel refuses gracefully when that station is not enabled).
export function mount(el, ctx) {
  async function paint() {
    if (!ctx.workspace) { el.innerHTML = '<div class="empty">No workspace.</div>'; return; }
    const rootPath = ctx.workspace.root_path;
    const [rows, recent] = await Promise.all([
      ctx.action('registry', 'list', { rootPath }),
      ctx.action('registry', 'recent', { rootPath, limit: 5 })
    ]);
    el.innerHTML = '<div class="card"><h3>Inbox</h3><div data-role="waiting"></div><div data-role="recent"></div></div>';

    const waiting = el.querySelector('[data-role="waiting"]');
    const pending = rows.filter(row => row.state === 'candidate')
      .concat(rows.filter(row => row.state === 'validated'));
    if (!pending.length) {
      waiting.innerHTML = '<div class="muted">Nothing waiting on you.</div>';
    } else {
      for (const row of pending) {
        const item = document.createElement('div');
        item.className = 'side-row';
        item.innerHTML = `
          <span class="grow" title="${ctx.esc(row.path)}">${ctx.esc(row.path.replace(rootPath + '/', ''))}</span>
          <span class="badge ${ctx.esc(row.state)}">${ctx.esc(row.state)}</span>
          <span class="aux mono">${ctx.esc((row.checksum || '').slice(0, 12))}</span>`;
        item.onclick = () => ctx.selectFile(row.path)
          .then(() => ctx.activateStation('validation-center'))
          .catch(e => ctx.notify(e.message, 'error'));
        waiting.append(item);
      }
    }

    const activity = el.querySelector('[data-role="recent"]');
    activity.innerHTML = '<div class="muted">Recent activity</div>';
    for (const event of (recent || []).slice(0, 5)) {
      const item = document.createElement('div');
      item.className = 'side-row';
      item.innerHTML = `
        <span class="grow">${ctx.esc((event.path || '').split('/').pop())}</span>
        <span class="aux">${ctx.esc(event.event_type + ' · ' + event.actor)}</span>`;
      item.onclick = () => ctx.selectFile(event.path).catch(e => ctx.notify(e.message, 'error'));
      activity.append(item);
    }
  }
  const repaint = () => paint().catch(e => ctx.notify(e.message, 'error'));
  ctx.bus.on('artifact-changed', repaint);
  ctx.bus.on('file-saved', repaint);
  ctx.bus.on('fs-changed', repaint);
  ctx.bus.on('workspace', repaint);
  repaint();
}
