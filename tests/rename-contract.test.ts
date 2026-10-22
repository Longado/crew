// 仓库改名只更新公开入口；已安装插件和本地数据继续兼容。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const json = (path: string) => JSON.parse(read(path));

test('公开包名与锁文件根包名统一为 crew', () => {
  assert.equal(json('package.json').name, 'crew');
  const lock = json('package-lock.json');
  assert.equal(lock.name, 'crew');
  assert.equal(lock.packages[''].name, 'crew');
});

test('安装说明与演示入口使用新仓库、新站点和克隆目录', () => {
  for (const path of ['README.md', 'README.en.md']) {
    const text = read(path);
    assert.ok(text.includes('git clone https://github.com/Longado/crew && cd crew'), path);
    assert.ok(text.includes('/plugin marketplace add Longado/crew'), path);
    assert.ok(text.includes('https://longado.github.io/crew/'), path);
    assert.doesNotMatch(text, /仓库名还叫|repo is still called/);
  }
  for (const path of ['README.md', 'README.en.md', 'docs/DEMO.md', 'docs/PLUGIN.md', 'docs/diagram/architecture.html', 'demo/slides.html', 'examples/README.md', 'web/app.js']) {
    assert.doesNotMatch(read(path), /(?:Longado\/|longado\.github\.io\/)working-corpus/, path);
  }
});

test('插件地址更新但安装标识、旧命令和 macOS 身份保持兼容', () => {
  const plugin = json('.claude-plugin/plugin.json'), market = json('.claude-plugin/marketplace.json');
  assert.equal(plugin.homepage, 'https://github.com/Longado/crew');
  assert.equal(plugin.repository, 'https://github.com/Longado/crew');
  assert.equal(plugin.name, 'working-corpus');
  assert.equal(market.name, 'working-corpus');
  assert.equal(market.plugins[0].name, 'working-corpus');
  assert.equal(market.plugins[0].source, './');
  assert.equal(json('package.json').bin.corpus, 'bin/corpus');
  assert.ok(read('docs/PLUGIN.md').includes('/plugin install working-corpus@working-corpus'));
  assert.ok(read('scripts/make-mac-app.sh').includes('<key>CFBundleIdentifier</key><string>io.github.longado.working-corpus</string>'));
});

test('公开文档、界面与测试样例不包含个人用户目录', () => {
  // ponytail: 只读源码与文档，跳过媒体二进制和生成目录；不启动应用或模型。
  const check = (path: string) => {
    for (const entry of readdirSync(join(ROOT, path), { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) check(child);
      else if (entry.isFile() && /\.(md|json|txt|html|[cm]?js|ts|tape|sh)$/.test(entry.name)) {
        assert.doesNotMatch(read(child), /[/]Users[/]/, child);
      }
    }
  };
  for (const path of ['docs', 'demo', 'examples', 'scripts/probes', 'tests']) check(path);
  assert.doesNotMatch(read('web/app.js'), /[/]Users[/]/);
});
