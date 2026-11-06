import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { branchOf, conversationOf, usageOf, selectionOf, NAVIGATION_TYPE, BRIDGE_COMMAND, BRIDGE_REPLY } from '../server/conversation.js';
import conversationExtension from '../server/extensions/conversation.js';
import { readSessionSnapshot } from '../server/sessions.js';
import { PiAgent } from '../server/pi-agent.js';

const timestamp = '2026-01-01T00:00:00.000Z';
const entry = (id, parentId, type, fields = {}) => ({ id, parentId, type, timestamp, ...fields });
const message = (id, parentId, role, content, cost = 0) => entry(id, parentId, 'message', { message: { role, content, timestamp: Number(id.replace(/\D/g, '')) || 1, ...(role === 'assistant' ? { provider: 'test', model: 'model', thinkingLevel: 'high', stopReason: 'stop', api: 'openai-completions', usage: { input: 100, output: 10, cacheRead: 20, cacheWrite: 5, cost: { total: cost } } } : {}) } });
function fixture() {
  return [
    entry('model', null, 'model_change', { provider: 'test', modelId: 'model' }),
    entry('thinking', 'model', 'thinking_level_change', { thinkingLevel: 'high' }),
    message('u1', 'thinking', 'user', '共同问题'),
    message('a1', 'u1', 'assistant', [{ type: 'text', text: '共同回答' }], 0.1),
    message('u2', 'a1', 'user', '重复的问题'),
    message('a2', 'u2', 'assistant', [{ type: 'text', text: '原版本回答' }], 0.2),
    entry('n1', 'a1', 'custom', { customType: NAVIGATION_TYPE, data: { fromLeafId: 'a2', model: { provider: 'test', id: 'model' }, thinkingLevel: 'high' } }),
    message('u3', 'n1', 'user', '重复的问题'),
    message('a3', 'u3', 'assistant', [{ type: 'text', text: '修改版本回答' }], 0.3),
    entry('n2', 'a2', 'custom', { customType: NAVIGATION_TYPE, data: { fromLeafId: 'a3', model: { provider: 'test', id: 'model' }, thinkingLevel: 'high' } }),
  ];
}

test('versions use entry ids, ignore metadata, and remember each path rather than matching duplicate text', () => {
  const d = conversationOf(fixture());
  assert.equal(d.leafId, 'n2');
  const nodes = new Map(d.nodes.map(n => [n.id, n]));
  assert.deepEqual(nodes.get('u2').versions, ['u2', 'u3']);
  assert.deepEqual(nodes.get('u3').versions, ['u2', 'u3']);
  assert.equal(nodes.get('u2').active, true);
  assert.equal(nodes.get('u3').active, false);
  assert.equal(nodes.get('u3').targetId, 'a3');
  assert.equal(nodes.get('u2').targetId, 'n2');
  assert.equal(nodes.get('u3').parentId, 'u1');
  assert.ok(Math.abs(d.totals.cost - 0.6) < 1e-10);
  assert.ok(Math.abs(d.branchStats.cost - 0.3) < 1e-10);
  assert.equal(d.totals.tokens.input, 300);
  assert.equal(d.branchStats.tokens.input, 200);
});

test('intermediate tree nodes stop at their own turn while version targets retain the last descendant', () => {
  const entries = fixture();
  const d = conversationOf(entries);
  const root = d.nodes.find(n => n.id === 'u1');
  assert.equal(root.turnTargetId, 'n1', 'metadata following the answer belongs to the same turn');
  assert.equal(root.targetId, 'n2', 'version switching still resumes the visited descendant');
  assert.deepEqual(branchOf(entries, root.turnTargetId).filter(e => e.message?.role === 'user').map(e => e.id), ['u1']);
  for (const id of ['u2', 'u3']) {
    const n = d.nodes.find(n => n.id === id);
    assert.equal(n.turnTargetId, n.targetId, 'leaf questions retain their original target');
  }
  const toolTurn = [message('u1', null, 'user', 'first'), message('a1', 'u1', 'assistant', []), message('t1', 'a1', 'toolResult', []), message('a2', 't1', 'assistant', []), message('u2', 'a2', 'user', 'next')];
  assert.equal(conversationOf(toolTurn).nodes[0].turnTargetId, 'a2', 'a turn includes tool results and the final answer');
  assert.equal(conversationOf(toolTurn).nodes[1].turnTargetId, 'u2', 'unanswered questions remain navigable');
});

test('accounting includes compaction, branch summaries, tool nested usage and cache warming exactly once', () => {
  const usage = { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: { total: 0.05 } };
  const entries = [entry('c', null, 'compaction', { usage }), entry('b', 'c', 'branch_summary', { usage }), entry('w', 'b', 'usage', { kind: 'unknown-future-kind', usage }), message('tool', 'w', 'toolResult', [])];
  entries.at(-1).message.usage = usage;
  assert.equal(usageOf(entries).tokens.total, 56);
  assert.equal(usageOf(entries).cost, 0.2);
});

test('multiple roots, orphaned entries, labels and first-prompt edits are preserved', () => {
  const entries = [message('u1', null, 'user', 'first'), message('a1', 'u1', 'assistant', []), entry('n', null, 'custom', { customType: NAVIGATION_TYPE }), message('u2', 'n', 'user', []), message('u3', 'missing', 'user', 'orphan'), entry('label', 'u3', 'label', { targetId: 'u2', label: '图片方案' })];
  const d = conversationOf(entries);
  assert.deepEqual(d.nodes.map(n => n.parentId), [null, null, null]);
  assert.deepEqual(d.nodes[1].versions, ['u1', 'u2', 'u3']);
  assert.equal(d.nodes[1].label, '图片方案');
  assert.equal(branchOf([entry('x', 'y', 'custom'), entry('y', 'x', 'custom')]).length, 2, 'broken cyclic history cannot hang the reader');
});

test('selection checkpoints survive resume while newer native changes win', () => {
  const entries = [entry('m', null, 'model_change', { provider: 'old', modelId: 'old' }), entry('n', 'm', 'custom', { customType: NAVIGATION_TYPE, data: { model: { provider: 'new', id: 'new' }, thinkingLevel: 'low' } }), entry('t', 'n', 'thinking_level_change', { thinkingLevel: 'high' })];
  assert.deepEqual(selectionOf(entries), { model: { provider: 'new', id: 'new' }, thinkingLevel: 'high' });
});

test('lazy reader restores the saved navigation path, ids, scopes and model without spawning pi', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-conversation-'));
  try {
    const file = path.join(dir, 'session.jsonl');
    await fs.writeFile(file, [JSON.stringify({ type: 'session', version: 3, id: randomUUID(), cwd: dir, timestamp }), ...fixture().map(JSON.stringify)].join('\n') + '\n');
    const snap = await readSessionSnapshot(file);
    assert.deepEqual(snap.messages.filter(m => m.role === 'user').map(m => m._entryId), ['u1', 'u2']);
    assert.equal(snap.conversation.leafId, 'n2');
    assert.ok(Math.abs(snap.stats.cost - 0.6) < 1e-10);
    assert.ok(Math.abs(snap.stats.branchStats.cost - 0.3) < 1e-10);
    assert.equal(snap.state.model.id, 'model');
    assert.equal(snap.stats.contextEstimate.tokens, 135, 'latest usage on this path, not usage summed across requests or branches');
    assert.deepEqual(snap.stats.contextEstimate.usageModel, { provider: 'test', id: 'model' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

function mockExtension() {
  const entries = fixture();
  let leafId = 'n2', seq = 0, idle = true, cancel = false;
  const handlers = new Map(), commands = new Map(), replies = [], calls = [];
  const ctx = {
    mode: 'rpc', model: { provider: 'keep', id: 'current' },
    ui: { notify: s => replies.push(JSON.parse(s.slice(BRIDGE_REPLY.length))) },
    isIdle: () => idle, hasPendingMessages: () => false,
    navigateTree: async (id, options) => {
      calls.push({ id, options });
      if (cancel) return { cancelled: true };
      const e = entries.find(e => e.id === id);
      leafId = e.message?.role === 'user' ? e.parentId : e.id;
      return { cancelled: false }; // RPC command contexts do not return editorText
    },
    sessionManager: {
      getEntries: () => entries, getLeafId: () => leafId,
      getEntry: id => entries.find(e => e.id === id), getBranch: () => branchOf(entries, leafId),
      buildSessionProjection: () => ({ entries: branchOf(entries, leafId).filter(e => e.type === 'message').map(e => ({ sourceEntry: e, messages: [e.message] })) }),
    },
    getContextUsage: () => ({ tokens: 100, contextWindow: 2000, percent: 5 }),
  };
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    getThinkingLevel: () => 'low',
    appendEntry: (customType, data) => { entries.push(entry(`new${++seq}`, leafId, 'custom', { customType, data })); leafId = entries.at(-1).id; },
    setLabel: (id, label) => { entries.push(entry(`label${++seq}`, leafId, 'label', { targetId: id, label })); leafId = entries.at(-1).id; },
  };
  conversationExtension(pi);
  return {
    entries, calls, ctx, setIdle: v => idle = v, setCancel: v => cancel = v,
    request: async payload => { await commands.get(BRIDGE_COMMAND).handler(JSON.stringify({ requestId: 'r1', ...payload }), ctx); return replies.at(-1); },
  };
}

test('extension bridge uses summary-free native navigation, persists the cursor and keeps the current selection', async () => {
  const m = mockExtension();
  const r = await m.request({ op: 'navigate', targetId: 'u3', expectedLeafId: 'n2', requireUser: true });
  assert.equal(r.ok, true);
  assert.equal(r.data.editorText, '重复的问题');
  assert.deepEqual(m.calls[0], { id: 'u3', options: { summarize: false } });
  assert.equal(m.entries.at(-1).parentId, 'n1');
  assert.deepEqual(m.entries.at(-1).data.model, { provider: 'keep', id: 'current' });
  assert.equal(m.entries.at(-1).data.thinkingLevel, 'low');
  const snapshot = await m.request({ op: 'snapshot' });
  assert.ok(snapshot.data.messages.every(m => m._entryId));
  assert.equal(snapshot.data.contextUsage.percent, 5);
  assert.equal(snapshot.data.contextEstimate.tokens, 135);
});

test('the bridge prepares an intermediate question before sending and preserves its original branch', async () => {
  const m = mockExtension();
  const before = await m.request({ op: 'snapshot' });
  const root = before.data.nodes.find(n => n.id === 'u1');
  const r = await m.request({ op: 'navigate', targetId: root.id, expectedLeafId: before.data.leafId });
  assert.equal(r.ok, true);
  assert.equal(r.data.editorText, '共同问题');
  const after = await m.request({ op: 'snapshot' });
  assert.deepEqual(after.data.messages, []);
  assert.equal(after.data.nodes.length, before.data.nodes.length, 'original questions and answers stay in the tree');
  assert.ok(after.data.nodes.every(n => !n.active), 'the selected question is still waiting to be sent');
});

test('RPC navigation reconstructs multipart prompts, attachment blocks and images from the selected entry', async () => {
  const m = mockExtension();
  const image = { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' };
  const prompt = m.entries.find(e => e.id === 'u3');
  prompt.message.content = [{ type: 'text', text: 'original\n\n' }, { type: 'text', text: '<attachments>\n[1] file: C:/notes.txt\n</attachments>' }, image];
  const r = await m.request({ op: 'navigate', targetId: 'u3', expectedLeafId: 'n2' });
  assert.equal(r.ok, true);
  assert.equal(r.data.editorText, 'original\n\n<attachments>\n[1] file: C:/notes.txt\n</attachments>');
  assert.deepEqual(r.data.editorImages, [image]);
  prompt.message.content = [image];
  const onlyImage = await m.request({ op: 'navigate', targetId: 'u3', expectedLeafId: r.data.leafId });
  assert.equal(onlyImage.ok, true);
  assert.equal(onlyImage.data.editorText, '');
  assert.deepEqual(onlyImage.data.editorImages, [image]);
});

test('stale, busy, wrong-role and cancelled navigation have explicit failure replies and do not navigate', async () => {
  const m = mockExtension();
  const count = m.entries.length;
  assert.equal((await m.request({ op: 'navigate', targetId: 'u3', expectedLeafId: 'stale' })).ok, false);
  m.setIdle(false);
  assert.equal((await m.request({ op: 'navigate', targetId: 'u3', expectedLeafId: 'n2' })).ok, false);
  m.setIdle(true);
  assert.equal((await m.request({ op: 'navigate', targetId: 'a3', expectedLeafId: 'n2', requireUser: true })).ok, false);
  assert.equal(m.calls.length, 0);
  m.setCancel(true);
  assert.equal((await m.request({ op: 'navigate', targetId: 'u3', expectedLeafId: 'n2' })).ok, false);
  assert.equal(m.entries.length, count);
});

test('long histories build a compact user tree without walking every ancestor for every message', () => {
  const entries = [];
  for (let i = 0; i < 10000; i++) entries.push(message(`u${i}`, i ? `u${i - 1}` : null, 'user', 'question'));
  const d = conversationOf(entries);
  assert.equal(d.nodes.length, 10000);
  assert.equal(d.nodes[0].targetId, 'u9999');
});

test('real pi loads the bundled bridge, navigates without generation, and resumes the persisted position', { skip: !process.env.SEED_PI_WEB_TEST_PI, timeout: 45000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-pi-navigation-'));
  const file = path.join(dir, 'session.jsonl');
  let agent;
  try {
    await fs.writeFile(file, [JSON.stringify({ type: 'session', version: 3, id: randomUUID(), cwd: dir, timestamp }), ...fixture().map(JSON.stringify)].join('\n') + '\n');
    const start = async () => {
      agent = new PiAgent({ cwd: dir, sessionFile: file, extraArgs: ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-mcp'] });
      agent.on('record', r => assert.notEqual(r.type, 'agent_start', 'navigation must not invoke a model'));
      agent.start();
      await agent.refreshState();
    };
    await start();
    const snapshot = await agent.conversation({ op: 'snapshot' });
    assert.equal(snapshot.nodes.length, 3);
    const switched = await agent.conversation({ op: 'navigate', targetId: 'a3', expectedLeafId: snapshot.leafId });
    const after = await agent.conversation({ op: 'snapshot' });
    assert.equal(after.leafId, switched.leafId);
    assert.deepEqual(after.messages.filter(m => m.role === 'user').map(m => m._entryId), ['u1', 'u3']);
    await assert.rejects(agent.conversation({ op: 'navigate', targetId: 'a2', expectedLeafId: 'stale' }), /已经改变/);
    await agent.stop();
    await start();
    const restored = await agent.conversation({ op: 'snapshot' });
    assert.equal(restored.leafId, after.leafId);
  } finally {
    await agent?.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
