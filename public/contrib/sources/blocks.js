// Card source: the selected document as cards. config.source 'blocks' (the
// default) is one card per markdown block with a content-addressed id;
// 'transcript' is the Revision Center workflow, one card per session
// statement or write from the transcript index, with the All / Owner / Agent
// / Wrote this file / Open filters. Every card carries its latest decision
// and amendment rev; selecting one feeds the amendment editor and the
// decision controls, and "where it came from" jumps the dual-document view
// to the transcript event.
import { splitBlocks, cardId } from '../lib/blocks.js';

const CHIPS = { all: 'All', owner: 'Owner', agent: 'Agent', wrote: 'Wrote this file', open: 'Open' };

export function open(ctx, config) {
  const transcript = config.source === 'transcript';
  const chipIds = transcript ? ['all', 'owner', 'agent', 'wrote', 'open'] : ['all', 'open'];
  let filter = 'all';
  let rows = []; // {id, actor, kind, n, text, line, ts, sha, tags, wrote}
  let note = null;
  let decisions = {}, revisions = {}, revEntries = [];

  async function loadTranscript(f) {
    const s = await ctx.action('revision', 'sessions', { path: f.path });
    if (!s.sessions.length) { rows = []; note = s.note || 'No session in the transcript index touched this file.'; return; }
    const data = await ctx.action('revision', 'cards', { session: s.sessions[0].session, path: f.path });
    note = data.note || null;
    rows = (data.cards || []).map(c => ({
      id: c.card, actor: c.kind === 'user' ? 'owner' : 'agent', kind: c.kind,
      n: c.n, text: c.text, line: c.line, ts: c.ts, sha: c.sha256,
      tags: c.tags || [], wrote: !!c.wrote
    }));
  }

  async function loadBlocks(f) {
    const blocks = splitBlocks(f.content);
    rows = [];
    for (let i = 0; i < blocks.length; i++) {
      rows.push({ id: await cardId(i, blocks[i]), actor: 'document', kind: 'block',
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

  const latestOf = c => revEntries.filter(e => e.card === c.id).sort((a, b) => b.rev - a.rev);
  const currentText = c => { const latest = latestOf(c)[0]; return latest ? latest.body : c.text; };

  function toCard(c) {
    const decision = decisions[c.id];
    const rev = revisions[c.id] || 0;
    const log = latestOf(c);
    const provenance = [
      c.line != null ? `line ${c.line}` : '',
      c.ts || '',
      c.sha ? `sha ${c.sha}` : ''
    ].filter(Boolean).join(' · ');
    const foot = [];
    if (provenance) foot.push(provenance);
    if (transcript) foot.push({ text: 'where it came from ↗', act: () => ctx.bus.emit('goto-event', { n: c.n }) });
    if (log.length) {
      foot.push('revision log, append only');
      for (const e of log) foot.push(`rev ${e.rev} · ${e.created_at} · ${e.sha256.slice(0, 12)}${e.note ? ' · ' + e.note : ''}`);
    }
    return {
      id: c.id,
      kind: 'block',
      ref: c.id,
      path: null,
      head: c.id.slice(0, 24),
      title: `#${c.n} ${c.kind}${rev ? ` · rev ${rev}` : ''}`,
      body: currentText(c).slice(0, 400),
      text: currentText(c),
      color: null,
      face: null,
      icon: c.actor === 'owner' ? 'O' : c.actor === 'agent' ? 'A' : '¶',
      fields: [],
      tags: c.tags.map(label => ({ label, color: null })),
      image: null,
      width: null,
      missing: false,
      badges: [decision ? { text: decision, cls: decision === 'accept' ? 'validated' : 'working' } : { text: 'open', cls: '' }],
      foot
    };
  }

  async function load() {
    const f = ctx.selection;
    if (!f) return { groups: [], note: null, empty: 'Select a file to see its cards.' };
    const [d, a] = await Promise.all([
      ctx.request(`/api/decisions?path=${encodeURIComponent(f.path)}`),
      ctx.request(`/api/amendments?path=${encodeURIComponent(f.path)}`)
    ]);
    decisions = d.latestByCard; revisions = a.latestRevByCard; revEntries = a.entries;
    if (transcript) await loadTranscript(f); else await loadBlocks(f);
    return shown();
  }

  function shown() {
    const cards = rows.filter(passes).map(toCard);
    return {
      groups: [{ title: '', cards }],
      note: [`${cards.length} of ${rows.length}`, note].filter(Boolean).join(' · '),
      chips: chipIds.map(id => ({ id, label: CHIPS[id], active: filter === id })),
      empty: note ? '' : 'Nothing to show as cards for this file.'
    };
  }

  return {
    name: 'Block cards',
    events: ['selection', 'file-saved', 'decision', 'amendment'],
    marks: ['card'],
    labels: false,
    selected: () => ctx.card,
    editing: () => false,
    load,
    filter(id) { filter = id; return shown(); },
    select(card) {
      const c = rows.find(r => r.id === card.id);
      ctx.setCard(card.id);
      ctx.bus.emit('card-text', { card: card.id, text: currentText(c), original: c.text });
    }
  };
}
