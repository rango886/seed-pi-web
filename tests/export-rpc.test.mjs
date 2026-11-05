import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startConversationServer, connectClient, waitUntil } from './helpers/conversation-server.mjs';

test('real pi HTML exports can be opened over HTTP using the session working directory', { skip: !process.env.SEED_PI_WEB_TEST_PI, timeout: 60000 }, async () => {
  const fixture = await startConversationServer();
  let client;
  try {
    client = await connectClient(fixture.url, 'export-test');
    const { agent } = await client.call('ensure_agent', { cwd: fixture.dir });
    const rpc = async cmd => {
      const reply = await client.call('rpc', { agentId: agent.id, cmd });
      assert.ok(reply.success, reply.error);
      return reply.data;
    };
    await rpc({ type: 'prompt', message: '用于导出测试的消息' });
    await waitUntil(() => client.records.some(m => m.t === 'rec' && m.rec.type === 'agent_settled'));
    const modelCalls = fixture.requests.length;
    await fs.mkdir(path.join(fixture.dir, 'exports'));
    for (const outputPath of [undefined, 'exports/导出 #1.html', path.join(fixture.dir, 'absolute.html')]) {
      const result = await rpc({ type: 'export_html', ...(outputPath ? { outputPath } : {}) });
      const file = path.resolve(fixture.dir, result.path);
      assert.ok((await fs.stat(file)).size > 0);
      const url = new URL('/api/fs/raw', fixture.url);
      url.searchParams.set('path', file);
      const response = await fetch(url);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/html/);
      assert.match(await response.text(), /<!doctype html/i);
    }
    assert.equal(fixture.requests.length, modelCalls, 'exporting does not invoke the model');
  } finally {
    client?.ws.close();
    await fixture.close();
  }
});
