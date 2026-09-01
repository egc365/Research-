import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.resolve(here, '..', 'public');

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
  const target = path.resolve(publicRoot, relative);
  if (!target.startsWith(publicRoot + path.sep) && target !== path.join(publicRoot, 'index.html')) return false;
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return false;
  const ext = path.extname(target);
  const type = ({ '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml' })[ext] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  fs.createReadStream(target).pipe(res);
  return true;
}

// The agent surface forces actor identity at the transport boundary. A caller on
// the agent port cannot claim to be human no matter what the request body says,
// which is what makes human-only promotion structural rather than self-reported.
function enforceSurfaceActor(surface, body) {
  if (surface !== 'agent' || !body || typeof body !== 'object') return body;
  body.actor = 'agent';
  if (body.payload && typeof body.payload === 'object') body.payload.actor = 'agent';
  return body;
}

async function api(req, res, url, { store, plugins, surface }) {
  if (req.method === 'GET' && url.pathname === '/api/surface') return json(res, 200, { surface });
  if (req.method === 'GET' && url.pathname === '/api/workspaces') return json(res, 200, store.listWorkspaces());
  if (req.method === 'POST' && url.pathname === '/api/workspaces') {
    if (surface === 'agent') return json(res, 403, { error: 'OWNER_SURFACE_ONLY', message: 'Workspace registration happens on the owner surface.' });
    const body = await readJson(req);
    return json(res, 201, store.createWorkspace({ rootPath: body.rootPath, label: body.label, create: body.create === true }));
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
    const body = enforceSurfaceActor(surface, await readJson(req));
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
  // ---- filesystem creation + the owner's label schema (SQLite crosswalk) ----
  if (req.method === 'POST' && url.pathname === '/api/fs/mkdir') {
    const body = enforceSurfaceActor(surface, await readJson(req));
    return json(res, 201, store.createDirectory({ rootPath: body.rootPath, dirPath: body.path, actor: body.actor || 'human' }));
  }
  if (req.method === 'POST' && url.pathname === '/api/fs/move') {
    const body = enforceSurfaceActor(surface, await readJson(req));
    return json(res, 200, store.moveEntry({ rootPath: body.rootPath, fromPath: body.from, toPath: body.to, actor: body.actor || 'human' }));
  }
  if (req.method === 'GET' && url.pathname === '/api/labels') return json(res, 200, store.listLabels());
  if (req.method === 'POST' && url.pathname === '/api/labels') {
    // Designation is curation: the label schema is owner state.
    if (surface === 'agent') return json(res, 403, { error: 'OWNER_SURFACE_ONLY', message: 'The label schema is managed on the owner surface.' });
    const body = await readJson(req);
    if (body.remove === true) return json(res, 200, store.deleteLabel(body.name));
    if (body.rename) return json(res, 200, store.renameLabel({ name: body.name, newName: body.rename }));
    return json(res, 200, store.defineLabel({ name: body.name, color: body.color, description: body.description }));
  }
  if (req.method === 'GET' && url.pathname === '/api/path-labels') {
    return json(res, 200, store.pathLabels(url.searchParams.get('root')));
  }
  if (req.method === 'POST' && url.pathname === '/api/path-labels') {
    if (surface === 'agent') return json(res, 403, { error: 'OWNER_SURFACE_ONLY', message: 'Labels are assigned on the owner surface.' });
    const body = await readJson(req);
    return json(res, 200, store.assignLabel({
      rootPath: body.rootPath, filePath: body.path, label: body.label,
      actor: body.actor || 'human', remove: body.remove === true
    }));
  }

  // ---- composition crosswalk (SQLite-backed routing/configuration) ----
  if (req.method === 'GET' && url.pathname === '/api/composition') {
    return json(res, 200, store.composition(url.searchParams.get('root')));
  }
  if (req.method === 'POST' && url.pathname === '/api/composition/workspace') {
    // Composition is owner state: what renders where is never agent-writable.
    if (surface === 'agent') return json(res, 403, { error: 'OWNER_SURFACE_ONLY', message: 'Workspace composition changes happen on the owner surface.' });
    const body = await readJson(req);
    return json(res, 200, store.setWorkspacePlugin({
      rootPath: body.rootPath, pluginId: body.pluginId,
      enabled: body.enabled !== false, sortOrder: body.sortOrder ?? 100, config: body.config || null
    }));
  }
  if (req.method === 'POST' && url.pathname === '/api/stations') {
    // Defining a station is composition authority — owner surface only.
    if (surface === 'agent') return json(res, 403, { error: 'OWNER_SURFACE_ONLY', message: 'Stations are defined on the owner surface.' });
    const body = await readJson(req);
    return json(res, 201, store.defineStation({ id: body.id, label: body.label, description: body.description, layout: body.layout, icon: body.icon }));
  }
  if (req.method === 'POST' && url.pathname === '/api/composition/station') {
    if (surface === 'agent') return json(res, 403, { error: 'OWNER_SURFACE_ONLY', message: 'Station wiring changes happen on the owner surface.' });
    const body = await readJson(req);
    return json(res, 200, store.setStationContribution({
      stationId: body.stationId, slotName: body.slotName, contributionId: body.contributionId,
      sortOrder: body.sortOrder ?? 100, config: body.config || null,
      enabled: body.enabled !== false, remove: body.remove === true
    }));
  }

  // ---- amendments (append-only proposals) and record-only decisions ----
  if (req.method === 'GET' && url.pathname === '/api/amendments') {
    return json(res, 200, store.listAmendments(url.searchParams.get('path'), url.searchParams.get('card')));
  }
  if (req.method === 'POST' && url.pathname === '/api/amendments') {
    // Agents may propose amendments; the surface stamps their identity.
    const body = enforceSurfaceActor(surface, await readJson(req));
    return json(res, 201, store.appendAmendment({
      filePath: body.path, card: body.card || '', body: body.body,
      note: body.note || null, actor: body.actor || 'human'
    }));
  }
  if (req.method === 'GET' && url.pathname === '/api/decisions') {
    return json(res, 200, store.listDecisions(url.searchParams.get('path')));
  }
  if (req.method === 'POST' && url.pathname === '/api/decision') {
    // Review verdicts are the owner's; the agent port cannot record one.
    if (surface === 'agent') return json(res, 403, { error: 'OWNER_SURFACE_ONLY', message: 'Decisions are recorded on the owner surface.' });
    const body = await readJson(req);
    return json(res, 200, store.recordDecision({
      filePath: body.path, card: body.card || '', decision: body.decision,
      note: body.note || null, actor: body.actor || 'human'
    }));
  }

  if (req.method === 'GET' && url.pathname === '/api/plugins') return json(res, 200, plugins.manifest());
  const match = url.pathname.match(/^\/api\/plugins\/([^/]+)\/action$/);
  if (req.method === 'POST' && match) {
    const body = enforceSurfaceActor(surface, await readJson(req));
    const result = await plugins.action(decodeURIComponent(match[1]), body.action, body.payload || {}, { surface, plugins });
    return json(res, 200, result);
  }
  return false;
}

export function createAppServer({ store, plugins, surface = 'owner' }) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname.startsWith('/api/')) {
        const handled = await api(req, res, url, { store, plugins, surface });
        if (handled !== false) return;
        return json(res, 404, { error: 'NOT_FOUND' });
      }
      if (surface === 'owner' && staticFile(res, decodeURIComponent(url.pathname))) return;
      json(res, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      const status = error.code === 'PROMOTION_REQUIRES_HUMAN_APPROVAL' || error.code === 'OWNER_SURFACE_ONLY' ? 403
        : ['PREFLIGHT_BLOCKED','STALE_BASE','REGISTRY_CHECKSUM_STALE','VALIDATION_FAILED','VALIDATION_RECEIPTS_REQUIRED','MOVE_CHECKSUM_MISMATCH','STATE_VERSION_CONFLICT','STATE_TOO_LARGE','INVALID_STATE_PATCH'].includes(error.code) ? 409
        : 400;
      json(res, status, {
        error: error.code || 'REQUEST_FAILED',
        message: error.message,
        expected: error.expected,
        actual: error.actual,
        preflight: error.preflight,
        validation: error.validation
      });
    }
  });
}
