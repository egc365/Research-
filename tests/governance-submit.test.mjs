// Deterministic document state: 'submit' is the one owner verb on the way up.
// It walks working → candidate → validated in a single call, with validation
// receipts minted by deterministic validators — never typed by the caller. A
// failing validation leaves the file candidate and returns the receipts
// instead of throwing, so the owner sees why. Promote / supersede / archive
// stay manual owner decisions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ControlStore } from '../src/store.mjs';
import { plugin as governance } from '../plugins/server/governance.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-ops-gov-'));
  const root = path.join(dir, 'workspace');
  fs.mkdirSync(root);
  const file = path.join(root, 'note.md');
  fs.writeFileSync(file, '# one\n', 'utf8');
  const store = new ControlStore(path.join(dir, 'control.sqlite3'));
  store.addWorkspace(root, 'fixture');
  store.readFile(root, file); // register the artifact
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { root, file, store };
}

const validators = ok => ({ runValidators: async () => ({ ok, results: [{ plugin: 'stub', ok }] }) });

test('submit walks working → candidate → validated in one call', async t => {
  const f = fixture(t);
  const result = await governance.action({
    action: 'submit', payload: { path: f.file }, store: f.store, plugins: validators(true)
  });
  assert.equal(result.state, 'validated');
  assert.equal(result.validation.ok, true);
  assert.equal(f.store.getArtifact(f.file).state, 'validated');
});

test('a failing validation leaves the file candidate and returns the receipts', async t => {
  const f = fixture(t);
  const result = await governance.action({
    action: 'submit', payload: { path: f.file }, store: f.store, plugins: validators(false)
  });
  assert.equal(result.state, 'candidate');
  assert.equal(result.validation.ok, false);
  assert.equal(f.store.getArtifact(f.file).state, 'candidate');
});

test('submit from candidate revalidates; submit from promoted is refused', async t => {
  const f = fixture(t);
  await governance.action({ action: 'submit', payload: { path: f.file }, store: f.store, plugins: validators(false) });
  const retried = await governance.action({ action: 'submit', payload: { path: f.file }, store: f.store, plugins: validators(true) });
  assert.equal(retried.state, 'validated');
  f.store.transition({ filePath: f.file, toState: 'promoted', actor: 'human' });
  await assert.rejects(
    governance.action({ action: 'submit', payload: { path: f.file }, store: f.store, plugins: validators(true) }),
    error => error.code === 'BAD_STATE'
  );
});
