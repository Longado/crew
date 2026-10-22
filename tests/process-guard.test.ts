import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('./helpers/block-all-processes.mjs', import.meta.url));

for (const [label, source] of [
  ['default import', "import cp from 'node:child_process'; cp.spawnSync('true');"],
  ['named import', "import { execFileSync } from 'node:child_process'; execFileSync('true');"],
]) {
  test(`process guard blocks child processes via ${label}`, () => {
    const result = spawnSync(process.execPath, ['--import', guard, '--input-type=module', '-e', source], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /PROCESS CREATION BLOCKED BY SYNTHETIC TEST GUARD/);
  });
}
