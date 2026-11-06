import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateContext } from '../server/context-usage.js';
import { branchOf } from '../server/conversation.js';

const msg = (id, role, content, extra = {}) => ({ id, type: 'message', message: { role, content, ...extra } });
const answer = (id, totalTokens, extra = {}) => msg(id, 'assistant', [{ type: 'text', text: 'answer' }], {
  provider: 'test', model: 'model', stopReason: 'stop', usage: { totalTokens }, ...extra,
});

test('latest valid assistant usage is a baseline, plus only subsequent messages', () => {
  const estimate = estimateContext([
    msg('u1', 'user', 'first'), answer('a1', 100),
    msg('u2', 'user', 'second'), answer('a2', 200),
    msg('t2', 'toolResult', [{ type: 'text', text: '12345678' }]),
    msg('u3', 'user', 'next'),
  ]);
  assert.equal(estimate.tokens, 203, 'not 100 + 200 or another copy of prior messages');
  assert.deepEqual(estimate.usageModel, { provider: 'test', id: 'model' });
  assert.ok(estimate.contentTokens < 100);
});

test('component usage includes input, output and both caches, with native total preferred', () => {
  const usage = { input: 100, output: 20, cacheRead: 300, cacheWrite: 40 };
  assert.equal(estimateContext([answer('a', 0, { usage })]).tokens, 460);
  assert.equal(estimateContext([answer('a', 0, { usage: { ...usage, totalTokens: 500 } })]).tokens, 500);
});

test('aborted, error, zero and invalid usage cannot erase a valid baseline', () => {
  for (const extra of [
    { stopReason: 'error' }, { stopReason: 'aborted' },
    { usage: { totalTokens: 0 } }, { usage: { totalTokens: -1 } },
    { usage: { totalTokens: Infinity } },
  ]) {
    const d = estimateContext([answer('a', 100), answer('bad', 9999, extra)]);
    assert.equal(d.tokens, 102, 'keep baseline and estimate the failed response content');
  }
});

test('without valid usage, text, CJK, tools, thinking and images are estimated without counting base64', () => {
  const image = (data) => msg('u', 'user', [{ type: 'image', data }]);
  assert.equal(estimateContext([image('x')]).tokens, estimateContext([image('x'.repeat(100000))]).tokens);
  assert.equal(estimateContext([msg('u', 'user', '你好世界')]).tokens, 4);
  const d = estimateContext([
    msg('s', 'system', 'rules', { sections: { tools: 'more rules' }, toolsAdded: [{ name: 'read' }] }),
    msg('a', 'assistant', [{ type: 'thinking', thinking: 'reason' }, { type: 'toolCall', name: 'read', arguments: { path: '/file' } }]),
    msg('t', 'toolResult', 'result'),
    msg('b', 'bashExecution', null, { command: 'pwd', output: '/repo' }),
    msg('c', 'bashExecution', null, { output: 'x'.repeat(10000), excludeFromContext: true }),
  ]);
  assert.ok(d.tokens > 15 && d.tokens < 100);
  assert.equal(d.tokens, d.contentTokens);
  assert.equal(d.usageModel, null);
});

test('only the selected branch contributes context', () => {
  const entries = [
    { ...msg('u', 'user', 'root'), parentId: null },
    { ...answer('a', 100), parentId: 'u' },
    { ...answer('b', 9000), parentId: 'u' },
  ];
  assert.equal(estimateContext(branchOf(entries, 'a')).tokens, 100);
  assert.equal(estimateContext(branchOf(entries, 'b')).tokens, 9000);
});

test('compaction discards old content and invalidates retained pre-compaction usage', () => {
  const branch = [
    msg('old', 'user', 'x'.repeat(10000)),
    msg('kept', 'user', 'keep'), answer('a', 9000),
    { id: 'c', type: 'compaction', firstKeptEntryId: 'kept', summary: 'summary', systemMessage: { role: 'system', content: 'rules' } },
    msg('u', 'user', 'next'),
  ];
  const d = estimateContext(branch);
  assert.ok(d.tokens > 0 && d.tokens < 20);
  assert.equal(d.usageModel, null, '9000 described the pre-compaction request');
  assert.equal(estimateContext([...branch, answer('new', 250)]).tokens, 250);
  const missingKeep = [...branch];
  missingKeep[3] = { ...missingKeep[3], firstKeptEntryId: 'missing' };
  assert.ok(estimateContext(missingKeep).tokens < d.tokens, 'missing kept id must not resurrect discarded messages');
});

test('context edits replace or remove content and invalidate older usage', () => {
  const branch = [msg('u', 'user', 'x'.repeat(10000)), answer('a', 9000)];
  const edited = [...branch, { id: 'edit', type: 'context_edit', targetId: 'u', replacement: { content: 'short' } }];
  assert.equal(estimateContext(edited).tokens, 4);
  const removed = [...edited, { id: 'delete', type: 'context_edit', targetId: 'u', replacement: null }];
  assert.equal(estimateContext(removed).tokens, 2);
  assert.equal(estimateContext([...removed, answer('new', 40)]).tokens, 40);
});

test('empty and legacy messages produce finite estimates', () => {
  assert.equal(estimateContext([]).tokens, 0);
  assert.equal(estimateContext([msg('u', 'user', null), msg('a', 'assistant', null)]).tokens, 0);
});
