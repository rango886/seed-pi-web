import test from 'node:test';
import assert from 'node:assert/strict';
import { startConversationServer, connectClient, waitUntil } from './helpers/conversation-server.mjs';

test('real RPC edit and version switching preserve branches, synchronize viewers, and split usage scopes', { skip: !process.env.SEED_PI_WEB_TEST_PI, timeout: 60000 }, async () => {
  const fixture = await startConversationServer();
  let owner, viewer;
  try {
    owner = await connectClient(fixture.url, 'owner');
    const lazy = await owner.call('create_session', { cwd: fixture.dir });
    assert.ok(lazy.lazy);
    const { agent } = await owner.call('ensure_agent', { cwd: fixture.dir });
    const rpc = async cmd => {
      const r = await owner.call('rpc', { agentId: agent.id, cmd });
      assert.ok(r.success, r.error);
      return r.data;
    };
    const settled = async n => waitUntil(() => owner.records.filter(m => m.t === 'rec' && m.rec.type === 'agent_settled').length >= n);
    await rpc({ type: 'prompt', message: '公共问题' });
    await settled(1);
    await rpc({ type: 'prompt', message: '原问题' });
    await settled(2);
    const before = await rpc({ type: 'get_web_snapshot' });
    const file = (await rpc({ type: 'get_state' })).sessionFile;
    viewer = await connectClient(fixture.url, 'viewer');
    const attached = await viewer.call('open_session', { file });
    assert.equal(attached.owner, false);
    await assert.rejects(viewer.call('rpc', { agentId: agent.id, cmd: { type: 'web_navigate', targetId: before.nodes[0].id, expectedLeafId: before.leafId } }), /接管/);

    await rpc({ type: 'set_thinking_level', level: 'high' });
    const ready = await rpc({ type: 'get_web_snapshot' });
    const start = viewer.records.length;
    await rpc({ type: 'web_edit', targetId: before.nodes[1].id, expectedLeafId: ready.leafId, message: '修改后的问题' });
    await settled(3);
    await waitUntil(() => viewer.records.filter(m => m.t === 'rec' && m.rec.type === 'agent_settled').length >= 1);
    let after = await rpc({ type: 'get_web_snapshot' });
    assert.equal(after.nodes.length, 3);
    assert.deepEqual(after.messages.filter(m => m.role === 'user').map(m => m.content[0]?.text ?? m.content), ['公共问题', '修改后的问题']);
    assert.equal(after.branchStats.assistantMessages, 2);
    assert.equal(after.totals.assistantMessages, 3);
    assert.ok(after.totals.cost > after.branchStats.cost);
    assert.equal((await rpc({ type: 'get_state' })).thinkingLevel, 'high');
    const events = viewer.records.slice(start);
    const prefixIndex = events.findIndex(m => m.t === 'branch_changed');
    const newUserIndex = events.findIndex(m => m.t === 'rec' && m.rec.type === 'message_start' && m.rec.message.role === 'user');
    assert.ok(prefixIndex >= 0 && newUserIndex > prefixIndex, 'new prefix reaches viewers before new-path streaming');
    assert.equal(events[prefixIndex].snapshot.messages.filter(m => m.role === 'user').length, 1);
    assert.ok(!events.some(m => m.rec?.method === 'notify' && m.rec.message.startsWith('seed-web-tree:')), 'bridge replies stay private');

    const restored = await rpc({ type: 'web_restore_selection', expectedLeafId: after.leafId });
    assert.equal(restored.thinkingLevel, 'low');
    assert.equal((await rpc({ type: 'get_state' })).thinkingLevel, 'low');
    await rpc({ type: 'set_thinking_level', level: 'high' });
    after = await rpc({ type: 'get_web_snapshot' });
    await assert.rejects(rpc({ type: 'web_edit', targetId: before.nodes[0].id, expectedLeafId: after.leafId, message: 'invalid image', images: {} }), /图片格式/);
    assert.equal((await rpc({ type: 'get_web_snapshot' })).leafId, after.leafId, 'invalid payloads cannot move the cursor');
    const metadata = await rpc({ type: 'get_web_snapshot', metadataOnly: true });
    assert.equal(metadata.messages, undefined, 'routine tree refreshes do not resend images or full tool outputs');
    assert.ok(metadata.messageIds.some(m => m._entryId === before.nodes[0].id));
    const oldVersion = after.nodes.find(n => n.id === before.nodes[1].id);
    const requestCount = fixture.requests.length;
    await rpc({ type: 'web_navigate', targetId: oldVersion.targetId, expectedLeafId: after.leafId });
    const switched = await rpc({ type: 'get_web_snapshot' });
    assert.equal(fixture.requests.length, requestCount, 'navigation does not call a model or summarize');
    assert.ok(switched.nodes.find(n => n.id === oldVersion.id).active);
    assert.equal((await rpc({ type: 'get_state' })).thinkingLevel, 'high');
    await assert.rejects(rpc({ type: 'web_navigate', targetId: oldVersion.targetId, expectedLeafId: 'stale' }), /已经改变/);
    await rpc({ type: 'web_label', targetId: oldVersion.id, label: '保守方案' });
    const named = (await rpc({ type: 'get_web_snapshot' })).nodes.find(n => n.id === oldVersion.id);
    assert.equal(named.label, '保守方案');
    assert.equal(named.text, '原问题', 'naming never replaces the prompt text');
    const raw = await rpc({ type: 'get_entries' });
    const savedPrompt = raw.entries.find(e => e.id === oldVersion.id).message.content;
    assert.equal(typeof savedPrompt === 'string' ? savedPrompt : savedPrompt.filter(b => b.type === 'text').map(b => b.text).join(''), '原问题');
    assert.ok(raw.entries.some(e => e.type === 'label' && e.targetId === oldVersion.id && e.label === '保守方案'), 'names use native JSONL label entries without changing the format');

    const labelled = await rpc({ type: 'get_web_snapshot' });
    const trunk = labelled.nodes.find(n => n.id === before.nodes[0].id);
    await rpc({ type: 'web_navigate', targetId: trunk.turnTargetId, expectedLeafId: labelled.leafId });
    const atTrunk = await rpc({ type: 'get_web_snapshot' });
    assert.deepEqual(atTrunk.messages.filter(m => m.role === 'user').map(m => m._entryId), [trunk.id]);
    assert.equal(atTrunk.branchStats.assistantMessages, 1, 'intermediate nodes keep their own answer but not later turns');
    assert.equal(fixture.requests.length, requestCount, 'continuing from a trunk never generates or summarizes');

    const prepared = await rpc({ type: 'web_navigate', targetId: oldVersion.id, expectedLeafId: atTrunk.leafId });
    assert.equal(prepared.editorText, '原问题');
    const beforePrompt = await rpc({ type: 'get_web_snapshot' });
    assert.deepEqual(beforePrompt.messages.filter(m => m.role === 'user').map(m => m._entryId), [trunk.id]);
    assert.equal(beforePrompt.branchStats.assistantMessages, 1, 'the selected prompt and its answer are not sent yet');
    assert.equal(beforePrompt.nodes.length, 3, 'preparing a prompt preserves all existing branches');
    const firstPrompt = await rpc({ type: 'web_navigate', targetId: trunk.id, expectedLeafId: beforePrompt.leafId });
    assert.equal(firstPrompt.editorText, '公共问题');
    assert.equal((await rpc({ type: 'get_web_snapshot' })).messages.filter(m => m.role === 'user').length, 0);
    assert.equal((await rpc({ type: 'get_state' })).thinkingLevel, 'high');
    assert.equal(fixture.requests.length, requestCount, 'preparing a selected prompt never sends it or calls a model');

    const forked = await rpc({ type: 'fork', entryId: oldVersion.id });
    assert.equal(forked.cancelled, false);
    const forkState = await rpc({ type: 'get_state' });
    assert.notEqual(forkState.sessionFile, file);
    assert.equal((await rpc({ type: 'get_web_snapshot' })).nodes.length, 1, 'fork contains history before the chosen prompt');
    assert.equal(fixture.requests.length, requestCount);
    assert.ok(viewer.records.some(m => m.t === 'session_moved'), 'viewers stay on the original session after fork');
  } catch (error) {
    error.message += '\n' + fixture.output();
    throw error;
  } finally {
    owner?.ws.close(); viewer?.ws.close();
    await fixture.close();
  }
});
