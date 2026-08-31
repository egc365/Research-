export async function render(ctx) {
  const panel = ctx.panel;
  if (!ctx.rootPath) {
    panel.innerHTML = '<div class="empty">Add a workspace to scan for moved files.</div>';
    return;
  }
  panel.innerHTML = '<div class="empty">Scanning for moved files…</div>';
  let proposals = [];
  try {
    proposals = await ctx.api('detect', { rootPath: ctx.rootPath });
  } catch (error) {
    panel.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    return;
  }
  if (!proposals.length) {
    panel.innerHTML = `
      <div class="card">
        <h3>Moved files</h3>
        <div class="muted">No registered files are missing from disk. Renames and moves are detected by matching the missing path's checksum against unregistered files.</div>
      </div>`;
    return;
  }
  panel.innerHTML = '<div class="card"><h3>Moved files</h3><div id="moveList"></div></div>';
  const list = panel.querySelector('#moveList');
  for (const proposal of proposals) {
    const row = document.createElement('div');
    row.className = 'card';
    row.innerHTML = `
      <div class="keyval"><div class="key">Was</div><div>${escapeHtml(proposal.fromPath)}</div></div>
      <div class="keyval"><div class="key">Now</div><div>${escapeHtml(proposal.toPath)}</div></div>
      <div class="keyval"><div class="key">State</div><div>${escapeHtml(proposal.state)}</div></div>
      <div class="actions"></div>`;
    const button = document.createElement('button');
    button.textContent = 'Accept remap';
    button.onclick = async () => {
      try {
        await ctx.api('apply', { rootPath: ctx.rootPath, fromPath: proposal.fromPath, toPath: proposal.toPath, actor: 'human' });
        ctx.notify('Move recorded; registry follows the file.');
        await ctx.rerender();
      } catch (error) { ctx.notify(error.message, 'error'); }
    };
    row.querySelector('.actions').append(button);
    list.append(row);
  }
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
