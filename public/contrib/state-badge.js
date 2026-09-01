// Contribution: the lifecycle state of the selected file and its allowed
// next states, from the same transition table the server enforces. With
// config.openIn = ['revision-center', ...] it also offers to open the
// selected file in another enabled station — navigation, not duplication.
const transitions = {
  working: ['candidate', 'archived'],
  candidate: ['working', 'validated', 'archived'],
  validated: ['candidate', 'promoted', 'archived'],
  promoted: ['superseded', 'archived'],
  superseded: ['archived'],
  archived: []
};
const pretty = id => id.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

export function mount(el, ctx) {
  function paint() {
    const f = ctx.selection;
    if (!f) { el.innerHTML = '<div class="empty">Select a file to see its state.</div>'; return; }
    const state = f.artifact?.state || 'working';
    const openIn = ctx.config.openIn || [];
    el.innerHTML = `<div class="card"><h3>Lifecycle</h3>
      <div><span class="badge ${ctx.esc(state)}">${ctx.esc(state)}</span></div>
      <div class="muted" style="margin-top:6px">Can become: ${(transitions[state] || []).join(', ') || 'nothing — terminal state'}</div>
      ${openIn.length ? '<div data-role="open" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"></div>' : ''}
    </div>`;
    const host = el.querySelector('[data-role="open"]');
    if (host) for (const stationId of openIn) {
      const button = document.createElement('button');
      button.textContent = `Open in ${pretty(stationId)}`;
      button.onclick = () => ctx.activateStation(stationId);
      host.append(button);
    }
  }
  ctx.bus.on('selection', paint);
  ctx.bus.on('file-saved', paint);
  ctx.bus.on('artifact-changed', paint);
  paint();
}
