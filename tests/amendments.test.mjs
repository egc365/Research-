import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ControlStore } from '../src/store.mjs';

function freshStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-ops-amend-'));
  const store = new ControlStore(path.join(dir, 'control.sqlite3'));
  const ws = path.join(dir, 'workspace'); fs.mkdirSync(ws);
  const doc = path.join(ws, 'notes.md');
  fs.writeFileSync(doc, '# Title\n\nBody paragraph.\n');
  store.addWorkspace(ws);
  store.readFile(ws, doc); // registers the artifact
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, ws, doc };
}

test('amendment revs count up per card and are append-only', t => {
  const { store, doc } = freshStore(t);
  const a1 = store.appendAmendment({ filePath: doc, card: 'block-1', body: 'first take', actor: 'human' });
  const a2 = store.appendAmendment({ filePath: doc, card: 'block-1', body: 'second take', actor: 'agent' });
  const b1 = store.appendAmendment({ filePath: doc, card: 'block-2', body: 'other card', actor: 'human' });
  assert.equal(a1.rev, 1); assert.equal(a2.rev, 2); assert.equal(b1.rev, 1);
  const log = store.listAmendments(doc);
  assert.equal(log.entries.length, 3);
  assert.deepEqual(log.latestRevByCard, { 'block-1': 2, 'block-2': 1 });
  assert.equal(log.entries[0].body, 'first take'); // rev 1 unchanged after rev 2
  assert.match(a1.sha256, /^[0-9a-f]{64}$/);
});

test('empty amendment body is refused', t => {
  const { store, doc } = freshStore(t);
  assert.throws(() => store.appendAmendment({ filePath: doc, card: 'x', body: '' }), /non-empty/);
});

test('decisions are restricted to accept and needs-more-work, and are record-only', t => {
  const { store, doc } = freshStore(t);
  const before = fs.readFileSync(doc, 'utf8');
  const beforeState = store.getArtifact(doc).state;
  store.recordDecision({ filePath: doc, card: 'block-1', decision: 'accept', actor: 'human' });
  const result = store.recordDecision({ filePath: doc, card: 'block-1', decision: 'needs-more-work', note: 'tighten it', actor: 'human' });
  assert.deepEqual(result.latestByCard, { 'block-1': 'needs-more-work' });
  assert.equal(result.entries.length, 2);
  assert.equal(fs.readFileSync(doc, 'utf8'), before);            // moved nothing
  assert.equal(store.getArtifact(doc).state, beforeState);        // changed nothing
  assert.throws(() => store.recordDecision({ filePath: doc, decision: 'exclude' }), /not a decision/);
});
