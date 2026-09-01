// The parakeet-stt service: loopback-only status probe + owner-only listen
// toggles, exercised against a tiny node:http stub so the real service is
// never touched.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { plugin } from '../plugins/server/parakeet-stt.mjs';

function stubServer(t) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ready: true, model: 'nvidia/parakeet-tdt-0.6b-v2', listening: false, uptime_s: 12.5 }));
    } else if (req.method === 'POST' && req.url === '/api/listen/start') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, window: 'stub-window' }));
    } else if (req.method === 'POST' && req.url === '/api/listen/stop') {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not listening' }));
    } else {
      res.writeHead(404); res.end();
    }
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      process.env.RESEARCH_OPS_PARAKEET_URL = `http://127.0.0.1:${port}`;
      t.after(() => { delete process.env.RESEARCH_OPS_PARAKEET_URL; server.close(); });
      resolve(port);
    });
  });
}

test('status maps an answering stub to up:true with the payload', async t => {
  await stubServer(t);
  const result = await plugin.action({ action: 'status', payload: {}, surface: 'owner' });
  assert.equal(result.up, true);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.status.model, 'nvidia/parakeet-tdt-0.6b-v2');
  assert.match(result.url, /\/api\/status$/);
});

test('status maps a dead port to up:false, never throws', async t => {
  // Grab an ephemeral port, then close it so nothing listens there.
  const port = await stubServer(t);
  await new Promise(resolve => http.createServer().listen(0, '127.0.0.1', function () {
    const dead = this.address().port;
    this.close(() => { process.env.RESEARCH_OPS_PARAKEET_URL = `http://127.0.0.1:${dead}`; resolve(); });
  }));
  assert.notEqual(port, undefined);
  const result = await plugin.action({ action: 'status', payload: {}, surface: 'agent' });
  assert.equal(result.up, false);
  assert.ok(result.error, 'down result carries an error code');
});

test('listen toggles are refused on the agent surface with a coded error', async t => {
  await stubServer(t);
  for (const action of ['listen-start', 'listen-stop']) {
    await assert.rejects(
      plugin.action({ action, payload: {}, surface: 'agent' }),
      error => error.code === 'OWNER_SURFACE_ONLY'
    );
  }
});

test('listen toggles proxy to the real routes on the owner surface, 409 passed through', async t => {
  await stubServer(t);
  const started = await plugin.action({ action: 'listen-start', payload: {}, surface: 'owner' });
  assert.equal(started.httpStatus, 200);
  assert.equal(started.response.ok, true);
  const stopped = await plugin.action({ action: 'listen-stop', payload: {}, surface: 'owner' });
  assert.equal(stopped.httpStatus, 409);
  assert.equal(stopped.response.ok, false);
  assert.equal(stopped.response.error, 'not listening');
});

test('a non-loopback base URL is refused as policy, not reported as down', async t => {
  process.env.RESEARCH_OPS_PARAKEET_URL = 'http://10.0.0.5:7880';
  t.after(() => { delete process.env.RESEARCH_OPS_PARAKEET_URL; });
  await assert.rejects(
    plugin.action({ action: 'status', payload: {}, surface: 'owner' }),
    error => error.code === 'LOOPBACK_ONLY'
  );
  await assert.rejects(
    plugin.action({ action: 'listen-start', payload: {}, surface: 'owner' }),
    error => error.code === 'LOOPBACK_ONLY'
  );
});
