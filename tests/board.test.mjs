// The board service: groups/subgroups/cards as CONTENT in the workspace's own
// board.sqlite3 — never in control.sqlite3. Every call here passes no store at
// all, so any accidental control-store dependency fails loudly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { plugin } from '../plugins/server/board.mjs';

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-ops-board-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function act(root, action, payload = {}, surface = 'owner') {
  return plugin.action({ action, payload: { rootPath: root, ...payload }, surface });
}

test('content lands in <root>/.research-ops/board.sqlite3, not control.sqlite3', async t => {
  const root = workspace(t);
  await act(root, 'add-group', { title: 'Pipeline' });
  assert.equal(fs.existsSync(path.join(root, '.research-ops', 'board.sqlite3')), true);
  assert.equal(fs.existsSync(path.join(root, '.research-ops', 'control.sqlite3')), false);
});

test('tree nests groups/subgroups/cards ordered by sort_order', async t => {
  const root = workspace(t);
  const a = await act(root, 'add-group', { title: 'A', orientation: 'horizontal' });
  const b = await act(root, 'add-group', { title: 'B' });
  const a1 = await act(root, 'add-group', { parentId: a.group_id, title: 'A1' });
  await act(root, 'add-card', { groupId: a1.group_id, kind: 'note', ref: 'first note' });
  await act(root, 'add-card', { groupId: a1.group_id, kind: 'file', ref: 'docs/plan.md', title: 'Plan' });
  const { groups } = await act(root, 'tree');
  assert.deepEqual(groups.map(g => g.title), ['A', 'B']);
  assert.equal(groups[0].orientation, 'horizontal');
  assert.equal(b.orientation, 'vertical');
  assert.equal(groups[0].groups.length, 1);
  assert.equal(groups[0].groups[0].title, 'A1');
  assert.deepEqual(groups[0].groups[0].cards.map(c => c.ref), ['first note', 'docs/plan.md']);
  // Reorder: push the first card after the second.
  const [n1, n2] = groups[0].groups[0].cards;
  await act(root, 'move', { cardId: n1.card_id, toGroupId: a1.group_id, sortOrder: n2.sort_order + 10 });
  const after = await act(root, 'tree');
  assert.deepEqual(after.groups[0].groups[0].cards.map(c => c.ref), ['docs/plan.md', 'first note']);
});

test('move reparents a card and a group; rename and set-orientation stick', async t => {
  const root = workspace(t);
  const a = await act(root, 'add-group', { title: 'A' });
  const b = await act(root, 'add-group', { title: 'B' });
  const card = await act(root, 'add-card', { groupId: a.group_id, kind: 'link', ref: 'http://127.0.0.1:8787' });
  await act(root, 'move', { cardId: card.card_id, toGroupId: b.group_id, sortOrder: 10 });
  await act(root, 'move', { groupId: a.group_id, toParentId: b.group_id, sortOrder: 20 });
  await act(root, 'rename', { groupId: a.group_id, title: 'A renamed' });
  await act(root, 'set-orientation', { groupId: b.group_id, orientation: 'horizontal' });
  const { groups } = await act(root, 'tree');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, 'B');
  assert.equal(groups[0].orientation, 'horizontal');
  assert.deepEqual(groups[0].cards.map(c => c.ref), ['http://127.0.0.1:8787']);
  assert.deepEqual(groups[0].groups.map(g => g.title), ['A renamed']);
});

test('move refuses to put a group under its own descendant', async t => {
  const root = workspace(t);
  const a = await act(root, 'add-group', { title: 'A' });
  const a1 = await act(root, 'add-group', { parentId: a.group_id, title: 'A1' });
  const a2 = await act(root, 'add-group', { parentId: a1.group_id, title: 'A2' });
  await assert.rejects(act(root, 'move', { groupId: a.group_id, toParentId: a2.group_id, sortOrder: 10 }), /descendant/);
  await assert.rejects(act(root, 'move', { groupId: a.group_id, toParentId: a.group_id, sortOrder: 10 }), /descendant|itself/);
});

test('remove cascades to subgroups and cards', async t => {
  const root = workspace(t);
  const a = await act(root, 'add-group', { title: 'A' });
  const a1 = await act(root, 'add-group', { parentId: a.group_id, title: 'A1' });
  await act(root, 'add-card', { groupId: a1.group_id, kind: 'note', ref: 'doomed' });
  await act(root, 'add-group', { title: 'B' });
  await act(root, 'remove', { groupId: a.group_id });
  const { groups } = await act(root, 'tree');
  assert.deepEqual(groups.map(g => g.title), ['B']);
  assert.equal(groups[0].groups.length, 0);
  assert.equal(groups[0].cards.length, 0);
});

test('agent surface may read the tree but never mutate', async t => {
  const root = workspace(t);
  const a = await act(root, 'add-group', { title: 'A' });
  const card = await act(root, 'add-card', { groupId: a.group_id, kind: 'note', ref: 'owner note' });
  const { groups } = await act(root, 'tree', {}, 'agent');
  assert.equal(groups.length, 1);
  const mutations = [
    ['add-group', { title: 'nope' }],
    ['add-card', { groupId: a.group_id, kind: 'note', ref: 'nope' }],
    ['rename', { groupId: a.group_id, title: 'nope' }],
    ['set-orientation', { groupId: a.group_id, orientation: 'horizontal' }],
    ['move', { cardId: card.card_id, toGroupId: a.group_id, sortOrder: 5 }],
    ['remove', { cardId: card.card_id }]
  ];
  for (const [action, payload] of mutations) {
    await assert.rejects(act(root, action, payload, 'agent'), error => error.code === 'OWNER_SURFACE_ONLY');
  }
  const after = await act(root, 'tree');
  assert.deepEqual(after.groups[0].cards.map(c => c.ref), ['owner note']);
});
