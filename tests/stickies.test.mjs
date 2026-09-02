// The stickies service: one colored note per workspace-relative path, stored
// as CONTENT in the workspace's own stickies.sqlite3 — never in the control
// store. Owner writes; agents read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { plugin, STICKY_COLORS } from '../plugins/server/stickies.mjs';
import { stickyKey } from '../public/contrib/lib/sticky.js';

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-ops-stickies-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function act(root, action, payload = {}, surface = 'owner') {
  return plugin.action({ action, payload: { rootPath: root, ...payload }, surface });
}

test('notes land in <root>/.research-ops/stickies.sqlite3 and round-trip', async t => {
  const root = workspace(t);
  const saved = await act(root, 'set', { path: 'docs', text: 'ship the plan first', color: STICKY_COLORS[2] });
  assert.equal(saved.text, 'ship the plan first');
  assert.equal(saved.color, STICKY_COLORS[2]);
  assert.equal(fs.existsSync(path.join(root, '.research-ops', 'stickies.sqlite3')), true);
  const { notes, colors } = await act(root, 'list');
  assert.equal(notes['docs'].text, 'ship the plan first');
  assert.deepEqual(colors, STICKY_COLORS);
});

test('one note per path — set overwrites, empty text removes, remove removes', async t => {
  const root = workspace(t);
  await act(root, 'set', { path: 'docs', text: 'v1' });
  await act(root, 'set', { path: 'docs', text: 'v2', color: STICKY_COLORS[1] });
  let { notes } = await act(root, 'list');
  assert.equal(notes['docs'].text, 'v2');
  await act(root, 'set', { path: 'docs', text: '   ' });
  ({ notes } = await act(root, 'list'));
  assert.equal(notes['docs'], undefined);
  await act(root, 'set', { path: 'src', text: 'keep' });
  await act(root, 'remove', { path: 'src' });
  ({ notes } = await act(root, 'list'));
  assert.deepEqual(Object.keys(notes), []);
});

test('bad input refused: off-palette color, absolute or escaping paths', async t => {
  const root = workspace(t);
  await assert.rejects(act(root, 'set', { path: 'docs', text: 'x', color: '#000000' }), e => e.code === 'STICKY_BAD_INPUT');
  await assert.rejects(act(root, 'set', { path: '/etc', text: 'x' }), e => e.code === 'STICKY_BAD_INPUT');
  await assert.rejects(act(root, 'set', { path: '../out', text: 'x' }), e => e.code === 'STICKY_BAD_INPUT');
});

test('agent surface may list but never write', async t => {
  const root = workspace(t);
  await act(root, 'set', { path: 'docs', text: 'owner note' });
  const { notes } = await act(root, 'list', {}, 'agent');
  assert.equal(notes['docs'].text, 'owner note');
  for (const [action, payload] of [['set', { path: 'docs', text: 'nope' }], ['remove', { path: 'docs' }]]) {
    await assert.rejects(act(root, action, payload, 'agent'), e => e.code === 'OWNER_SURFACE_ONLY');
  }
});

test('set with an absolute path under rootPath stores under the relative key', async t => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, 'demo-test-1'));
  fs.writeFileSync(path.join(root, 'testing '), '');
  await act(root, 'set', { path: path.join(root, 'demo-test-1'), text: 'on the folder' });
  await act(root, 'set', { path: path.join(root, 'testing '), text: 'on the file' });
  const { notes } = await act(root, 'list');
  assert.equal(notes['demo-test-1'].text, 'on the folder');
  assert.equal(notes['testing '].text, 'on the file');
});

test('one set is visible to both folder-card relativePath and board-card ref keyings', async t => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'plan.md'), '');
  const relativePath = 'docs/plan.md';
  const boardRef = path.join(root, 'docs', 'plan.md');
  assert.equal(stickyKey(root, relativePath), relativePath);
  assert.equal(stickyKey(root, boardRef), relativePath);
  await act(root, 'set', { path: boardRef, text: 'ship the plan first' });
  const { notes } = await act(root, 'list');
  assert.equal(notes[relativePath].text, 'ship the plan first');
  assert.equal(notes[boardRef], undefined);
  assert.equal(Object.keys(notes).length, 1);
});
