import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

test('intake help is reachable through the formal CLI without creating Corpus storage', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-intake-cli-'));
  try {
    const result = spawnSync(process.execPath, ['--no-warnings', 'src/cli.ts', 'intake', '--help'], {
      encoding: 'utf8', env: { ...process.env, CORPUS_HOME: join(root, 'corpus'), CORPUS_DB: join(root, 'corpus.db') },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /材料自动处理/);
    assert.match(result.stdout, /--focus/);
    assert.equal(existsSync(join(root, 'corpus.db')), false);
    assert.equal(existsSync(join(root, 'corpus')), false);
  } finally { rmSync(root, { recursive: true }); }
});

test('intake dry-run reads an explicit project source without writing cards or task state', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-intake-plan-'));
  try {
    const source = join(root, 'source.txt'); writeFileSync(source, '合成分享\n业务规则需要当前适用范围。\n');
    const database = join(root, 'tasks.db');
    const db = new DatabaseSync(database);
    db.exec('CREATE TABLE projects (id INTEGER,name TEXT,status TEXT,description TEXT,local_path TEXT); CREATE TABLE tasks(id INTEGER,project_id INTEGER,title TEXT,status TEXT);');
    db.exec("INSERT INTO projects VALUES(1,'合成项目','active','规则工具','');");
    db.close();
    const output = join(root, 'private');
    const result = spawnSync(process.execPath, ['--no-warnings', 'src/cli.ts', 'intake', source,
      '--workspace', root, '--database', database, '--output', output, '--dry-run'], {
      encoding: 'utf8', env: { ...process.env, CORPUS_HOME: join(root, 'corpus') },
    });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.action, 'plan-only');
    assert.equal(plan.project_count, 1);
    assert.equal(plan.max_model_calls, 2);
    assert.equal(existsSync(output), false);
    assert.equal(existsSync(join(root, 'corpus')), false);
  } finally { rmSync(root, { recursive: true }); }
});

test('catalog dry-run overrides environment database and rejects explicit database together', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-intake-catalog-'));
  try {
    const source = join(root, 'meeting.md'); writeFileSync(source, '合成访谈\n发布说明需要保留原始改动出处。\n');
    const catalog = join(root, 'projects.json');
    writeFileSync(catalog, JSON.stringify({version: 1, projects: [{id: 1, name: '发布说明', path: 'project'}]}));
    const output = join(root, 'private');
    const args = ['--no-warnings', 'src/cli.ts', 'intake', source, '--workspace', root, '--catalog', catalog, '--output', output, '--dry-run'];
    const env = {...process.env, CREW_TASK_DB: join(root, 'missing.db'), CREW_CLAUDE_BIN: 'missing-model', CORPUS_HOME: join(root, 'corpus'), CORPUS_DB: join(root, 'corpus.db')};
    const result = spawnSync(process.execPath, args, {encoding: 'utf8', env});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).project_count, 1);
    for (const name of ['private', 'corpus', 'corpus.db', 'missing.db']) assert.equal(existsSync(join(root, name)), false);
    const conflict = spawnSync(process.execPath, [...args, '--database', join(root, 'missing.db')], {encoding: 'utf8', env});
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.stderr, /--catalog|--database/);
  } finally { rmSync(root, {recursive: true}); }
});
