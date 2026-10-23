import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, existsSync, realpathSync, symlinkSync, statSync, rmSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlan, runHousekeeper, prepareStorage, openManualInterfaces } from '../scripts/housekeeper/housekeeper.ts';
import { housekeeperConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { serve } from '../src/server.ts';
import { createSecurityService } from '../src/security/adapter.ts';
import { createTaskSource } from '../src/today/source.ts';
import { DatabaseSync } from 'node:sqlite';
import type { buildToday } from '../src/engine/today.ts';
import type { CredentialCatalog } from '../src/security/types.ts';

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'housekeeper-entry-'));
  const corpus = join(root, 'crew');
  const env = { CORPUS_HOME: corpus, CORPUS_DB: join(corpus, 'corpus.db') };
  const configFile = join(corpus, 'housekeeper.json');
  return { root, corpus, env, configFile, writeConfig(value: unknown) {
    mkdirSync(corpus, { recursive: true });
    writeFileSync(configFile, JSON.stringify(value));
  }, clean: () => rmSync(root, { recursive: true }) };
}
function serverStub(calls: string[], listening = true) {
  const server = new EventEmitter() as any;
  server.close = (callback: () => void) => { calls.push('close-server'); callback?.(); };
  return { server, serve: () => { calls.push('serve'); if (listening) queueMicrotask(() => { calls.push('listening'); server.emit('listening'); }); return server; } };
}
function runtime(f: ReturnType<typeof fixture>, calls: string[], listening = true) {
  const stub = serverStub(calls, listening);
  return { ...stub, dependencies: {
    env: f.env, log: () => {}, prepare: () => { calls.push('prepare'); },
    openDb: () => ({ raw: { close: () => { calls.push('close-db'); } } }),
    serve: stub.serve, openNative: async () => { calls.push('open'); },
  } };
}

test('import and dry run do not create storage or start services', async () => {
  const f = fixture();
  try {
    const calls: string[] = [];
    await runHousekeeper(['--dry-run'], runtime(f, calls).dependencies);
    assert.deepEqual(calls, []);
    assert.equal(existsSync(f.corpus), false);
  } finally { f.clean(); }
});

test('formal data paths and strict port arguments replace the lab namespace', () => {
  const f = fixture();
  try {
    const plan = createPlan([], f.env);
    assert.equal(plan.corpus, f.corpus);
    assert.equal(plan.database, f.env.CORPUS_DB);
    assert.equal(plan.port, 4198);
    assert.deepEqual(plan.config, {});
    for (const arg of ['0', '65536', '1.5', '4198x', '-1', 'http://example.test', '']) assert.throws(() => createPlan(['--port', arg], f.env), /端口/);
    assert.throws(() => createPlan(['--port'], f.env), /端口/);
    assert.throws(() => createPlan(['--unknown'], f.env), /未知参数/);
  } finally { f.clean(); }
});

test('configuration uses environment over JSON and no implicit external components', () => {
  const f = fixture();
  try {
    const values = { helperPath: join(f.root, 'helper'), launcherPath: join(f.root, 'launcher'), scannerPath: join(f.root, 'scan.py'), vaultDir: join(f.root, 'vault'), taskDatabase: join(f.root, 'tasks.db'), taskSnapshotPath: join(f.root, 'snapshot.json') };
    assert.deepEqual(housekeeperConfig(f.env), {});
    f.writeConfig(values);
    assert.deepEqual(housekeeperConfig(f.env), values);
    const names = ['CREW_ASKKEY_HELPER', 'CREW_ASKKEY_LAUNCHER', 'CREW_SECURITY_SCANNER', 'CREW_VAULT_DIR', 'CREW_TASK_DB', 'CREW_TASK_SNAPSHOT'];
    const overrides = Object.fromEntries(names.map((key, i) => [key, join(f.root, `override-${i}`)]));
    assert.deepEqual(housekeeperConfig({ ...f.env, ...overrides }), Object.fromEntries(Object.keys(values).map((key, i) => [key, join(f.root, `override-${i}`)])));
  } finally { f.clean(); }
});

test('invalid JSON, field types, unknown keys, relative paths and incomplete source fail before startup', async () => {
  const f = fixture();
  try {
    const calls: string[] = [];
    for (const value of [null, [], 3, { helperPath: 9 }, { launcherPath: false }, { scannerPath: {} }, { vaultDir: ['x'] }, { taskDatabase: null }, { taskSnapshotPath: 3 }, { helperPath: 'relative' }, { vaultDir: '' }, { unknown: '/path' }, { taskDatabase: join(f.root, 'source.db') }, { taskSnapshotPath: join(f.root, 'snapshot.json') }]) {
      f.writeConfig(value);
      await assert.rejects(runHousekeeper([], runtime(f, calls).dependencies), /配置|路径|成对/);
    }
    f.writeConfig({});
    for (const value of ['', 'relative', '/bad\u0000path']) assert.throws(() => housekeeperConfig({ ...f.env, CREW_ASKKEY_HELPER: value }), /路径/);
    writeFileSync(f.configFile, '{invalid');
    await assert.rejects(runHousekeeper([], runtime(f, calls).dependencies), /housekeeper\.json.*JSON/);
    assert.deepEqual(calls, []);
  } finally { f.clean(); }
});

test('config file and configured path components reject symlinks including dangling links', () => {
  const f = fixture();
  try {
    mkdirSync(f.corpus);
    const target = join(f.root, 'target.json');
    writeFileSync(target, '{}');
    symlinkSync(target, f.configFile);
    assert.throws(() => housekeeperConfig(f.env), /符号链接/);
    rmSync(f.configFile);
    const linked = join(f.root, 'linked');
    symlinkSync(join(f.root, 'missing'), linked);
    for (const key of ['helperPath', 'launcherPath', 'scannerPath', 'vaultDir', 'taskDatabase', 'taskSnapshotPath']) {
      f.writeConfig({ [key]: join(linked, 'component') });
      assert.throws(() => housekeeperConfig(f.env), /符号链接/);
    }
    f.writeConfig({});
    assert.throws(() => housekeeperConfig({ ...f.env, CREW_ASKKEY_HELPER: join(linked, 'helper') }), /符号链接/);
    assert.throws(() => housekeeperConfig({ ...f.env, CREW_ASKKEY_HELPER: `${linked}/../helper` }), /符号链接/);
    symlinkSync(f.corpus, join(f.root, 'linked-home'));
    assert.throws(() => housekeeperConfig({ CORPUS_HOME: join(f.root, 'linked-home') }), /符号链接/);
    assert.throws(() => housekeeperConfig({ CORPUS_HOME: `${f.root}/linked-home/../other` }), /符号链接/);
    assert.throws(() => createPlan([], { ...f.env, CORPUS_DB: `${f.root}/linked-home/../other.db` }), /符号链接/);
  } finally { f.clean(); }
});

test('task snapshot cannot overwrite Crew storage or its source', () => {
  const f = fixture();
  try {
    for (const target of [f.env.CORPUS_DB, `${f.env.CORPUS_DB}-wal`, join(f.root, 'tasks.db')]) {
      f.writeConfig({ taskDatabase: join(f.root, 'tasks.db'), taskSnapshotPath: target });
      assert.throws(() => createPlan([], f.env), /分开/);
    }
  } finally { f.clean(); }
});

test('storage creates private directories without changing existing permissions and rejects symlinks', () => {
  const f = fixture();
  try {
    const plan = createPlan([], f.env);
    prepareStorage(plan);
    assert.equal(statSync(plan.corpus).mode & 0o777, 0o700);
    chmodSync(plan.corpus, 0o755);
    prepareStorage(plan);
    assert.equal(statSync(plan.corpus).mode & 0o777, 0o755);
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const path = `${plan.database}${suffix}`;
      symlinkSync(join(f.root, 'elsewhere'), path);
      assert.throws(() => prepareStorage(plan), /符号链接/);
      rmSync(path);
    }
  } finally { f.clean(); }
});

test('configured services receive only explicit paths; no source means no task factory', async () => {
  const f = fixture();
  try {
    for (const configured of [false, true]) {
      const calls: string[] = [];
      const values = { helperPath: join(f.root, 'helper'), scannerPath: join(f.root, 'scan.py'), vaultDir: join(f.root, 'vault'), taskDatabase: join(f.root, 'tasks.db'), taskSnapshotPath: join(f.root, 'snapshot.json') };
      if (configured) f.writeConfig(values);
      let securityOptions: any; let sourceOptions: any; let served: any[] = [];
      const security = createSecurityService({ nativeEnabled: false, localCatalogPath: false, scriptPath: undefined });
      const source = { read: () => undefined, refresh: () => { throw Error('not used'); } };
      const r = runtime(f, calls);
      const result = await runHousekeeper([], { ...r.dependencies,
        createSecurity: options => { securityOptions = options; return security; },
        createTasks: options => { sourceOptions = options; return source; },
        serve: (...args) => { served = args; return r.serve(); },
      });
      assert.equal(securityOptions.localCatalogPath, configured ? join(values.vaultDir, 'catalog.json') : false);
      assert.equal(securityOptions.nativeEnabled, configured);
      assert.equal(securityOptions.helperPath, configured ? values.helperPath : undefined);
      assert.equal(securityOptions.scriptPath, configured ? values.scannerPath : undefined);
      assert.deepEqual(sourceOptions, configured ? { database: values.taskDatabase, snapshotPath: values.taskSnapshotPath } : undefined);
      assert.equal(served[4], security);
      assert.equal(served[5], configured ? source : undefined);
      result!.close(); await security.close();
    }
  } finally { f.clean(); }
});

test('listen failure closes only owned handles and never opens native UI', async () => {
  const f = fixture();
  try {
    const calls: string[] = []; const r = runtime(f, calls, false);
    await assert.rejects(runHousekeeper([], { ...r.dependencies, serve: () => { queueMicrotask(() => r.server.emit('error', Object.assign(Error('EADDRINUSE'), { code: 'EADDRINUSE' }))); return r.server; } }), /4198.*已被占用/);
    assert.deepEqual(calls, ['prepare', 'close-server', 'close-db']);
  } finally { f.clean(); }
});

test('open happens only after listening; owned shutdown is idempotent', async () => {
  const f = fixture();
  try {
    const calls: string[] = [];
    const result = await runHousekeeper([], runtime(f, calls).dependencies);
    assert.deepEqual(calls, ['prepare', 'serve', 'listening', 'open']);
    result!.close(); result!.close();
    assert.deepEqual(calls.slice(4), ['close-server', 'close-db']);
  } finally { f.clean(); }
});

const healthyResponse = JSON.stringify({ success: { _0: { health: { _0: { version: 1, status: 'ok' } } } } });
function nativeStubs(root: string, options: { mode?: number; canonical?: boolean; symlink?: boolean; missing?: boolean; stdout?: string } = {}) {
  const calls: { kind: string; file: string; args: string[]; options: any }[] = [];
  const namespace = join(root, '.local-sensitive/askkey-local-scan');
  return { calls, namespace, dependencies: {
    home: () => root,
    stat: (path: string) => path === namespace && options.missing ? undefined : { mode: options.mode ?? 0o700, isDirectory: () => true, isSymbolicLink: () => path === namespace && !!options.symlink },
    realpath: (path: string) => options.canonical === false ? join(root, 'different') : path,
    execute: async (file: string, args: string[], execOptions: any) => { calls.push({ kind: 'execute', file, args, options: execOptions }); return { stdout: options.stdout ?? healthyResponse }; },
    launch: (file: string, args: string[], spawnOptions: any) => { calls.push({ kind: 'launch', file, args, options: spawnOptions }); },
  } };
}

test('omitted and incomplete native injection fail closed before I/O', async () => {
  const f = fixture();
  try {
    const plan = createPlan([], f.env);
    await assert.rejects(openManualInterfaces(plan), /完整依赖/);
    let calls = 0;
    await assert.rejects(openManualInterfaces(plan, () => {}, { execute: async () => { calls++; return { stdout: healthyResponse }; } } as any), /完整依赖/);
    await assert.rejects(runHousekeeper([], { env: f.env, log: () => {}, prepare: () => { calls++; } }), /显式提供 openNative/);
    assert.equal(calls, 0);
  } finally { f.clean(); }
});

test('unconfigured native components only open Crew and explain unavailability', async () => {
  const f = fixture();
  try {
    for (const config of [{}, { launcherPath: join(f.root, 'launcher') }]) {
      f.writeConfig(config);
      const stub = nativeStubs(f.root); const messages: string[] = [];
      await openManualInterfaces(createPlan([], f.env), value => messages.push(value), stub.dependencies);
      assert.deepEqual(stub.calls.map(c => [c.file, c.args]), [['/usr/bin/open', ['http://127.0.0.1:4198/#/today']]]);
      assert.match(messages.join('\n'), /未配置.*仅打开 Crew/);
    }
  } finally { f.clean(); }
});

test('healthy native service is reused and browser URL is rebuilt from validated port', async () => {
  const f = fixture();
  try {
    f.writeConfig({ helperPath: join(f.root, 'helper'), launcherPath: join(f.root, 'launcher') });
    const stub = nativeStubs(f.root);
    const plan = { ...createPlan(['--port', '4201'], f.env), url: 'https://untrusted.example' };
    await openManualInterfaces(plan, () => {}, stub.dependencies);
    assert.deepEqual(stub.calls.map(c => [c.file, c.args]), [[join(f.root, 'helper'), ['health']], ['/usr/bin/open', ['http://127.0.0.1:4201/#/today']]]);
    assert.equal(stub.calls[0].options.env.ASKKEY_DEBUG_RUN_DIRECTORY, stub.namespace);
    assert.equal(stub.calls[0].options.env.HOME, f.root);
    assert.equal(stub.calls[0].options.env.NODE_OPTIONS, undefined);
    assert.equal(stub.calls[1].options.env.ASKKEY_DEBUG_RUN_DIRECTORY, undefined);
    await assert.rejects(openManualInterfaces({ ...plan, port: 0 }, () => {}, stub.dependencies), /端口/);
  } finally { f.clean(); }
});

test('unhealthy helper requests only configured launcher; missing launcher opens only Crew', async () => {
  const f = fixture();
  try {
    for (const stdout of ['not-json', JSON.stringify({ failure: { _0: 'unavailable' } }), JSON.stringify({ success: { _0: { health: { _0: { status: 'bad' } } } } })]) {
      for (const launcher of [false, true]) {
        f.writeConfig({ helperPath: join(f.root, 'helper'), ...(launcher ? { launcherPath: join(f.root, 'launcher') } : {}) });
        const stub = nativeStubs(f.root, { stdout });
        await openManualInterfaces(createPlan([], f.env), () => {}, stub.dependencies);
        assert.deepEqual(stub.calls.map(c => [c.kind, c.file]), [['execute', join(f.root, 'helper')], ...(launcher ? [['launch', join(f.root, 'launcher')]] : []), ['execute', '/usr/bin/open']]);
        if (launcher) assert.deepEqual(stub.calls[1].args, []);
      }
    }
  } finally { f.clean(); }
});

test('unsafe native namespace never checks health or launches; missing namespace can request configured launcher', async () => {
  const f = fixture();
  try {
    f.writeConfig({ helperPath: join(f.root, 'helper'), launcherPath: join(f.root, 'launcher') });
    for (const options of [{ mode: 0o755 }, { canonical: false }, { symlink: true }]) {
      const stub = nativeStubs(f.root, options);
      await openManualInterfaces(createPlan([], f.env), () => {}, stub.dependencies);
      assert.deepEqual(stub.calls.map(c => c.file), ['/usr/bin/open']);
    }
    const stub = nativeStubs(f.root, { missing: true });
    await openManualInterfaces(createPlan([], f.env), () => {}, stub.dependencies);
    assert.deepEqual(stub.calls.map(c => c.file), [join(f.root, 'launcher'), '/usr/bin/open']);
  } finally { f.clean(); }
});

test('shutdown during deferred health prevents late native launch and browser open', async () => {
  const f = fixture();
  try {
    f.writeConfig({ helperPath: join(f.root, 'helper'), launcherPath: join(f.root, 'launcher') });
    const stop = new AbortController(); const stub = nativeStubs(f.root);
    let resolveHealth!: (value: { stdout: string }) => void; let healthStarted!: () => void;
    const started = new Promise<void>(resolve => { healthStarted = resolve; });
    const lateHealth = new Promise<{ stdout: string }>(resolve => { resolveHealth = resolve; });
    const execute = stub.dependencies.execute;
    stub.dependencies.execute = async (file, args, options) => { if (args[0] === 'health') { healthStarted(); return lateHealth; } return execute(file, args, options); };
    const calls: string[] = [];
    const pending = runHousekeeper([], { ...runtime(f, calls).dependencies, signal: stop.signal,
      openNative: (plan, signal) => openManualInterfaces(plan, () => {}, stub.dependencies, signal),
    });
    const rejected = assert.rejects(pending, /已关闭/);
    await started; stop.abort(); resolveHealth({ stdout: 'not-json' }); await rejected;
    assert.deepEqual(calls.slice(-2), ['close-server', 'close-db']);
    assert.deepEqual(stub.calls, []);
  } finally { f.clean(); }
});

test('shutdown while listening is pending settles startup and closes owned handles once', async () => {
  const f = fixture();
  try {
    const stop = new AbortController(); const calls: string[] = []; const r = runtime(f, calls, false);
    const pending = runHousekeeper([], { ...r.dependencies, signal: stop.signal });
    const rejected = assert.rejects(pending, /已关闭/);
    // Let asynchronous module loading finish without depending on an arbitrary timeout.
    while (!calls.includes('serve')) await new Promise(resolve => setImmediate(resolve));
    stop.abort(); stop.abort(); await rejected; r.server.emit('listening');
    assert.deepEqual(calls, ['prepare', 'serve', 'close-server', 'close-db']);
  } finally { f.clean(); }
});

test('real occupied port preserves the existing server and closes the new database', async () => {
  const f = fixture(); const existing = createServer((_request, response) => response.end('existing'));
  existing.listen(0, '127.0.0.1'); await once(existing, 'listening');
  const port = (existing.address() as { port: number }).port;
  let database: ReturnType<typeof openDb> | undefined; let opened = false;
  try {
    await assert.rejects(runHousekeeper(['--port', String(port)], { env: f.env, log: () => {},
      openDb: path => (database = openDb(path)), serve,
      openNative: async () => { opened = true; },
    }), /已被占用/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(opened, false);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'existing');
    assert.throws(() => database!.raw.prepare('SELECT 1'), /not open|closed/);
  } finally { await new Promise<void>(resolve => existing.close(() => resolve())); f.clean(); }
});

test('temporary Crew HTTP serves today and unavailable security without reading external data', async () => {
  const f = fixture(); let server: ReturnType<typeof serve> | undefined;
  let result: Awaited<ReturnType<typeof runHousekeeper>>;
  try {
    const seed = openDb(f.env.CORPUS_DB);
    const projectId = seed.createProject({ name: 'Example project', goal: null, dirs: [] });
    seed.raw.close();
    result = await runHousekeeper([], { env: f.env, log: () => {}, openDb,
      serve: (database, _port, teams, terminals, security, source) => (server = serve(database, 0, teams, terminals, security, source)),
      openNative: async () => {},
    });
    const base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    const today = await fetch(`${base}/api/today`);
    assert.equal(today.status, 200);
    const data = await today.json() as ReturnType<typeof buildToday>;
    assert.equal(data.source.configured, false);
    assert.equal(data.source.kind, 'local_corpus');
    assert.deepEqual(data.projects, [{ id: projectId, name: 'Example project' }]);
    const catalog = await (await fetch(`${base}/api/security/credentials`)).json() as CredentialCatalog;
    assert.equal(catalog.status, 'unavailable'); assert.equal(catalog.nativeAvailable, false); assert.equal(catalog.scanAvailable, false);
    assert.deepEqual(catalog.credentials, []);
  } finally {
    if (result && server) { const closed = once(server, 'close'); result.close(); await closed; }
    f.clean();
  }
});

test('configured temporary source refreshes read-only through the entry wiring', async () => {
  const f = fixture(); let sourceDb: DatabaseSync | undefined;
  try {
    const database = join(f.root, 'tasks.db'); const snapshotPath = join(f.root, 'snapshots', 'tasks.json');
    sourceDb = new DatabaseSync(database);
    sourceDb.exec("CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, status TEXT); CREATE TABLE tasks (id INTEGER PRIMARY KEY, project_id INTEGER, title TEXT, status TEXT, priority TEXT, due_date TEXT, updated_at TEXT, created_at TEXT); INSERT INTO projects VALUES (1,'Example','active'); INSERT INTO tasks VALUES (7,1,'Synthetic task','todo','high',NULL,'2026-01-01','2026-01-01');");
    sourceDb.close(); sourceDb = undefined;
    const before = readFileSync(database);
    f.writeConfig({ taskDatabase: database, taskSnapshotPath: snapshotPath });
    const calls: string[] = []; const r = runtime(f, calls); let wiredSource: ReturnType<typeof createTaskSource> | undefined;
    const result = await runHousekeeper([], { ...r.dependencies, serve: (...args) => { wiredSource = args[5]; return r.serve(); } });
    assert.equal(wiredSource!.refresh().tasks[0].sourceId, 7);
    assert.deepEqual(readFileSync(database), before);
    assert.equal(statSync(snapshotPath).mode & 0o777, 0o600);
    result!.close();
  } finally { sourceDb?.close(); f.clean(); }
});
