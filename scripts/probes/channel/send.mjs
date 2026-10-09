// A 202 response is not a pass: wait for the matching reply tool invocation.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const dir = process.argv[2];
if (!dir) throw new Error('Usage: node send.mjs <dedicated-test-directory>');
const config = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8'));
const token = config.mcpServers['corpus-probe'].env.CORPUS_PROBE_TOKEN;
const { port } = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8'));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
const message_id = randomUUID();
const expected = 'CORPUS_CHANNEL_ROUNDTRIP_OK';
const response = await fetch(`http://127.0.0.1:${port}/inbox`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ message_id, content: `Use the reply tool with message_id=${message_id} and text=${expected}.` }),
  signal: AbortSignal.timeout(5000),
});
if (response.status !== 202) throw new Error(`Transport failed: HTTP ${response.status}`);
console.log('TRANSPORT_WRITTEN', message_id);
const log = join(dir, 'channel-events.jsonl');
let passed = false;
for (let i = 0; i < 120; i++) {
  const lines = existsSync(log) ? readFileSync(log, 'utf8').split('\n').slice(0, -1) : [];
  const reply = lines.map(line => JSON.parse(line)).find(event => event.kind === 'reply' && event.message_id === message_id);
  if (reply) {
    passed = reply.text === expected;
    console.log(passed ? 'PASS' : 'FAIL', JSON.stringify(reply));
    break;
  }
  await sleep(250);
}
if (!passed) { console.error('No matching correct reply within 30 seconds.'); process.exitCode = 1; }
