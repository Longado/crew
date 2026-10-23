import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createSecurityService } from '../src/security/adapter.ts';
import { openDb } from '../src/db.ts';
import { serve } from '../src/server.ts';

test('unconfigured native and scanner operations never attempt a process while the catalog and HTTP page remain readable', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'crew-security-defaults-')));
  const vars = ['CREW_ASKKEY_HELPER', 'CREW_SECURITY_SCANNER', 'CREW_VAULT_DIR'];
  const previous = vars.map(key => process.env[key]);
  for (const key of vars) delete process.env[key];
  process.env.CREW_VAULT_DIR = dir;
  let attempts = 0;
  t.mock.method(childProcess, 'spawn', () => { attempts++; throw Error('unexpected process'); });
  // A regression in the environment override must fail without reading the real vault.
  const originalLstat = fsPromises.lstat;
  t.mock.method(fsPromises, 'lstat', (...args: any[]) => {
    const path = String(args[0]);
    assert.ok(path === '/' || path === dir || path.startsWith(dir + '/') || dir.startsWith(path + '/'), 'filesystem access outside the synthetic tree');
    return Reflect.apply(originalLstat, fsPromises, args);
  });
  syncBuiltinESMExports();
  const id = '11111111-2222-4333-8444-555555555555';
  await writeFile(join(dir, 'catalog.json'), JSON.stringify({
    schemaVersion: 1, storage: 'macos-keychain', updatedAt: '2026-01-01T00:00:00Z',
    credentials: [{ id, name: 'Synthetic local key', provider: 'synthetic', category: 'api-key', environmentVariables: ['SYNTHETIC_API_KEY'], sources: [], usageInstructions: '已集中保存；授权使用尚未接入。', canProbe: false, status: 'stored_unconnected' }],
  }), { mode: 0o600 });
  const service = createSecurityService({ nativeEnabled: true });
  const db = openDb(':memory:');
  const projectId = db.createProject({ name: 'Synthetic project', goal: null, dirs: [dir] });
  const inert = { close: async () => {} };
  const server = serve(db, 0, inert as any, inert as any, service);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(base + '/api/security/credentials');
    assert.equal(response.status, 200);
    const catalog = await response.json() as any;
    assert.equal(catalog.status, 'available');
    assert.equal(catalog.credentials[0].name, 'Synthetic local key');
    assert.equal(catalog.nativeAvailable, false);
    assert.equal(catalog.scanAvailable, false);
    for (const [path, type] of [['/', 'text/html'], ['/security.js', 'text/javascript'], ['/security.css', 'text/css']]) {
      const asset = await fetch(base + path);
      assert.equal(asset.status, 200);
      assert.ok(asset.headers.get('content-type')?.startsWith(type));
    }
    for (const [path, body] of [
      ['/inputs', { provider: 'ark' }], ['/probes', { credentialId: 'native-synthetic' }],
      ['/scans', { projectId, directoryId: 'directory-0' }],
    ] as const) {
      const result = await fetch(base + '/api/security' + path, { method: 'POST', headers: { 'x-corpus': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const operation = await result.json() as any;
      assert.equal(operation.state, 'failed');
      assert.equal(operation.error.code, 'unavailable');
      assert.match(operation.error.message, /不可用/);
      const cancelled = await service.cancelOperation(operation.id, operation.projectId);
      assert.equal(cancelled?.state, 'failed');
    }
    assert.equal(attempts, 0);
    await service.close();
    assert.equal(attempts, 0);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await service.close(); db.raw.close();
    t.mock.restoreAll(); syncBuiltinESMExports();
    vars.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    await rm(dir, { recursive: true, force: true });
  }
});
