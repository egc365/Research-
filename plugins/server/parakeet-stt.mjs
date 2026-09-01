// Service: monitors the local Parakeet STT app (/apps/parakeet-stt, FastAPI on
// 127.0.0.1:7880) and proxies its listen toggle. The browser cannot probe the
// app itself (cross-origin fetches to other local apps are opaque), so the
// server probes on the page's behalf — loopback only, so the agent surface can
// never turn this into a scanner of anything but this box. Real routes used
// (enumerated from /apps/parakeet-stt/server.py): GET /api/status,
// POST /api/listen/start, POST /api/listen/stop.
import fs from 'node:fs';

const CONFIG_PATH = '/apps/parakeet-stt/config.json';
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]', '::1'];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// The app's config.json, read defensively — absent or unparsable is fine
// (tests run against a stub with no config), we just report less.
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return null; }
}

function configSummary(cfg) {
  if (!cfg) return null;
  const summary = {};
  for (const key of ['model_name', 'host', 'port', 'sample_rate', 'prefer_cuda', 'mic_name_substr', 'inject_enabled', 'inject_mode']) {
    if (cfg[key] !== undefined) summary[key] = cfg[key];
  }
  return summary;
}

// Base URL: RESEARCH_OPS_PARAKEET_URL override (tests), else config.json's
// host/port. Validated against the loopback list either way — a policy
// violation throws a coded error; it is not a "down" result.
function baseUrl() {
  const override = process.env.RESEARCH_OPS_PARAKEET_URL;
  const cfg = readConfig();
  const raw = override || `http://${cfg?.host || '127.0.0.1'}:${cfg?.port || 7880}`;
  let url;
  try { url = new URL(raw); } catch { throw fail('BAD_URL', `Invalid Parakeet base URL: ${raw}`); }
  if (!LOOPBACK.includes(url.hostname)) {
    throw fail('LOOPBACK_ONLY', `Parakeet base URL must be loopback, got ${url.hostname}`);
  }
  return { base: url.href.replace(/\/$/, ''), cfg };
}

async function proxy(url, method) {
  const response = await fetch(url, { method, redirect: 'manual', signal: AbortSignal.timeout(2500) });
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON body: status alone */ }
  // The app answers listen failures as 409 + {ok:false,error} — pass that
  // through so the UI sees the app's own message rather than a thrown error.
  return { httpStatus: response.status, body };
}

export const plugin = {
  id: 'parakeet-stt',
  label: 'Parakeet STT',
  order: 82,
  scope: 'workspace',
  surface: 'main',
  category: 'monitoring',
  description: 'Status of the local Parakeet speech-to-text service (loopback only) and owner-only start/stop of its listen mode.',
  async action({ action, surface }) {
    const { base, cfg } = baseUrl();
    if (action === 'status') {
      const url = `${base}/api/status`;
      try {
        const { httpStatus, body } = await proxy(url, 'GET');
        return { up: httpStatus >= 200 && httpStatus < 300, httpStatus, status: body, url, config: configSummary(cfg), checkedAt: new Date().toISOString() };
      } catch (error) {
        return { up: false, error: error.cause?.code || error.name, url, config: configSummary(cfg), checkedAt: new Date().toISOString() };
      }
    }
    if (action === 'listen-start' || action === 'listen-stop') {
      if (surface === 'agent') {
        // Starting the mic (and the keystroke injector behind it) is an
        // owner act; agents may only observe status.
        throw fail('OWNER_SURFACE_ONLY', 'Listen start/stop is owner-surface only.');
      }
      const url = `${base}/api/listen/${action === 'listen-start' ? 'start' : 'stop'}`;
      try {
        const { httpStatus, body } = await proxy(url, 'POST');
        return { url, httpStatus, response: body };
      } catch (error) {
        throw fail('PARAKEET_UNREACHABLE', `Parakeet did not answer ${url}: ${error.cause?.code || error.name}`);
      }
    }
    throw new Error(`Unknown parakeet-stt action: ${action}`);
  }
};
