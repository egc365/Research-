// Contribution: a box the owner names and fills. Items live in
// wiring config_json.items; the name is config_json.label (kernel header).
export function mount(el, ctx) {
  function parseDrag(event) {
    const typed = event.dataTransfer.getData('application/x-ro-app');
    if (typed) {
      try { return { kind: 'app', ...JSON.parse(typed) }; } catch { return null; }
    }
    const plain = event.dataTransfer.getData('text/plain');
    if (plain.startsWith('ro-app:')) {
      try { return { kind: 'app', ...JSON.parse(plain.slice(7)) }; } catch { return null; }
    }
    return null;
  }

  function items() {
    return Array.isArray(ctx.config?.items) ? ctx.config.items.filter(item => item && item.label && (item.station || item.url)) : [];
  }

  async function saveItems(next) {
    await ctx.patchConfig({ items: next });
    paint();
  }

  function addItem(item) {
    const label = String(item.label || '').trim();
    const station = String(item.station || '').trim();
    const url = String(item.url || '').trim();
    if (!label || (!station && !url)) return;
    const next = items().slice();
    if (station) next.push({ label, station });
    else next.push({ label, url });
    return saveItems(next);
  }

  function paint() {
    el.replaceChildren();
    const card = document.createElement('div');
    card.className = 'card';
    const row = document.createElement('div');
    row.className = 'launch-row';
    for (const [index, item] of items().entries()) {
      const chip = document.createElement(item.url ? 'a' : 'div');
      chip.className = 'launch-chip';
      chip.dataset.index = String(index);
      if (item.station) chip.dataset.station = item.station;
      if (item.url) {
        chip.dataset.url = item.url;
        chip.href = item.url;
        chip.target = '_blank';
        chip.rel = 'noopener';
      } else {
        chip.onclick = () => ctx.activateStation(item.station);
      }
      const name = document.createElement('span');
      name.textContent = item.label;
      chip.append(name);
      const drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'apps-item-drop';
      drop.title = 'Remove';
      drop.textContent = '✕';
      drop.onclick = event => {
        event.preventDefault();
        event.stopPropagation();
        saveItems(items().filter((_, i) => i !== index)).catch(e => ctx.notify(e.message, 'error'));
      };
      chip.append(drop);
      row.append(chip);
    }
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'apps-add-toggle';
    toggle.textContent = '＋ app';
    const form = document.createElement('form');
    form.className = 'apps-add-form';
    form.hidden = true;
    form.innerHTML = `
      <input name="label" placeholder="label" required>
      <input name="target" placeholder="station id or url" required>
      <button type="submit">Add</button>`;
    toggle.onclick = () => { form.hidden = !form.hidden; };
    form.onsubmit = event => {
      event.preventDefault();
      const label = form.label.value.trim();
      const target = form.target.value.trim();
      if (!label || !target) return;
      const item = /^[a-z][a-z0-9+.-]*:\/\//i.test(target) || target.startsWith('/')
        ? { label, url: target }
        : { label, station: target };
      addItem(item).then(() => { form.reset(); form.hidden = true; }).catch(e => ctx.notify(e.message, 'error'));
    };
    card.append(row, toggle, form);
    el.append(card);
  }

  el.addEventListener('dragover', event => {
    if (![...event.dataTransfer.types].some(t => t.toLowerCase() === 'application/x-ro-app')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  el.addEventListener('drop', event => {
    const data = parseDrag(event);
    if (!data || data.kind !== 'app') return;
    event.preventDefault();
    event.stopPropagation();
    addItem(data).catch(e => ctx.notify(e.message, 'error'));
  });

  paint();
}
