import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ControlStore } from '../src/store.mjs';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-ops-'));
  const root = path.join(dir, 'workspace');
  fs.mkdirSync(root);
  const file = path.join(root, 'note.md');
  fs.writeFileSync(file, '# one\n', 'utf8');
  const store = new ControlStore(path.join(dir, 'control.sqlite3'));
  store.addWorkspace(root, 'fixture');
  return { dir, root, file, store };
}

test('path is registry key and content checksum is tracked beside it', () => {
  const f = fixture();
  try {
    const opened = f.store.readFile(f.root, f.file);
    assert.equal(opened.artifact.path, f.file);
    assert.equal(opened.artifact.state, 'working');
    assert.equal(opened.artifact.checksum, opened.checksum);
  } finally { f.store.close(); fs.rmSync(f.dir, { recursive:true, force:true }); }
});

test('stale write is rejected', () => {
  const f = fixture();
  try {
    const opened = f.store.readFile(f.root, f.file);
    fs.writeFileSync(f.file, '# external edit\n');
    assert.throws(() => f.store.writeFile({ rootPath:f.root, filePath:f.file, content:'# UI edit\n', expectedChecksum:opened.checksum }), error => error.code === 'STALE_BASE');
  } finally { f.store.close(); fs.rmSync(f.dir, { recursive:true, force:true }); }
});

test('promotion is human-only and freezes exact bytes', () => {
  const f = fixture();
  try {
    f.store.readFile(f.root, f.file);
    f.store.transition({ filePath:f.file, toState:'candidate', actor:'agent' });
    f.store.transition({ filePath:f.file, toState:'validated', actor:'agent' });
    assert.throws(() => f.store.transition({ filePath:f.file, toState:'promoted', actor:'agent' }), error => error.code === 'PROMOTION_REQUIRES_HUMAN_APPROVAL');
    const promoted = f.store.transition({ filePath:f.file, toState:'promoted', actor:'human' });
    const frozen = f.store.getPromotedVersion(f.file);
    assert.equal(promoted.promoted_checksum, frozen.checksum);
    assert.equal(Buffer.from(frozen.content).toString('utf8'), '# one\n');
  } finally { f.store.close(); fs.rmSync(f.dir, { recursive:true, force:true }); }
});

test('governance history is append-only across transitions', () => {
  const f = fixture();
  try {
    f.store.readFile(f.root, f.file);
    f.store.transition({ filePath:f.file, toState:'candidate', actor:'agent', runId:'run-1', spanId:'span-2' });
    f.store.transition({ filePath:f.file, toState:'validated', actor:'agent', runId:'run-1', spanId:'span-3' });
    const events = f.store.history(f.file);
    assert.equal(events.length, 2);
    assert.equal(events[0].to_state, 'validated');
    assert.equal(events[1].to_state, 'candidate');
  } finally { f.store.close(); fs.rmSync(f.dir, { recursive:true, force:true }); }
});
