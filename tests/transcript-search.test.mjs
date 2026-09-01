// The transcript-search service: read-only deep search over provider-native
// JSONL transcripts. Roots come from RESEARCH_OPS_TRANSCRIPT_ROOTS here so the
// test never touches real provider logs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { plugin } from '../plugins/server/transcript-search.mjs';

function fixtureRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-ops-ts-'));
  const root = path.join(dir, 'claude');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'session-1.jsonl'), [
    JSON.stringify({ type: 'user', timestamp: '2026-08-30T10:00:00Z', message: { role: 'user', content: 'where is the gpu governor spec' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-08-30T10:00:05Z', message: { role: 'assistant', content: [{ type: 'text', text: 'the governor lives on port 8600' }] } }),
    'not even json, but still searchable: governor fallback line'
  ].join('\n'));
  process.env.RESEARCH_OPS_TRANSCRIPT_ROOTS = `claude=${root}`;
  t.after(() => { delete process.env.RESEARCH_OPS_TRANSCRIPT_ROOTS; fs.rmSync(dir, { recursive: true, force: true }); });
  return root;
}

test('catalog lists providers with sessions newest first', async t => {
  fixtureRoot(t);
  const { providers } = await plugin.action({ action: 'catalog', payload: {} });
  assert.equal(providers.length, 1);
  assert.equal(providers[0].provider, 'claude');
  assert.equal(providers[0].rootExists, true);
  assert.equal(providers[0].sessionCount, 1);
});

test('search matches text across parsed and raw lines, honoring role filter', async t => {
  fixtureRoot(t);
  const all = await plugin.action({ action: 'search', payload: { provider: 'claude', query: 'governor' } });
  assert.equal(all.results.length, 3);
  const assistantOnly = await plugin.action({ action: 'search', payload: { provider: 'claude', query: 'governor', role: 'assistant' } });
  assert.equal(assistantOnly.results.length, 1);
  assert.match(assistantOnly.results[0].snippet, /port 8600/);
});

test('search refuses a session path outside the provider root', async t => {
  fixtureRoot(t);
  await assert.rejects(
    plugin.action({ action: 'search', payload: { provider: 'claude', session: '/etc/passwd' } }),
    /outside the provider root/
  );
});
