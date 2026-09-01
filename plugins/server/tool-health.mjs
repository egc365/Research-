// Service: probes local tool ports and reports up/down with latency. The
// browser cannot do this itself (cross-origin fetches to other local apps are
// opaque), so the server probes on the page's behalf — loopback only, so the
// agent surface can never turn this into a scanner of anything but this box.
export const plugin = {
  id: 'tool-health',
  label: 'Tool health',
  order: 80,
  scope: 'workspace',
  surface: 'main',
  category: 'monitoring',
  description: 'Probes the machine’s local tool ports (loopback only) and reports status and latency.',
  async action({ action, payload }) {
    if (action !== 'check') throw new Error(`Unknown tool-health action: ${action}`);
    const targets = Array.isArray(payload.targets) ? payload.targets.slice(0, 32) : [];
    const results = await Promise.all(targets.map(async target => {
      const label = String(target?.label || target?.url || 'unnamed');
      let url;
      try { url = new URL(target.url); } catch { return { label, url: String(target?.url), ok: false, error: 'invalid url' }; }
      if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) {
        return { label, url: url.href, ok: false, error: 'loopback only' };
      }
      const started = performance.now();
      try {
        const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(2500) });
        await response.body?.cancel();
        return { label, url: url.href, ok: true, status: response.status, ms: Math.round(performance.now() - started) };
      } catch (error) {
        return { label, url: url.href, ok: false, error: error.cause?.code || error.name, ms: Math.round(performance.now() - started) };
      }
    }));
    return { checkedAt: new Date().toISOString(), results };
  }
};
