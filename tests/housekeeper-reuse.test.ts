import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, realpathSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHousekeeper } from '../scripts/housekeeper/housekeeper.ts';
import { openDb } from '../src/db.ts';
import { serve } from '../src/server.ts';

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'housekeeper-reuse-'));
  const corpus = join(root, 'crew');
  mkdirSync(corpus, { recursive: true });
  return { env: { CORPUS_HOME: corpus, CORPUS_DB: join(corpus, 'corpus.db') }, clean: () => rmSync(root, { recursive: true }) };
}
// A listen that fails with EADDRINUSE, so the test controls what the busy port answers.
function busyRuntime(f: ReturnType<typeof fixture>, calls: string[], logs: string[], signals: AbortSignal[] = []) {
  const server = new EventEmitter() as any;
  server.close = (callback: () => void) => { calls.push('close-server'); callback?.(); };
  return { env: f.env, log: (value: string) => { logs.push(value); }, prepare: () => { calls.push('prepare'); },
    openDb: () => ({ raw: { close: () => { calls.push('close-db'); } } }),
    serve: () => { calls.push('serve'); queueMicrotask(() => server.emit('error', Object.assign(Error('EADDRINUSE'), { code: 'EADDRINUSE' }))); return server; },
    openNative: async (_plan: unknown, signal: AbortSignal) => { calls.push('open'); signals.push(signal); } };
}
async function listen(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, port: (server.address() as { port: number }).port };
}
const stop = (server: Server) => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
const todayShape = { date: '2026-10-24', source: { kind: 'local_corpus' } };

test('port already serving the Crew today page: opens it once and returns without owning a server', async () => {
  const f = fixture(); const requests: string[] = [];
  const { server, port } = await listen((request, response) => { requests.push(`${request.method} ${request.url}`); response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(todayShape)); });
  try {
    const calls: string[] = []; const logs: string[] = []; const signals: AbortSignal[] = [];
    const result = (await runHousekeeper(['--port', String(port)], busyRuntime(f, calls, logs, signals)))!;
    assert.equal(result.reused, true);
    assert.equal(result.plan.port, port);
    assert.deepEqual(calls, ['prepare', 'serve', 'close-server', 'close-db', 'open']);
    assert.deepEqual(requests, ['GET /api/today']);
    assert.deepEqual(logs, [`本地管家已在运行（端口 ${port}），直接打开今日页。`]);
    assert.equal(signals.length, 1); assert.equal(signals[0].aborted, false);
    result.close(); result.close();
    assert.deepEqual(calls, ['prepare', 'serve', 'close-server', 'close-db', 'open']);
  } finally { await stop(server); f.clean(); }
});

test('port answering something other than the Crew today page keeps the occupied-port error and opens nothing', async () => {
  const f = fixture();
  const answers: [number, string][] = [
    [404, JSON.stringify(todayShape)], [500, JSON.stringify(todayShape)], [200, 'not json'], [200, ''], [200, 'null'], [200, '[]'],
    [200, JSON.stringify({ source: {} })], [200, JSON.stringify({ date: '2026-10-24' })],
    [200, JSON.stringify({ date: 20261024, source: {} })], [200, JSON.stringify({ date: '2026-10-24', source: 'local_corpus' })],
    [200, JSON.stringify({ date: '2026-10-24', source: null })], [200, JSON.stringify({ date: '2026-10-24', source: [] })],
  ];
  try {
    for (const [status, body] of answers) {
      let requests = 0;
      const { server, port } = await listen((_request, response) => { requests++; response.statusCode = status; response.end(body); });
      try {
        const calls: string[] = [];
        await assert.rejects(runHousekeeper(['--port', String(port)], busyRuntime(f, calls, [])), new RegExp(`端口 ${port} 已被占用；本次没有接管已有服务`), `${status} ${body}`);
        assert.deepEqual(calls, ['prepare', 'serve', 'close-server', 'close-db'], `${status} ${body}`);
        assert.equal(requests, 1, `${status} ${body}`);
      } finally { await stop(server); }
    }
  } finally { f.clean(); }
});

test('nothing answering on the port keeps the occupied-port error and opens nothing', async () => {
  const f = fixture();
  const { server, port } = await listen(() => {}); await stop(server);
  try {
    const calls: string[] = [];
    await assert.rejects(runHousekeeper(['--port', String(port)], busyRuntime(f, calls, [])), /已被占用；本次没有接管已有服务/);
    assert.deepEqual(calls, ['prepare', 'serve', 'close-server', 'close-db']);
  } finally { f.clean(); }
});

test('port that never answers times out after about one second and opens nothing', async () => {
  const f = fixture();
  let requests = 0;
  const { server, port } = await listen(() => { requests++; });
  try {
    const calls: string[] = []; const started = Date.now();
    await assert.rejects(runHousekeeper(['--port', String(port)], busyRuntime(f, calls, [])), /已被占用；本次没有接管已有服务/);
    assert.equal(requests, 1);
    assert.ok(Date.now() - started < 3000, 'probe must not wait much longer than one second');
    assert.deepEqual(calls, ['prepare', 'serve', 'close-server', 'close-db']);
  } finally { await stop(server); f.clean(); }
});

test('a second real housekeeper on the same port reuses the first one instead of failing', async () => {
  const f = fixture(); let first: ReturnType<typeof serve> | undefined; let running: Awaited<ReturnType<typeof runHousekeeper>> | undefined;
  try {
    running = await runHousekeeper([], { env: f.env, log: () => {}, openDb,
      serve: (database, _port, teams, terminals, security, source) => (first = serve(database, 0, teams, terminals, security, source)),
      openNative: async () => {} });
    const port = (first!.address() as { port: number }).port;
    const opened: string[] = []; const logs: string[] = [];
    const second = await runHousekeeper(['--port', String(port)], { env: f.env, log: value => logs.push(value), openDb, serve,
      openNative: async plan => { opened.push(plan.url); } });
    assert.equal(second!.reused, true);
    assert.deepEqual(opened, [`http://127.0.0.1:${port}/#/today`]);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/today`)).status, 200);
    assert.equal(running!.reused, false);
  } finally {
    if (running && first) { const closed = once(first, 'close'); running.close(); await closed; }
    f.clean();
  }
});
