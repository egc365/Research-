// Contribution: narrow event views to one actor. Broadcasts 'actor-filter';
// views that care (the timeline) listen. Holds no data of its own.
export function mount(el, ctx) {
  const actors = ['all', 'human', 'agent', 'filesystem', 'validator'];
  el.innerHTML = `<div class="card">
    <div style="display:flex;gap:4px;flex-wrap:wrap">${actors.map(a =>
      `<button data-actor="${a}" class="${a === 'all' ? 'primary' : ''}">${a}</button>`).join('')}</div></div>`;
  el.querySelectorAll('button').forEach(button => {
    button.onclick = () => {
      el.querySelectorAll('button').forEach(b => b.classList.remove('primary'));
      button.classList.add('primary');
      ctx.bus.emit('actor-filter', button.dataset.actor === 'all' ? null : button.dataset.actor);
    };
  });
}
