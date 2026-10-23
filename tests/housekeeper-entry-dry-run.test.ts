import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Separate from the process-guarded injection tests: only plan/help subprocesses.
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'housekeeper-dry-'));
  const home = join(root, 'crew');
  mkdirSync(home);
  const config = {
    helperPath: join(root, 'helper'), launcherPath: join(root, 'launcher'),
    scannerPath: join(root, 'scan.py'), vaultDir: join(root, 'vault'),
    taskDatabase: join(root, 'tasks.db'), taskSnapshotPath: join(root, 'snapshot.json'),
  };
  writeFileSync(join(home, 'housekeeper.json'), JSON.stringify(config));
  const env = { PATH: process.env.PATH, HOME: root, CORPUS_HOME: home, CORPUS_DB: join(root, 'custom.db'),
    CREW_ASKKEY_HELPER: join(root, 'override-helper'), PORT: '9999' };
  return { root, home, config, env, clean: () => rmSync(root, { recursive: true }) };
}

for (const entry of ['scripts/housekeeper/housekeeper.ts', 'src/cli.ts']) {
  test(`${entry} dry run uses formal data and config without creating storage`, () => {
    const f = fixture();
    try {
      const before = readdirSync(f.root, { recursive: true });
      const result = spawnSync(process.execPath, ['--no-warnings', entry, ...(entry === 'src/cli.ts' ? ['housekeeper'] : []), '--dry-run', '--port', '4201'], { encoding: 'utf8', env: f.env });
      assert.equal(result.status, 0, result.stderr);
      const plan = JSON.parse(result.stdout);
      assert.equal(plan.database, f.env.CORPUS_DB);
      assert.equal(plan.corpus, f.home);
      assert.equal(plan.port, 4201);
      assert.equal(plan.url, 'http://127.0.0.1:4201/#/today');
      assert.equal(plan.action, 'plan-only');
      assert.deepEqual(plan.config, { ...f.config, helperPath: f.env.CREW_ASKKEY_HELPER });
      assert.deepEqual(readdirSync(f.root, { recursive: true }), before);
    } finally { f.clean(); }
  });
}

test('double-click launcher keeps explicit config but strips ambient process options', () => {
  const f = fixture();
  try {
    const before = readdirSync(f.root, { recursive: true });
    const result = spawnSync('/bin/bash', [resolve('scripts/housekeeper/打开本地管家.command'), '--dry-run', '--port', '4202'], {
      cwd: f.root, encoding: 'utf8', env: { ...f.env, NODE_OPTIONS: '--invalid-option', ASKKEY_DEBUG_RUN_DIRECTORY: '/untrusted' },
    });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.database, f.env.CORPUS_DB);
    assert.equal(plan.port, 4202);
    assert.equal(plan.config.helperPath, f.env.CREW_ASKKEY_HELPER);
    assert.deepEqual(readdirSync(f.root, { recursive: true }), before);
  } finally { f.clean(); }
});

test('double-click launcher dry run works in bash 3.2 with no Crew environment', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'housekeeper-empty-env-'));
  try {
    const result = spawnSync('/bin/bash', [resolve('scripts/housekeeper/打开本地管家.command'), '--dry-run'], {
      cwd: root, encoding: 'utf8', env: { HOME: root, PATH: '/usr/bin:/bin' },
    });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.action, 'plan-only');
    assert.equal(plan.port, 4198);
    assert.equal(plan.url, 'http://127.0.0.1:4198/#/today');
    assert.equal(plan.corpus, join(root, '.working-corpus'));
    assert.equal(plan.database, join(root, '.working-corpus', 'corpus.db'));
    assert.deepEqual(plan.config, {});
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, { recursive: true }); }
});

test('CLI rejects invalid port and invalid config before creating storage', () => {
  const f = fixture();
  try {
    for (const args of [['--port', '4198x'], ['--port', '0'], ['--unknown'], ['extra']]) {
      const result = spawnSync(process.execPath, ['--no-warnings', 'src/cli.ts', 'housekeeper', '--dry-run', ...args], { encoding: 'utf8', env: f.env });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /端口|未知参数/);
    }
    writeFileSync(join(f.home, 'housekeeper.json'), '{broken');
    const result = spawnSync(process.execPath, ['--no-warnings', 'src/cli.ts', 'housekeeper', '--dry-run'], { encoding: 'utf8', env: f.env });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /housekeeper\.json.*JSON/);
    assert.deepEqual(readdirSync(f.root, { recursive: true }), ['crew', 'crew/housekeeper.json']);
  } finally { f.clean(); }
});

test('CLI help documents the entry and each optional environment setting', () => {
  const f = fixture();
  try {
    const result = spawnSync(process.execPath, ['--no-warnings', 'src/cli.ts', '--help'], { encoding: 'utf8', env: f.env });
    assert.equal(result.status, 0, result.stderr);
    for (const text of ['housekeeper [--dry-run] [--port N]', 'housekeeper.json', 'CREW_ASKKEY_HELPER', 'CREW_ASKKEY_LAUNCHER', 'CREW_SECURITY_SCANNER', 'CREW_VAULT_DIR', 'CREW_TASK_DB', 'CREW_TASK_SNAPSHOT']) assert.ok(result.stdout.includes(text), text);
  } finally { f.clean(); }
});
