import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecurityService } from '../src/security/adapter.ts';

test('CREW_ASKKEY_HELPER explicitly enables the fake native helper and an option can disable it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crew-config-helper-'));
  const helper = join(dir, 'helper');
  await writeFile(helper, `#!${process.execPath}
import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.id !== 2) return;
  if (request.params.name !== 'list_credentials') throw Error('unexpected tool');
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:2,result:{content:[{type:'text',text:JSON.stringify({credentials:[]})}]}})+'\\n');
});
`, { mode: 0o700 });
  const previous = process.env.CREW_ASKKEY_HELPER;
  process.env.CREW_ASKKEY_HELPER = helper;
  const enabled = createSecurityService({ localCatalogPath: false, debugRunDirectory: dir });
  const disabled = createSecurityService({ localCatalogPath: false, nativeEnabled: false });
  try {
    assert.equal((await enabled.listCredentials()).nativeAvailable, true);
    assert.equal((await disabled.listCredentials()).nativeAvailable, false);
  } finally {
    await enabled.close(); await disabled.close();
    if (previous === undefined) delete process.env.CREW_ASKKEY_HELPER; else process.env.CREW_ASKKEY_HELPER = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
