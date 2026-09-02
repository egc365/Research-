// Contribution: Inbox — only items that need the owner's verdict.
// Candidates and validated artifacts, grouped by workspace. A watch folder
// (ctx.config.watch, workspace-relative; default none) lists files not yet
// registered, with a one-click register-as-candidate. Activity lives elsewhere.
export function mount(el, ctx) {
  function ageLabel(iso) {
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) return '';
    const min = Math.max(0, Math.round((Date.now() - then) / 60000));
    if (min < 60) return `${min} min`;
    const hours = Math.round(min / 60);
    if (hours < 48) return `${hours} h`;
    return `${Math.round(hours / 24)} d`;
  }

  async function paint() {
    const watch = String(ctx.config?.watch || '').trim();
    const root = ctx.workspace?.root_path || '';
    const qs = new URLSearchParams();
    if (root) qs.set('root', root);
    if (watch) qs.set('watch', watch);
    const data = await ctx.request(`/api/inbox?${qs}`);
    const verdicts = data.verdicts || [];
    const unregistered = data.unregistered || [];
    el.replaceChildren();

    if (!verdicts.length && !unregistered.length) {
      el.innerHTML = '<div class="muted">Nothing waiting on you.</div>';
      return;
    }

    const groups = new Map();
    for (const row of verdicts) {
      const key = row.workspace_root;
      if (!groups.has(key)) groups.set(key, { label: row.workspace_label || key, rows: [] });
      groups.get(key).rows.push(row);
    }
    for (const group of groups.values()) {
      const head = document.createElement('div');
      head.className = 'muted inbox-group';
      head.textContent = `workspace ${group.label}`;
      el.append(head);
      for (const row of group.rows) {
        const item = document.createElement('div');
        item.className = 'side-row';
        const open = document.createElement('button');
        open.type = 'button';
        open.textContent = 'open in Validation center';
        open.onclick = event => {
          event.stopPropagation();
          ctx.selectFile(row.path)
            .then(() => ctx.activateStation('validation-center'))
            .catch(e => ctx.notify(e.message, 'error'));
        };
        item.innerHTML = `
          <span class="grow" title="${ctx.esc(row.path)}">${ctx.esc(row.relativePath || row.path)}</span>
          <span class="badge ${ctx.esc(row.state)}">${ctx.esc(row.state)}</span>
          <span class="aux">${ctx.esc(ageLabel(row.updated_at))}</span>`;
        item.append(open);
        el.append(item);
      }
    }

    if (watch) {
      const head = document.createElement('div');
      head.className = 'muted inbox-group';
      head.textContent = `${watch}, not yet registered`;
      el.append(head);
      if (!unregistered.length) {
        const empty = document.createElement('div');
        empty.className = 'muted';
        empty.textContent = 'Nothing unregistered in this folder.';
        el.append(empty);
      }
      for (const file of unregistered) {
        const item = document.createElement('div');
        item.className = 'side-row';
        const register = document.createElement('button');
        register.type = 'button';
        register.textContent = 'register as candidate';
        register.onclick = async event => {
          event.stopPropagation();
          try {
            await ctx.request(`/api/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(file.path)}`);
            await ctx.action('governance', 'transition', { path: file.path, toState: 'candidate', actor: 'human' });
            ctx.bus.emit('artifact-changed', { path: file.path, state: 'candidate' });
            await paint();
          } catch (error) {
            ctx.notify(error.message, 'error');
          }
        };
        item.innerHTML = `<span class="grow" title="${ctx.esc(file.path)}">${ctx.esc(file.relativePath || file.name)}</span>`;
        item.append(register);
        el.append(item);
      }
    }
  }
  const repaint = () => paint().catch(e => ctx.notify(e.message, 'error'));
  ctx.bus.on('artifact-changed', repaint);
  ctx.bus.on('file-saved', repaint);
  ctx.bus.on('fs-changed', repaint);
  ctx.bus.on('workspace', repaint);
  repaint();
}
