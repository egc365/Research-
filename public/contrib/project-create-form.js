// Contribution: start a new project folder inside the workspace. The README
// is written through the governed write path, so the project is in the
// ledger from its first byte.
export function mount(el, ctx) {
  el.innerHTML = `
    <div class="card" style="max-width:520px;margin:24px auto"><h3>New project</h3>
      <div class="keyval"><div class="key">Workspace</div><div class="mono">${ctx.esc(ctx.workspace?.root_path || '—')}</div></div>
      <input data-role="name" placeholder="project-name (folder under the workspace)" style="width:100%;margin-top:8px">
      <textarea data-role="summary" rows="3" style="width:100%;margin-top:6px" placeholder="One-paragraph summary for the README"></textarea>
      <button data-role="create" class="primary" style="margin-top:8px">Create project</button>
      <div data-role="result" class="muted" style="margin-top:8px"></div>
    </div>`;
  el.querySelector('[data-role="create"]').onclick = async () => {
    const name = el.querySelector('[data-role="name"]').value.trim();
    const result = el.querySelector('[data-role="result"]');
    if (!ctx.workspace) return ctx.notify('Add a workspace first.', 'error');
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) { result.textContent = 'Project names: letters, digits, dot, dash, underscore.'; return; }
    const readmePath = `${ctx.workspace.root_path}/${name}/README.md`;
    const summary = el.querySelector('[data-role="summary"]').value.trim();
    try {
      const written = await ctx.request('/api/file', {
        method: 'PUT',
        body: JSON.stringify({
          rootPath: ctx.workspace.root_path, path: readmePath,
          content: `# ${name}\n\n${summary || 'Project created in Research Operations.'}\n`,
          actor: 'human'
        })
      });
      result.textContent = `Created ${readmePath} · sha256 ${written.checksum.slice(0, 12)}… · state ${written.artifact.state}`;
      ctx.notify(`Project ${name} created and registered.`, 'ok');
      ctx.bus.emit('artifact-changed', { path: readmePath, state: written.artifact.state });
      await ctx.selectFile(readmePath);
    } catch (error) {
      result.textContent = `${error.data?.error || 'ERROR'}: ${error.message}`;
    }
  };
}
