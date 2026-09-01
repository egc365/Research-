// Contribution: the selected document as block cards. One card per markdown
// block; each shows its latest decision and amendment rev. Clicking a card
// selects it for the amendment editor and timeline.
import { splitBlocks, cardId } from '/contrib/lib/blocks.js';

export function mount(el, ctx) {
  async function paint() {
    const f = ctx.selection;
    if (!f) { el.innerHTML = '<div class="empty">Select a file to see its blocks.</div>'; return; }
    const blocks = splitBlocks(f.content);
    const [decisions, amendments] = await Promise.all([
      ctx.request(`/api/decisions?path=${encodeURIComponent(f.path)}`),
      ctx.request(`/api/amendments?path=${encodeURIComponent(f.path)}`)
    ]);
    el.innerHTML = `<div class="card"><h3>Blocks — ${blocks.length} card(s)</h3><div data-role="cards"></div></div>`;
    const host = el.querySelector('[data-role="cards"]');
    for (let i = 0; i < blocks.length; i++) {
      const id = await cardId(i, blocks[i]);
      const decision = decisions.latestByCard[id];
      const rev = amendments.latestRevByCard[id];
      const card = document.createElement('div');
      card.className = 'block-card' + (ctx.card === id ? ' selected' : '');
      card.dataset.card = id;
      const body = document.createElement('div');
      body.className = 'body mono';
      body.textContent = blocks[i];
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.innerHTML = `<span class="mono muted">${ctx.esc(id)}</span>
        ${decision ? `<span class="badge ${decision === 'accept' ? 'validated' : 'working'}">${ctx.esc(decision)}</span>` : ''}
        ${rev ? `<span class="muted">rev ${rev}</span>` : ''}`;
      card.append(body, meta);
      card.onclick = () => ctx.setCard(id);
      host.append(card);
    }
  }
  const repaint = () => paint().catch(e => ctx.notify(e.message, 'error'));
  ctx.bus.on('selection', repaint);
  ctx.bus.on('file-saved', repaint);
  ctx.bus.on('card', () => {
    el.querySelectorAll('.block-card').forEach(node =>
      node.classList.toggle('selected', node.dataset.card === ctx.card));
  });
  ctx.bus.on('decision', repaint);
  ctx.bus.on('amendment', repaint);
  return repaint();
}
