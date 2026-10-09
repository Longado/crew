import test from 'node:test';
import assert from 'node:assert/strict';
import { createLivenessGuard } from '../src/bridge/liveness.ts';

test('a twenty-second blocked server does not terminate Claude and recovery resets the grace period', () => {
  const guard = createLivenessGuard();
  assert.equal(guard.shouldStop(200, 0), false);
  assert.equal(guard.shouldStop(undefined, 3_000), false);
  assert.equal(guard.shouldStop(undefined, 23_000), false);
  assert.equal(guard.shouldStop(200, 25_000), false);
  assert.equal(guard.shouldStop(undefined, 30_000), false);
  assert.equal(guard.shouldStop(503, 89_999), false);
  assert.equal(guard.shouldStop(undefined, 90_000), true);
});

test('revoked binding stops immediately; persistent connection loss eventually stops', () => {
  assert.equal(createLivenessGuard().shouldStop(401, 0), true);
  assert.equal(createLivenessGuard().shouldStop(410, 0), true);
  const guard = createLivenessGuard();
  assert.equal(guard.shouldStop(undefined, 1_000), false);
  assert.equal(guard.shouldStop(undefined, 60_999), false);
  assert.equal(guard.shouldStop(undefined, 61_000), true);
});

test('an explicit private stop marker bypasses network grace and is isolated by run', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { stopRequested } = await import('../src/bridge/liveness.ts');
  const dir = await mkdtemp(join(tmpdir(), 'corpus-liveness-test-'));
  try {
    const marker = join(dir, 'stop-requested'); const otherRun = join(dir, 'other-run-stop');
    const guard = createLivenessGuard(); assert.equal(guard.shouldStop(undefined, 0), false);
    assert.equal(stopRequested(marker), false);
    await writeFile(marker, '', { mode: 0o600 });
    assert.equal(stopRequested(marker), true); assert.equal(stopRequested(otherRun), false);
    assert.equal(guard.shouldStop(undefined, 250), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
