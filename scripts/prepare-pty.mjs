// node-pty 1.1.0's macOS prebuilt spawn-helper is published without executable bits.
// Repair only this dependency's helper, so npm ci produces a usable local terminal.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync, statSync, chmodSync } from 'node:fs';
if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('node-pty/package.json'));
  for (const relative of [`prebuilds/darwin-${process.arch}/spawn-helper`, 'build/Release/spawn-helper']) {
    const file = join(root, relative);
    if (existsSync(file)) chmodSync(file, statSync(file).mode | 0o111);
  }
}
