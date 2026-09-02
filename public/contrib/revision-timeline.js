// Contribution: amendments and ledger events for the selected file, newest
// first. Honors the shared actor filter when one is active.
export function mount(el, ctx) {
  let actor = null;
  async function paint() {
    const f = ctx.selection;
    if (!f) { el.innerHTML = '<div class="empty">Select a file to see its timeline.</div>'; return; }
    const [events, amendments] = await Promise.all([
      ctx.action('history', 'list', { path: f.path, limit: 200 }),
      ctx.request(`/api/amendments?path=${encodeURIComponent(f.path)}`)
    ]);
    const items = [
      ...events.map(e => ({
        at: e.created_at, actor: e.actor,
        text: `${e.event_type}${e.to_state ? ` → ${e.to_state}` : ''}${e.run_id ? ` · run ${e.run_id}` : ''}`
      })),
      ...amendments.entries.map(a => ({
        at: a.created_at, actor: a.actor,
        text: `AMENDMENT rev ${a.rev} on ${a.card || 'document'}${a.note ? ` — ${a.note}` : ''}`
      }))
    ].filter(item => !actor || item.actor === actor)
     .sort((a, b) => b.at.localeCompare(a.at));
    el.innerHTML = `<div class="card">${actor ? `<div class="muted">actor: ${ctx.esc(actor)} · ${items.length}</div>` : `<div class="muted">${items.length}</div>`}
      <div data-role="items"></div></div>`;
    const host = el.querySelector('[data-role="items"]');
    for (const item of items.slice(0, 100)) {
      const div = document.createElement('div');
      div.className = 'timeline-item';
      div.innerHTML = `<div>${ctx.esc(item.text)} <span class="muted">· ${ctx.esc(item.actor)}</span></div>
        <div class="when mono">${ctx.esc(item.at)}</div>`;
      host.append(div);
    }
    if (!items.length) host.innerHTML = '<div class="muted">Nothing recorded yet.</div>';
  }
  const repaint = () => paint().catch(e => ctx.notify(e.message, 'error'));
  ctx.bus.on('selection', repaint);
  ctx.bus.on('file-saved', repaint);
  ctx.bus.on('amendment', repaint);
  ctx.bus.on('decision', repaint);
  ctx.bus.on('actor-filter', value => { actor = value; repaint(); });
  return repaint();
}
