import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeReadyGate } from '../src/bridge/mcp-ready.ts';
const event = (threadId: string, status: string, name = 'corpus_bridge') => ({ threadId, name, status });
test('real startup ready event is retained before thread/start response', async () => {
  const gate = createBridgeReadyGate(); gate.accept(event('exact-thread', 'starting')); gate.accept(event('exact-thread', 'ready'));
  await gate.wait('exact-thread'); gate.close();
});
test('only the exact thread and Bridge ready event release its first turn', async () => {
  const gate = createBridgeReadyGate(); let released = false; const waiting = gate.wait('exact-thread').then(() => { released = true; });
  gate.accept(event('other-thread', 'ready')); gate.accept(event('exact-thread', 'ready', 'other-server')); gate.accept(event('exact-thread', 'starting'));
  await Promise.resolve(); assert.equal(released, false);
  gate.accept(event('exact-thread', 'ready')); await waiting; assert.equal(released, true); gate.close();
});
test('startup failure, stop and timeout reject instead of starting a model', async () => {
  const failed = createBridgeReadyGate(); failed.accept(event('thread', 'failed')); await assert.rejects(failed.wait('thread'), /initialization failed/); failed.close();
  const stopped = createBridgeReadyGate(); const waiting = stopped.wait('thread'); stopped.close(); await assert.rejects(waiting, /Team stopped/); await assert.rejects(stopped.wait('thread'), /Team stopped/);
  const timeout = createBridgeReadyGate(); await assert.rejects(timeout.wait('thread', 5), /Timed out/); timeout.close();
});
