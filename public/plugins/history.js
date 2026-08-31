export async function render(ctx) {
  if (!ctx.file) { ctx.panel.innerHTML = '<div class="empty">Select a file to inspect history.</div>'; return; }
  const events = await ctx.api('list', { path:ctx.file.path, limit:100 });
  ctx.panel.innerHTML = `<div class="card"><h3>Append-only events</h3>${events.length ? events.map(event => `
    <div class="event">
      <div><strong>${escapeHtml(event.event_type)}</strong> ${event.from_state ? `${escapeHtml(event.from_state)} → ${escapeHtml(event.to_state)}` : ''}</div>
      <div class="muted">${escapeHtml(event.created_at)} · ${escapeHtml(event.actor)}${event.run_id ? ` · run ${escapeHtml(event.run_id)}` : ''}${event.span_id ? ` · span ${escapeHtml(event.span_id)}` : ''}</div>
    </div>`).join('') : '<div class="muted">No events yet.</div>'}</div>`;
}
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
