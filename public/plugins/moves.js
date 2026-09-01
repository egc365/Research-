let activeJobId = null;
let pollTimer = null;

export async function render(ctx) {
  const panel = ctx.panel;
  clearInterval(pollTimer);
  if (!ctx.rootPath) {
    panel.innerHTML = '<div class="empty">Add a workspace to scan for moved files.</div>';
    return;
  }
  panel.innerHTML = `
    <div class="card">
      <h3>Find moved files</h3>
      <div class="muted">If a tracked file was renamed or moved outside this app, its registry entry points at a missing path. Scanning matches those missing entries to files on disk by content fingerprint so history can follow the file. The scan runs in the background — the app stays usable.</div>
      <div class="actions">
        <button id="scanStart" class="primary">Scan workspace</button>
        <button id="scanCancel" hidden>Cancel</button>
      </div>
      <div id="scanProgress" hidden>
        <div class="progress"><div id="scanBar" style="width:8%"></div></div>
        <div class="muted" id="scanText"></div>
      </div>
    </div>
    <div id="scanResults"></div>`;

  const startButton = panel.querySelector('#scanStart');
  const cancelButton = panel.querySelector('#scanCancel');
  const progress = panel.querySelector('#scanProgress');
  const scanText = panel.querySelector('#scanText');
  const bar = panel.querySelector('#scanBar');
  const results = panel.querySelector('#scanResults');

  const showStatus = status => {
    progress.hidden = false;
    scanText.textContent = `${status.state} · ${status.scanned} files checked` +
      (status.skippedLarge ? ` · ${status.skippedLarge} skipped (too large)` : '') +
      (status.truncated ? ' · stopped at file limit' : '');
    bar.style.width = status.state === 'running' ? `${Math.min(90, 10 + status.scanned / 50)}%` : '100%';
  };

  const showResults = status => {
    if (status.state !== 'done') {
      results.innerHTML = status.state === 'cancelled' ? '<div class="empty">Scan cancelled.</div>'
        : status.state === 'error' ? `<div class="empty">Scan failed: ${escapeHtml(status.error)}</div>` : '';
      return;
    }
    if (!status.missingCount) {
      results.innerHTML = '<div class="card"><div class="muted">No tracked files are missing from disk — nothing to rematch.</div></div>';
      return;
    }
    if (!status.proposals.length) {
      results.innerHTML = `<div class="card"><div class="muted">${status.missingCount} tracked file(s) are missing, but no matching content was found on disk.</div></div>`;
      return;
    }
    results.replaceChildren();
    for (const proposal of status.proposals) {
      const row = document.createElement('div');
      row.className = 'card';
      row.innerHTML = `
        <div class="keyval"><div class="key">Was</div><div>${escapeHtml(proposal.fromPath)}</div></div>
        <div class="keyval"><div class="key">Now</div><div>${escapeHtml(proposal.toPath)}</div></div>
        <div class="keyval"><div class="key">State</div><div>${escapeHtml(proposal.state)}</div></div>
        <div class="actions"></div>`;
      const accept = document.createElement('button');
      accept.textContent = 'Accept — history follows the file';
      accept.onclick = async () => {
        try {
          await ctx.api('apply', { rootPath: ctx.rootPath, fromPath: proposal.fromPath, toPath: proposal.toPath, actor: 'human' });
          ctx.notify('Move recorded; registry follows the file.');
          row.remove();
        } catch (error) { ctx.notify(error.message, 'error'); }
      };
      row.querySelector('.actions').append(accept);
      results.append(row);
    }
  };

  const poll = async () => {
    if (!activeJobId) return;
    try {
      const status = await ctx.api('scan-status', { jobId: activeJobId });
      showStatus(status);
      if (status.state !== 'running') {
        clearInterval(pollTimer);
        startButton.disabled = false;
        cancelButton.hidden = true;
        showResults(status);
      }
    } catch { clearInterval(pollTimer); }
  };

  startButton.onclick = async () => {
    try {
      const job = await ctx.api('scan-start', { rootPath: ctx.rootPath });
      activeJobId = job.jobId;
      startButton.disabled = true;
      cancelButton.hidden = false;
      results.innerHTML = '';
      showStatus(job);
      pollTimer = setInterval(poll, 400);
    } catch (error) { ctx.notify(error.message, 'error'); }
  };
  cancelButton.onclick = async () => {
    if (activeJobId) await ctx.api('scan-cancel', { jobId: activeJobId }).catch(() => {});
  };
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
