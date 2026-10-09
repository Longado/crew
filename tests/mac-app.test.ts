// macOS 桌面应用：生成出来的包结构完整，启动器能在后台拉起本地服务。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const APP = join(ROOT, 'dist', 'Crew.app');

test('生成 Crew.app，双击入口能拉起服务', { skip: platform() !== 'darwin' ? '只在 macOS 上生成' : false }, async () => {
  const legacyApp = join(ROOT, 'dist', 'Working Corpus.app');
  const legacyExisted = existsSync(legacyApp);
  const r = spawnSync('bash', [join(ROOT, 'scripts/make-mac-app.sh')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(legacyApp), legacyExisted, '保留已有 Working Corpus.app');
  const plist = readFileSync(join(APP, 'Contents/Info.plist'), 'utf8');
  assert.match(plist, /<key>CFBundleDisplayName<\/key><string>Crew<\/string>/);
  const exe = join(APP, 'Contents/MacOS/Crew');
  assert.ok(statSync(exe).mode & 0o111);
  assert.equal(spawnSync('plutil', ['-lint', join(APP, 'Contents/Info.plist')]).status, 0);
  assert.ok(existsSync(join(APP, 'Contents/Resources/icon.icns')), '应该带像素图标');
  const home = mkdtempSync(join(tmpdir(), 'corpus-macapp-'));
  const port = String(4800 + Math.floor(Math.random() * 400));
  const env = { ...process.env, CORPUS_HOME: home };
  const launch = spawnSync(exe, ['--no-open', '--port', port], { env, encoding: 'utf8' });
  try {
    assert.equal(launch.status, 0, launch.stderr);
    assert.match(launch.stdout, /\/#\//);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status, 200);
  } finally { spawnSync(join(ROOT, 'bin/crew'), ['stop'], { env }); }
});
