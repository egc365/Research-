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

test('editing promoted bytes opens a working successor without changing promoted snapshot', () => {
  const f = fixture();
  try {
    const opened = f.store.readFile(f.root, f.file);
    f.store.transition({ filePath:f.file, toState:'candidate', actor:'agent' });
    f.store.transition({ filePath:f.file, toState:'validated', actor:'agent' });
    const promoted = f.store.transition({ filePath:f.file, toState:'promoted', actor:'human' });
    const promotedChecksum = promoted.promoted_checksum;
    const edited = f.store.writeFile({ rootPath:f.root, filePath:f.file, content:'# two\n', expectedChecksum:opened.checksum, actor:'human' });
    assert.equal(edited.artifact.state, 'working');
    assert.equal(edited.artifact.promoted_checksum, promotedChecksum);
    assert.notEqual(edited.checksum, promotedChecksum);
    const frozen = f.store.getPromotedVersion(f.file);
    assert.equal(frozen.checksum, promotedChecksum);
    assert.equal(Buffer.from(frozen.content).toString('utf8'), '# one\n');
  } finally { f.store.close(); fs.rmSync(f.dir, { recursive:true, force:true }); }
});

test('editing a candidate or validated file demotes it to working', () => {
  const f = fixture();
  try {
    const opened = f.store.readFile(f.root, f.file);
    f.store.transition({ filePath:f.file, toState:'candidate', actor:'agent' });
    f.store.transition({ filePath:f.file, toState:'validated', actor:'agent' });
    const edited = f.store.writeFile({ rootPath:f.root, filePath:f.file, content:'# sneaky change\n', expectedChecksum:opened.checksum, actor:'agent' });
    assert.equal(edited.artifact.state, 'working');
    const events = f.store.history(f.file);
    const demotion = events.find(e => e.event_type === 'WRITE_DEMOTION');
    assert.ok(demotion, 'expected WRITE_DEMOTION event');
    assert.equal(demotion.from_state, 'validated');
    assert.equal(demotion.to_state, 'working');
  } finally { f.store.close(); fs.rmSync(f.dir, { recursive:true, force:true }); }
});

test('external filesystem edit to a validated file demotes it on next read', () => {
  const f = fixture();
  try {
    f.store.readFile(f.root, f.file);
    f.store.transition({ filePath:f.file, toState:'candidate', actor:'agent' });
    f.store.transition({ filePath:f.file, toState:'validated', actor:'agent' });
    fs.writeFileSync(f.file, '# edited behind the registry\n');
    const reread = f.store.readFile(f.root, f.file);
    assert.equal(reread.artifact.state, 'working');
    const demotion = f.store.history(f.file).find(e => e.event_type === 'WRITE_DEMOTION');
    assert.ok(demotion, 'expected WRITE_DEMOTION event');
    assert.equal(demotion.actor, 'filesystem');
  } finally { f.store.close(); fs.rmSync(f.dir, { recursive:true, force:true }); }
});

test('rewriting identical bytes does not demote a validated file', () => {
  const f = fixture();
  try {
    const opened = f.store.readFile(f.root, f.file);
    f.store.transition({ filePath:f.file, toState:'candidate', actor:'agent' });
    f.store.transition({ filePath:f.file, toState:'validated', actor:'agent' });
    const rewritten = f.store.writeFile({ rootPath:f.root, filePath:f.file, content:'# one\n', expectedChecksum:opened.checksum, actor:'agent' });
    assert.equal(rewritten.artifact.state, 'validated');
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
