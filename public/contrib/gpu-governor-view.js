// Contribution: GPU governor board — a read-only window onto the gpu-governor
// daemon via the gpu-governor service. Cards: current snapshot (mode, budget,
// per-process rows rendered defensively from whatever keys latest.json holds),
// allowlist rules + which path is live (new config path vs legacy fallback),
// and the tail of the enforcement event log, newest first. Enforcement verbs
// (STOP buttons, pause) deliberately stay on the daemon's own :7890 dashboard.
const VERDICT_COLORS = {
  allowed: 'background:#1d3a24;color:#7fd794',
  over_cap: 'background:#3a301d;color:#e0c48f',
  not_allowlisted: 'background:#3a1d1d;color:#e08f8f',
  unknown: 'background:#2a2a2a;color:#aaa'
};

export function mount(el, ctx) {
  let timer = null;
  let disposed = false;

  const badge = (text, style) => `<span class="state-badge" style="${style}">${ctx.esc(String(text))}</span>`;
  const mib = value => Number.isFinite(Number(value)) ? `${Number(value).toLocaleString()} MiB` : ctx.esc(String(value ?? '?'));

  function snapshotCard(status) {
    const snap = status.latest;
    if (!snap) {
      return `<div class="card"><h3>GPU snapshot</h3>
        <div class="muted">latest.json ${ctx.esc(status.latestError || 'unavailable')} — is the governor unit running?</div></div>`;
    }
    const mode = String(snap.mode ?? '?');
    const modeStyle = mode === 'enforce' && !snap.paused ? VERDICT_COLORS.allowed : VERDICT_COLORS.over_cap;
    const headline = [
      badge(snap.paused ? 'PAUSED' : mode, modeStyle),
      Number.isFinite(Number(snap.total_mib)) ? `total <b>${mib(snap.total_mib)}</b>` : '',
      Number.isFinite(Number(snap.budget_mib)) ? `budget ${mib(snap.budget_mib)}` : '',
      snap.host_used_gib != null ? `host ${ctx.esc(String(snap.host_used_gib))} / ${ctx.esc(String(snap.host_cap_gib ?? '?'))} GiB` : '',
      snap.at ? `<span class="muted">at ${ctx.esc(String(snap.at))}</span>` : ''
    ].filter(Boolean).join(' · ');
    const procs = Array.isArray(snap.procs) ? snap.procs : [];
    const procRow = p => {
      const verdict = String(p?.verdict ?? 'unknown');
      // Render whatever keys exist; never assume a fixed proc shape.
      const detail = [
        p?.mib != null ? mib(p.mib) : '',
        badge(verdict, VERDICT_COLORS[verdict] || VERDICT_COLORS.unknown),
        p?.essential ? badge('essential', 'background:#1d2a3a;color:#8fb8e0') : '',
        p?.why ? `<span class="muted">${ctx.esc(String(p.why))}</span>` : '',
        p?.unit ? `<span class="mono muted">${ctx.esc(String(p.unit))}</span>` : ''
      ].filter(Boolean).join(' ');
      const cmd = String(p?.cmd || p?.name || '');
      return `<div class="keyval">
        <div class="key">pid ${ctx.esc(String(p?.pid ?? '?'))}</div>
        <div>${detail}${cmd ? `<div class="mono muted" style="font-size:11px;overflow-wrap:anywhere">${ctx.esc(cmd.slice(0, 220))}</div>` : ''}</div>
      </div>`;
    };
    return `<div class="card">
      <h3>GPU snapshot</h3>
      <div style="margin-bottom:6px">${headline}</div>
      ${procs.map(procRow).join('') || '<div class="muted">Nothing on the GPU.</div>'}
    </div>`;
  }

  function rulesCard(status) {
    const source = status.allowlistSource === 'new' ? 'new path (governor config/)'
      : status.allowlistSource === 'legacy' ? 'legacy path (/wiki/config fallback)'
      : 'no allowlist file found';
    const rules = Array.isArray(status.rules?.rules) ? status.rules.rules : [];
    const ruleRow = r => `<div class="keyval">
      <div class="key mono" style="overflow-wrap:anywhere">${ctx.esc(String(r?.match ?? '?'))}</div>
      <div>${r?.max_mib != null ? `cap ${mib(r.max_mib)}` : 'no cap'}${r?.essential ? ' ' + badge('essential', 'background:#1d2a3a;color:#8fb8e0') : ''}${r?.note ? ` <span class="muted">${ctx.esc(String(r.note))}</span>` : ''}</div>
    </div>`;
    return `<div class="card">
      <h3>Allowlist</h3>
      <div style="margin-bottom:6px">${ctx.esc(source)}${status.allowlistPath ? ` · <span class="mono muted">${ctx.esc(status.allowlistPath)}</span>` : ''}</div>
      ${status.rules ? `
        <div class="muted" style="margin-bottom:4px">mode ${ctx.esc(String(status.rules.mode ?? '?'))} · budget ${status.rules.total_budget_mib != null ? mib(status.rules.total_budget_mib) : '?'}</div>
        ${rules.map(ruleRow).join('') || '<div class="muted">No rules.</div>'}`
      : `<div class="muted">Rules unreadable: ${ctx.esc(String(status.rulesError || 'missing'))}</div>`}
    </div>`;
  }

  function eventsCard(status) {
    const events = Array.isArray(status.events) ? status.events : null;
    const row = e => `<div class="keyval">
      <div class="key muted">${ctx.esc(String(e?.at || '').slice(11, 19))}</div>
      <div>${badge(String(e?.action ?? '?'), e?.action === 'would_kill' ? VERDICT_COLORS.over_cap : VERDICT_COLORS.not_allowlisted)}
        pid ${ctx.esc(String(e?.pid ?? '?'))}${e?.mib != null ? ` · ${mib(e.mib)}` : ''}
        ${e?.why ? `<span class="muted">${ctx.esc(String(e.why).slice(0, 120))}</span>` : ''}
        ${e?.cmd ? `<div class="mono muted" style="font-size:11px;overflow-wrap:anywhere">${ctx.esc(String(e.cmd).slice(0, 160))}</div>` : ''}</div>
    </div>`;
    return `<div class="card">
      <h3>Recent events <span class="muted" style="font-weight:normal">newest first · last ${status.eventLimit}</span></h3>
      ${events === null ? '<div class="muted">events.jsonl not readable.</div>'
        : events.map(row).join('') || '<div class="muted">No events logged.</div>'}
    </div>`;
  }

  async function paint() {
    const limit = Number(ctx.config?.eventLimit) || 20;
    const status = await ctx.action('gpu-governor', 'status', { limit });
    if (disposed) return;
    el.innerHTML = `
      <div class="card">
        <div class="muted">checked ${ctx.esc(status.checkedAt.slice(11, 19))}Z ·
          <a href="#" data-role="refresh">refresh</a> ·
          <a href="${ctx.esc(status.dashboardUrl)}" target="_blank" rel="noopener">open :7890 dashboard</a></div>
        <div class="muted">Read-only window onto the governor daemon. STOP / pause controls live on the :7890 dashboard.</div>
      </div>
      ${snapshotCard(status)}
      ${rulesCard(status)}
      ${eventsCard(status)}`;
    el.querySelector('[data-role="refresh"]').onclick = event => { event.preventDefault(); repaint(); };
  }

  const repaint = () => paint().catch(error => { if (!disposed) el.innerHTML = `<div class="muted">GPU governor view failed: ${ctx.esc(error.message)}</div>`; });
  timer = setInterval(repaint, 30000);
  repaint();
  return () => { disposed = true; clearInterval(timer); };
}
