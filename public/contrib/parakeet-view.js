// Contribution: Parakeet STT status card. Up/down chip, model/config summary
// from the app's config.json, prettified raw status JSON, and owner-only
// start/stop listening buttons proxied through the parakeet-stt service.
export function mount(el, ctx) {
  let timer = null;
  let disposed = false;

  const chip = r => r.up
    ? '<span class="state-badge" style="background:#1d3a24;color:#7fd794">up</span>'
    : `<span class="state-badge" style="background:#3a1d1d;color:#e08f8f">down · ${ctx.esc(String(r.error || ''))}</span>`;

  async function paint() {
    const r = await ctx.action('parakeet-stt', 'status', {});
    if (disposed) return;
    const cfg = r.config || {};
    const listening = r.status?.listening === true;
    el.innerHTML = `
      <div class="card">
        <div>${chip(r)} <span class="muted">checked ${ctx.esc(String(r.checkedAt || '').slice(11, 19))}Z · <a href="#" data-role="refresh">refresh</a></span></div>
        <div class="keyval"><div class="key">URL</div><div class="mono muted">${ctx.esc(String(r.url || ''))}</div></div>
        ${Object.entries(cfg).map(([key, value]) => `
          <div class="keyval"><div class="key">${ctx.esc(key)}</div><div class="mono">${ctx.esc(String(value))}</div></div>`).join('')}
        ${r.up ? `<div class="keyval"><div class="key">listening</div><div>${listening ? 'yes' : 'no'}</div></div>` : ''}
        <div style="margin:8px 0">
          <button data-role="start" ${r.up ? '' : 'disabled'}>Start listening</button>
          <button data-role="stop" ${r.up ? '' : 'disabled'}>Stop listening</button>
          <span class="muted">owner surface only</span>
        </div>
        ${r.status ? `<details><summary class="muted">Raw status</summary><pre class="mono" style="overflow:auto;max-height:280px;font-size:11px">${ctx.esc(JSON.stringify(r.status, null, 2))}</pre></details>` : ''}
      </div>`;
    el.querySelector('[data-role="refresh"]').onclick = event => { event.preventDefault(); repaint(); };
    const toggle = action => () => {
      ctx.action('parakeet-stt', action, {}).then(result => {
        const body = result.response;
        if (body && body.ok === false) ctx.notify(`Parakeet: ${body.error || 'refused'}`, 'error');
        else ctx.notify(action === 'listen-start' ? 'Listening started.' : 'Listening stopped.', 'ok');
        repaint();
      }).catch(e => { ctx.notify(`${e.data?.error || e.code || 'ERROR'}: ${e.message}`, 'error'); });
    };
    el.querySelector('[data-role="start"]').onclick = toggle('listen-start');
    el.querySelector('[data-role="stop"]').onclick = toggle('listen-stop');
  }

  const repaint = () => paint().catch(error => { if (!disposed) el.innerHTML = `<div class="muted">Parakeet status failed: ${ctx.esc(error.message)}</div>`; });
  timer = setInterval(repaint, 15000);
  repaint();
  return () => { disposed = true; clearInterval(timer); };
}
