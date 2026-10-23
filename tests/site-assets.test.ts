import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('static package contains every top-level local app import and index stylesheet', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = readFileSync(join(root, 'web/app.js'), 'utf8');
  const html = readFileSync(join(root, 'web/index.html'), 'utf8');
  const modules = [...app.matchAll(/^import\s+(?:[^;]*?\s+from\s+)?['"](\.\.?\/[^'"]+)['"]/gm)].map(m => m[1]);
  const styles = [...html.matchAll(/<link\b[^>]*>/gi)].filter(m => /rel=['"]stylesheet['"]/.test(m[0])).map(m => /href=['"]([^'"]+)['"]/.exec(m[0])![1]).filter(s => !/^(?:[a-z]+:)?\/\//i.test(s));
  assert.ok(modules.length > 0); assert.ok(styles.length > 0);
  const dir = mkdtempSync(join(tmpdir(), 'crew-site-assets-'));
  const out = join(dir, 'site');
  try {
    const built = spawnSync(process.execPath, ['--no-warnings', 'scripts/build-site.ts', out], { cwd: root, encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr);
    for (const asset of [...modules, ...styles]) assert.ok(existsSync(resolve(out, asset)), `missing packaged asset: ${asset}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
