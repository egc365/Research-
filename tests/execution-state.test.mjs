import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ControlStore } from '../src/store.mjs';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-ops-exec-'));
  const store = new ControlStore(path.join(dir, 'control.sqlite3'));
  return { dir, store };
}

test('state patch merges key mutations and null deletes keys', () => {
  const f = fixture();
  try {
    f.store.initExecutionState({ runId: 'run-1', skillPath: 'skills/demo.md', initial: { step: 1, cwd: '/tmp', notes: 'a' } });
    const v1 = f.store.applyStatePatch({ runId: 'run-1', patch: { step: 2, notes: null, flag: true }, expectedVersion: 0 });
    assert.deepEqual(v1.state, { step: 2, cwd: '/tmp', flag: true });
    assert.equal(v1.state_version, 1);
  } finally { f.store.close(); fs.rmSync(f.dir, { recursive:true, force:true }); }
});

test('stale version and malformed patches change nothing', () => {
  const f = fixture();
  try {
    f.store.initExecutionState({ runId: 'run-2', initial: { step: 1 } });
    f.store.applyStatePatch({ runId: 'run-2', patch: { step: 2 }, expectedVersion: 0 });
    assert.throws(() => f.store.applyStatePatch({ runId: 'run-2', patch: { step: 99 }, expectedVersion: 0 }),
      error => error.code === 'STATE_VERSION_CONFLICT');
    assert.throws(() => f.store.applyStatePatch({ runId: 'run-2', patch: ['not','an','object'], expectedVersion: 1 }),
      error => error.code === 'INVALID_STATE_PATCH');
    assert.deepEqual(f.store.getExecutionState('run-2').state, { step: 2 });
    assert.equal(f.store.getExecutionState('run-2').state_version, 1);
  } finally { f.store.close(); fs.rmSync(f.dir, { recursive:true, force:true }); }
});

test('oversized merged state is rejected', () => {
  const f = fixture();
  try {
    f.store.initExecutionState({ runId: 'run-3', initial: {} });
    assert.throws(() => f.store.applyStatePatch({ runId: 'run-3', patch: { blob: 'x'.repeat(300000) }, expectedVersion: 0 }),
      error => error.code === 'STATE_TOO_LARGE');
  } finally { f.store.close(); fs.rmSync(f.dir, { recursive:true, force:true }); }
});
