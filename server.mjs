import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore } from './src/store.mjs';
import { PluginHost } from './src/plugin-host.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.RESEARCH_OPS_DB || path.join(here, '.research-ops', 'control.sqlite3');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8787);
const store = new ControlStore(dbPath);
const plugins = new PluginHost({ store, pluginDir: path.join(here, 'plugins', 'server') });
await plugins.load();

const json = (res, status, data) => {
  const body = JSON.stringify(data, (_, value) => typeof value === 'bigint' ? Number(value) : value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
};

const readJson = async req => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
};

function staticFile(res, requestPath) {
  const relative = requestPath === '/' ? 'index.html' : requestPath.replace(/^\//, '');
  const target = path.resolve(here, 'public', relative);
  const publicRoot = path.resolve(here, 'public');
  if (!target.startsWith(publicRoot + path.sep) && target !== path.join(publicRoot, 'index.html')) return false;
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return false;
  const ext = path.extname(target);
  const type = ({ '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml' })[ext] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  fs.createReadStream(target).pipe(res);
  return true;
}

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/workspaces') return json(res, 200, store.listWorkspaces());
  if (req.method === 'POST' && url.pathname === '/api/workspaces') {
    const body = await readJson(req);
    return json(res, 201, store.addWorkspace(body.rootPath, body.label));
  }
  if (req.method === 'GET' && url.pathname === '/api/tree') {
    const rootPath = url.searchParams.get('root');
    const relativePath = url.searchParams.get('path') || '.';
    return json(res, 200, store.listDirectory(rootPath, relativePath));
  }
  if (req.method === 'GET' && url.pathname === '/api/file') {
    return json(res, 200, store.readFile(url.searchParams.get('root'), url.searchParams.get('path')));
  }
  if (req.method === 'PUT' && url.pathname === '/api/file') {
    const body = await readJson(req);
    const preflight = await plugins.beforeWrite({ filePath: body.path, content: body.content, actor: body.actor || 'human', rootPath: body.rootPath });
    const result = store.writeFile({
      rootPath: body.rootPath,
      filePath: body.path,
      content: body.content,
      expectedChecksum: body.expectedChecksum,
      actor: body.actor || 'human',
      runId: body.runId || null,
      spanId: body.spanId || null
    });
    return json(res, 200, { ...result, preflight });
  }
  if (req.method === 'GET' && url.pathname === '/api/plugins') return json(res, 200, plugins.manifest());
  const match = url.pathname.match(/^\/api\/plugins\/([^/]+)\/action$/);
  if (req.method === 'POST' && match) {
    const body = await readJson(req);
    const result = await plugins.action(decodeURIComponent(match[1]), body.action, body.payload || {});
    return json(res, 200, result);
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
    if (url.pathname.startsWith('/api/')) {
      const handled = await api(req, res, url);
      if (handled !== false) return;
      return json(res, 404, { error: 'NOT_FOUND' });
    }
    if (staticFile(res, decodeURIComponent(url.pathname))) return;
    json(res, 404, { error: 'NOT_FOUND' });
  } catch (error) {
    const status = error.code === 'PROMOTION_REQUIRES_HUMAN_APPROVAL' ? 403
      : error.code === 'PREFLIGHT_BLOCKED' || error.code === 'STALE_BASE' || error.code === 'REGISTRY_CHECKSUM_STALE' ? 409
      : 400;
    json(res, status, {
      error: error.code || 'REQUEST_FAILED',
      message: error.message,
      expected: error.expected,
      actual: error.actual,
      preflight: error.preflight
    });
  }
});

server.listen(port, host, () => {
  console.log(`Research Operations listening on http://${host}:${port}`);
  console.log(`Control DB: ${dbPath}`);
  console.log(`Plugins: ${plugins.manifest().map(x => x.id).join(', ')}`);
});

for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => {
  server.close(() => { store.close(); process.exit(0); });
});
