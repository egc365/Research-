import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { plugin } from '../plugins/server/tool-health.mjs';

function closedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(err => err ? reject(err) : resolve(port));
    });
    server.on('error', reject);
  });
}

test('a refused port reports ECONNREFUSED', async () => {
  const port = await closedPort();
  const result = await plugin.action({
    action: 'check',
    payload: { targets: [{ label: 'closed', url: `http://127.0.0.1:${port}` }] }
  });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[0].error, 'ECONNREFUSED');
});
