import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ControlStore } from '../src/store.mjs';

function freshStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-ops-kernel-prefs-'));
  const store = new ControlStore(path.join(dir, 'control.sqlite3'));
  const ws = path.join(dir, 'workspace'); fs.mkdirSync(ws);
  store.addWorkspace(ws);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, ws };
}

// The stage's main/side drag divider persists its position through the
// paneSplit ui-preference; the kernel saves an integer percent in 20..80.
test('paneSplit round-trips through ui-preferences within its 20..80 bounds', t => {
  const { store, ws } = freshStore(t);
  assert.deepEqual(store.setUiPreferences({ rootPath: ws, patch: { paneSplit: 20 } }), { paneSplit: 20 });
  assert.deepEqual(store.setUiPreferences({ rootPath: ws, patch: { paneSplit: 80 } }), { paneSplit: 80 });
  store.setUiPreferences({ rootPath: ws, patch: { paneSplit: 63 } });
  assert.deepEqual(store.uiPreferences(ws), { paneSplit: 63 });
  // merging keeps unrelated keys
  store.setUiPreferences({ rootPath: ws, patch: { theme: 'dark' } });
  assert.deepEqual(store.uiPreferences(ws), { paneSplit: 63, theme: 'dark' });
});

test('paneSplit refuses out-of-range and non-numeric values', t => {
  const { store, ws } = freshStore(t);
  for (const bad of [19, 81, 0, -30, '55', null, NaN, {}]) {
    assert.throws(() => store.setUiPreferences({ rootPath: ws, patch: { paneSplit: bad } }),
      /invalid value/, `paneSplit ${String(bad)} should be refused`);
  }
  assert.deepEqual(store.uiPreferences(ws), {});
});
