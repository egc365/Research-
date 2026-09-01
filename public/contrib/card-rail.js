// Contribution: generic card collection UI. Two sources, one implementation:
//   config.source = 'blocks'      (default) one card per markdown block of the
//                                 selected document (content-addressed ids)
//   config.source = 'transcript'  the Revision Center workflow, ported: one
//                                 card per session statement/write from the
//                                 transcript index, with the All / Owner /
//                                 Agent / Wrote this file / Open filters
// Every card shows actor, sequence, provenance (line/ts/sha) where available,
// its latest decision and amendment rev. Clicking a card selects it for the
// amendment editor and decision controls; "where it came from ↗" jumps the
// dual-document view to the transcript event.
import { splitBlocks, cardId } from '/contrib/lib/blocks.js';

export function mount(el, ctx) {
  const source = ctx.config.source || 'blocks';
  let filter = 'all';
  let cards = [];        // normalized: {id, actor, kind, n, text, line, ts, sha, tags, wrote}
  let note = null;
  let decisions = {}, revisions = {}, revEntries = [];

  async function loadTranscript(f) {
    const s = await ctx.action('revision', 'sessions', { path: f.path });
    if (!s.sessions.length) { cards = []; note = s.note || 'No session in the transcript index touched this file.'; return; }
    const data = await ctx.action('revision', 'cards', { session: s.sessions[0].session, path: f.path });
    note = data.note || null;
    cards = (data.cards || []).map(c => ({
      id: c.card, actor: c.kind === 'user' ? 'owner' : 'agent', kind: c.kind,
      n: c.n, text: c.text, line: c.line, ts: c.ts, sha: c.sha256,
      tags: c.tags || [], wrote: !!c.wrote
    }));
  }

  async function loadBlocks(f) {
    const blocks = splitBlocks(f.content);
    cards = [];
    for (let i = 0; i < blocks.length; i++) {
      cards.push({ id: await cardId(i, blocks[i]), actor: 'document', kind: 'block',
        n: i + 1, text: blocks[i], line: null, ts: null, sha: null, tags: [], wrote: false });
    }
    note = null;
  }

  function passes(c) {
    if (filter === 'all') return true;
    if (filter === 'wrote') return c.wrote;
    if (filter === 'open') return !decisions[c.id];
    return c.actor === filter;
  }

  function paint() {
    const f = ctx.selection;
    if (!f) { el.innerHTML = '<div class="empty">Select a file to see its cards.</div>'; return; }
    const shown = cards.filter(passes);
    const chips = source === 'transcript'
      ? ['all', 'owner', 'agent', 'wrote', 'open'] : ['all', 'open'];
    const chipLabel = { all: 'All', owner: 'Owner', agent: 'Agent', wrote: 'Wrote this file', open: 'Open' };
    el.innerHTML = `
      <div class="card"><h3>Cards — ${shown.length} of ${cards.length}</h3>
        <div class="chip-row">${chips.map(c =>
          `<button data-chip="${c}" class="${filter === c ? 'active' : ''}">${chipLabel[c]}</button>`).join('')}</div>
        ${note ? `<div class="muted" style="margin:6px 0">${ctx.esc(note)}</div>` : ''}
        <div data-role="cards"></div>
      </div>`;
    el.querySelectorAll('[data-chip]').forEach(b => b.onclick = () => { filter = b.dataset.chip; paint(); });
    const host = el.querySelector('[data-role="cards"]');
    if (!cards.length && !note) host.innerHTML = '<div class="muted">Nothing to show as cards for this file.</div>';
    for (const c of shown) {
      const decision = decisions[c.id];
      const rev = revisions[c.id] || 0;
      const log = revEntries.filter(e => e.card === c.id).sort((a, b) => b.rev - a.rev);
      const latest = log[0];
      const box = document.createElement('div');
      box.className = 'block-card' + (ctx.card === c.id ? ' selected' : '') + (decision ? ' decided' : '');
      box.dataset.card = c.id;
      box.innerHTML = `
        <div class="meta">
          <span class="actor-ic">${c.actor === 'owner' ? 'O' : c.actor === 'agent' ? 'A' : '¶'}</span>
          <strong>#${c.n}</strong> ${ctx.esc(c.kind)}${rev ? ` · rev ${rev}` : ''}
          ${decision ? `<span class="badge ${decision === 'accept' ? 'validated' : 'working'}">${ctx.esc(decision)}</span>` : '<span class="badge">open</span>'}
        </div>
        ${c.tags.length ? `<div class="chipline">${c.tags.map(t => `<span>${ctx.esc(t)}</span>`).join('')}</div>` : ''}
        <div class="body mono">${ctx.esc((latest ? latest.body : c.text).slice(0, 400))}</div>
        <div class="meta muted">
          ${c.line != null ? `line ${c.line} · ` : ''}${c.ts ? `${ctx.esc(c.ts)} · ` : ''}${c.sha ? `sha ${ctx.esc(c.sha)} · ` : ''}
          <span class="mono">${ctx.esc(c.id.slice(0, 24))}</span>
          ${source === 'transcript' ? ` <a href="#" data-goto="${c.n}">where it came from ↗</a>` : ''}
        </div>
        ${log.length ? `<div class="revlog muted">revision log — append only<br>${log.map(e =>
          `rev ${e.rev} · ${ctx.esc(e.created_at)} · ${ctx.esc(e.sha256.slice(0, 12))}${e.note ? ' · ' + ctx.esc(e.note) : ''}`).join('<br>')}</div>` : ''}`;
      box.onclick = event => {
        if (event.target.closest('a')) return;
        ctx.setCard(c.id);
        ctx.bus.emit('card-text', { card: c.id, text: latest ? latest.body : c.text, original: c.text });
      };
      box.querySelector('[data-goto]')?.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        ctx.bus.emit('goto-event', { n: c.n });
      });
      host.append(box);
    }
  }

  async function load() {
    const f = ctx.selection;
    if (!f) { paint(); return; }
    const [d, a] = await Promise.all([
      ctx.request(`/api/decisions?path=${encodeURIComponent(f.path)}`),
      ctx.request(`/api/amendments?path=${encodeURIComponent(f.path)}`)
    ]);
    decisions = d.latestByCard; revisions = a.latestRevByCard; revEntries = a.entries;
    if (source === 'transcript') await loadTranscript(f); else await loadBlocks(f);
    paint();
  }

  const reload = () => load().catch(e => ctx.notify(e.message, 'error'));
  ctx.bus.on('selection', reload);
  ctx.bus.on('file-saved', reload);
  ctx.bus.on('decision', reload);
  ctx.bus.on('amendment', reload);
  ctx.bus.on('card', () => {
    el.querySelectorAll('.block-card').forEach(node =>
      node.classList.toggle('selected', node.dataset.card === ctx.card));
  });
  reload();
}
