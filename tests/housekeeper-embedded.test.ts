import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlan, openManualInterfaces, runHousekeeper } from '../scripts/housekeeper/housekeeper.ts';
import { openDb } from '../src/db.ts';
import { serve } from '../src/server.ts';

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'housekeeper-desktop-'));
  return { root, env: { CORPUS_HOME: join(root, 'crew'), CORPUS_DB: join(root, 'crew/corpus.db') },
    clean: () => rmSync(root, { recursive: true, force: true }) };
}

test('embedded mode is explicit and dry-run remains read-only', async () => {
  const f = fixture();
  try {
    assert.equal(createPlan([], f.env).embedded, false);
    assert.equal(createPlan(['--embedded'], f.env).embedded, true);
    const output: string[] = [];
    await runHousekeeper(['--embedded', '--dry-run'], { env: f.env, log: value => output.push(value),
      openNative: async () => { throw Error('Dry run must not open native UI'); } });
    assert.equal(JSON.parse(output[0]).action, 'plan-only');
  } finally { f.clean(); }
});

test('embedded native setup keeps helper health checks without opening a browser', async () => {
  const f = fixture();
  try {
    const plan = createPlan(['--embedded'], { ...f.env, CREW_ASKKEY_HELPER: join(f.root, 'helper') });
    const calls: string[] = [];
    await openManualInterfaces(plan, () => {}, {
      home: () => f.root,
      stat: () => ({ isDirectory: () => true, isSymbolicLink: () => false, mode: 0o40700 }) as any,
      realpath: path => path,
      execute: async (program, args) => {
        calls.push(`${program}:${args.join(',')}`);
        return { stdout: JSON.stringify({ success: { _0: { health: { _0: { status: 'ok' } } } } }), stderr: '' };
      },
      launch: () => { throw Error('Healthy helper must not be relaunched'); },
    });
    assert.deepEqual(calls, [`${plan.config.helperPath}:health`]);
  } finally { f.clean(); }
});

test('embedded host receives the real ready URL and reuses an existing service safely', async () => {
  const f = fixture();
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  let first: Awaited<ReturnType<typeof runHousekeeper>>;
  const logs: string[] = [];
  try {
    const dependencies = { env: f.env, openDb, serve, log: (value: string) => logs.push(value), openNative: async () => {} };
    first = await runHousekeeper(['--embedded', '--port', String(port)], dependencies);
    assert.equal(first!.reused, false);
    assert.deepEqual(JSON.parse(logs.find(line => line.startsWith('{'))!), { event: 'ready', url: `http://127.0.0.1:${port}/#/today`, reused: false });
    const second = await runHousekeeper(['--embedded', '--port', String(port)], dependencies);
    assert.equal(second!.reused, true);
    assert.equal(JSON.parse(logs.filter(line => line.startsWith('{')).at(-1)!).reused, true);
    second!.close();
    const response = await fetch(`http://127.0.0.1:${port}/api/today`, { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    assert.equal(typeof (await response.json() as { source: object }).source, 'object');
    assert.equal(logs.filter(line => line.startsWith('{')).length, 2);
  } finally { first?.close(); f.clean(); }
});
