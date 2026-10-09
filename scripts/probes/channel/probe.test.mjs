import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('real stdio and HTTP: authenticate, push, distinguish transport from reply, reject duplicates and unknown replies', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-channel-unit-'));
  const client = new Client({ name: 'probe-test', version: '0.0.1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('./channel.mjs', import.meta.url))],
    env: { CORPUS_PROBE_DIR: dir, CORPUS_PROBE_TOKEN: 'test-token' },
    stderr: 'pipe',
  });
  t.after(async () => { await client.close(); rmSync(dir, { recursive: true, force: true }); });
  const notices = [];
  client.fallbackNotificationHandler = async message => { notices.push(message); };
  await client.connect(transport);
  assert.deepEqual(client.getServerCapabilities().experimental['claude/channel'], {});
  for (let i = 0; i < 100 && !existsSync(join(dir, 'endpoint.json')); i++) await sleep(20);
  const { port } = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8'));
  const post = (body, token = 'test-token') => fetch(`http://127.0.0.1:${port}/inbox`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  const body = { message_id: 'test_001', content: 'Reply TEST_OK' };
  assert.equal((await post(body, 'wrong-token')).status, 401);
  assert.equal((await post({})).status, 400);
  assert.equal((await post(body)).status, 202);
  for (let i = 0; i < 100 && !notices.length; i++) await sleep(20);
  assert.equal(notices[0].method, 'notifications/claude/channel');
  assert.equal(notices[0].params.meta.message_id, 'test_001');
  let events = readFileSync(join(dir, 'channel-events.jsonl'), 'utf8');
  assert.ok(events.includes('transport_written'));
  assert.ok(!events.includes('"kind":"reply"'));
  assert.equal((await post(body)).status, 409);
  const missing = await client.callTool({ name: 'reply', arguments: { message_id: 'unknown', text: 'TEST_OK' } });
  assert.equal(missing.isError, true);
  const result = await client.callTool({ name: 'reply', arguments: { message_id: 'test_001', text: 'TEST_OK' } });
  assert.equal(result.isError, undefined);
  events = readFileSync(join(dir, 'channel-events.jsonl'), 'utf8');
  assert.ok(events.includes('"kind":"reply","message_id":"test_001","text":"TEST_OK"'));
});
