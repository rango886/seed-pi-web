import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startConversationServer, connectClient, waitUntil } from './helpers/conversation-server.mjs';

// All files and processes belong to this isolated fixture, never the user's sessions.
test('deleting a busy owned session stops its process, removes the file and archive, and notifies all windows', { skip: !process.env.SEED_PI_WEB_TEST_PI, timeout: 90000 }, async t => {
  const fixture = await startConversationServer({ modelDelay: 2000 });
  t.after(() => fixture.close());
  const owner = await connectClient(fixture.url, 'delete-owner');
  const observer = await connectClient(fixture.url, 'delete-observer');
  t.after(() => { owner.ws.close(); observer.ws.close(); });
  const { agent } = await owner.call('ensure_agent', { cwd: fixture.dir });
  await owner.call('rpc', { agentId: agent.id, cmd: { type: 'prompt', message: '测试删除运行中的会话' } });
  const active = await waitUntil(() => owner.records.findLast(m => m.t === 'agents')?.list.find(a => a.id === agent.id && a.saved && a.running));
  const file = active.sessionFile;
  await observer.call('open_session', { file });
  const archiveResponse = await fetch(fixture.url + '/api/sessions/archive', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file, archived: true }),
  });
  assert.equal(archiveResponse.status, 200);

  const remove = file => fetch(fixture.url + '/api/sessions?file=' + encodeURIComponent(file), { method: 'DELETE' });
  assert.equal((await remove(path.join(fixture.dir, 'outside.jsonl'))).status, 400, 'validation still protects files outside session roots');
  const result = await remove(file);
  assert.equal(result.status, 200, await result.text());
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  for (const client of [owner, observer]) {
    await waitUntil(() => client.records.some(m => m.t === 'session_deleted' && m.file === file));
    const exit = client.records.find(m => m.t === 'agent_exit' && m.agentId === agent.id);
    assert.equal(exit?.quiet, true, 'intentional shutdown must not appear as a process crash');
    assert.ok(!client.records.findLast(m => m.t === 'agents').list.some(a => a.id === agent.id));
    assert.ok(client.records.indexOf(exit) < client.records.findIndex(m => m.t === 'session_deleted'), 'wait for process exit before reporting deletion');
  }
  await assert.rejects(owner.call('rpc', { agentId: agent.id, cmd: { type: 'get_state' } }));
  const sessions = await (await fetch(fixture.url + '/api/sessions?all=1')).json();
  assert.ok(!sessions.some(s => s.file === file));
  const archive = JSON.parse(await fs.readFile(path.join(fixture.dir, 'web', 'session-archive.json'), 'utf8'));
  assert.ok(!JSON.stringify(archive).includes(path.basename(file)));
  // No late stream or graceful shutdown write may recreate the deleted file.
  await new Promise(resolve => setTimeout(resolve, 300));
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});
