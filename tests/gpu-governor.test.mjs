// The gpu-governor service: read-only window onto the governor daemon's data
// files. The base dir and allowlist come from env overrides here so the test
// never touches the real /apps/gpu-governor.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { plugin } from '../plugins/server/gpu-governor.mjs';

const SNAPSHOT = {
  at: '2026-09-01T10:00:00+00:00', mode: 'enforce', paused: false,
  total_mib: 12928, budget_mib: 90000,
  procs: [{ pid: 4242, mib: 12928, verdict: 'allowed', why: 'MinerU backend', cmd: 'mineru-api --port 18000' }]
};
const RULES_NEW = { mode: 'enforce', total_budget_mib: 90000, rules: [{ match: 'mineru', max_mib: 26000, note: 'new-path rules' }] };
const RULES_LEGACY = { mode: 'dry-run', total_budget_mib: 50000, rules: [{ match: 'legacy', max_mib: 1000, note: 'legacy rules' }] };

function fixture(t, { latest = SNAPSHOT, events = null, newAllowlist = RULES_NEW, legacyAllowlist = RULES_LEGACY } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-ops-gpu-'));
  if (latest !== null) fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(latest, null, 2) + '\n');
  if (events !== null) fs.writeFileSync(path.join(dir, 'events.jsonl'), events);
  if (newAllowlist !== null) {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'gpu-allowlist.json'), JSON.stringify(newAllowlist, null, 2) + '\n');
  }
  const legacyPath = path.join(dir, 'legacy-allowlist.json');
  if (legacyAllowlist !== null) fs.writeFileSync(legacyPath, JSON.stringify(legacyAllowlist, null, 2) + '\n');
  process.env.RESEARCH_OPS_GPU_GOVERNOR_DIR = dir;
  process.env.RESEARCH_OPS_GPU_ALLOWLIST = legacyPath;
  t.after(() => {
    delete process.env.RESEARCH_OPS_GPU_GOVERNOR_DIR;
    delete process.env.RESEARCH_OPS_GPU_ALLOWLIST;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const eventLines = n => Array.from({ length: n }, (_, i) =>
  JSON.stringify({ at: `2026-09-01T10:00:${String(i).padStart(2, '0')}+00:00`, action: 'would_kill', pid: 1000 + i, mib: 100 + i, why: `event ${i}` })
).join('\n') + '\n';

test('status parses snapshot, rules and events, with dashboard url', async t => {
  fixture(t, { events: eventLines(3) });
  const status = await plugin.action({ action: 'status', payload: {} });
  assert.equal(status.dashboardUrl, 'http://127.0.0.1:7890');
  assert.equal(status.latest.mode, 'enforce');
  assert.equal(status.latest.procs[0].pid, 4242);
  assert.equal(status.latestError, null);
  assert.equal(status.rules.rules[0].note, 'new-path rules');
  assert.equal(status.events.length, 3);
  assert.equal(status.eventLimit, 20);
});

test('event tail honors the limit and returns newest first', async t => {
  fixture(t, { events: eventLines(30) });
  const status = await plugin.action({ action: 'status', payload: { limit: 5 } });
  assert.equal(status.eventLimit, 5);
  assert.equal(status.events.length, 5);
  assert.equal(status.events[0].pid, 1029); // newest (last written) first
  assert.equal(status.events[4].pid, 1025);
});

test('event limit is capped at 200 and floored at 1', async t => {
  fixture(t, { events: eventLines(2) });
  const capped = await plugin.action({ action: 'status', payload: { limit: 9999 } });
  assert.equal(capped.eventLimit, 200);
  const floored = await plugin.action({ action: 'status', payload: { limit: -3 } });
  assert.equal(floored.eventLimit, 1);
  assert.equal(floored.events.length, 1);
});

test('missing files degrade to nulls, not throws', async t => {
  fixture(t, { latest: null, events: null, newAllowlist: null, legacyAllowlist: null });
  const status = await plugin.action({ action: 'status', payload: {} });
  assert.equal(status.latest, null);
  assert.equal(status.latestError, 'missing');
  assert.equal(status.events, null);
  assert.equal(status.rules, null);
  assert.equal(status.allowlistPath, null);
  assert.equal(status.allowlistSource, null);
});

test('torn latest.json degrades to null with an error string', async t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'latest.json'), '{"at": "2026-09-01T10:0'); // torn mid-rewrite
  const status = await plugin.action({ action: 'status', payload: {} });
  assert.equal(status.latest, null);
  assert.match(status.latestError, /unreadable/);
});

test('allowlist resolution tries the new config path first, then falls back to legacy', async t => {
  const dir = fixture(t);
  const first = await plugin.action({ action: 'status', payload: {} });
  assert.equal(first.allowlistSource, 'new');
  assert.equal(first.allowlistPath, path.join(dir, 'config', 'gpu-allowlist.json'));
  assert.equal(first.rules.mode, 'enforce');

  fs.rmSync(path.join(dir, 'config', 'gpu-allowlist.json'));
  const fallback = await plugin.action({ action: 'status', payload: {} });
  assert.equal(fallback.allowlistSource, 'legacy');
  assert.equal(fallback.allowlistPath, path.join(dir, 'legacy-allowlist.json'));
  assert.equal(fallback.rules.mode, 'dry-run');
  assert.equal(fallback.rules.rules[0].note, 'legacy rules');
});

test('unknown action throws a coded error', async t => {
  fixture(t);
  await assert.rejects(plugin.action({ action: 'kill', payload: {} }), /Unknown gpu-governor action/);
});
