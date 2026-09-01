// Contribution: the lifecycle state of the selected file and its allowed
// next states, from the same transition table the server enforces.
const transitions = {
  working: ['candidate', 'archived'],
  candidate: ['working', 'validated', 'archived'],
  validated: ['candidate', 'promoted', 'archived'],
  promoted: ['superseded', 'archived'],
  superseded: ['archived'],
  archived: []
};
export function mount(el, ctx) {
  function paint() {
    const f = ctx.selection;
    if (!f) { el.innerHTML = '<div class="empty">Select a file to see its state.</div>'; return; }
    const state = f.artifact?.state || 'working';
    el.innerHTML = `<div class="card"><h3>Lifecycle</h3>
      <div><span class="badge ${ctx.esc(state)}">${ctx.esc(state)}</span></div>
      <div class="muted" style="margin-top:6px">Can become: ${(transitions[state] || []).join(', ') || 'nothing — terminal state'}</div>
    </div>`;
  }
  ctx.bus.on('selection', paint);
  ctx.bus.on('file-saved', paint);
  ctx.bus.on('artifact-changed', paint);
  paint();
}
