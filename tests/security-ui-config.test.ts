import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

async function page(catalog: Record<string, unknown>) {
  let html = '';
  const calls: string[] = [];
  const root: any = { set innerHTML(value: string) { html = value; }, onclick: null, querySelector: () => ({ value: 'directory-0' }) };
  const context: any = { setTimeout: () => 1, clearTimeout() {} };
  const source = readFileSync(new URL('../web/security.js', import.meta.url), 'utf8').replace('export function mountSecurity', 'function mountSecurity');
  vm.runInNewContext(source + ';this.mount = mountSecurity;', context);
  const unmount = context.mount(root, { projectId: 'synthetic-project', api: async (path: string, options?: any) => {
    if (options?.method === 'POST') { calls.push(path); return { id: 'scan', state: 'running' }; }
    return path.endsWith('/credentials') ? { credentials: [], ...catalog } : { directories: [{ id: 'directory-0', label: '/synthetic/project' }] };
  } });
  await new Promise(resolve => setImmediate(resolve));
  return { html: () => html, calls, unmount, click: (action: string) => root.onclick({ target: { closest: () => ({ disabled: false, dataset: { security: action, id: 'synthetic-key' } }) } }) };
}

test('unconfigured native input is hidden, unconfigured scanner is visibly unavailable, and neither sends requests', async () => {
  const p = await page({ status: 'available', nativeAvailable: false, scanAvailable: false });
  try {
    assert.doesNotMatch(p.html(), /data-security="input"/);
    assert.match(p.html(), /data-security="scan" disabled/);
    assert.doesNotMatch(p.html(), /原生录入与检测不可用/);
    assert.match(p.html(), /项目扫描不可用/);
    for (const action of ['input', 'probe', 'scan', 'cancel']) await p.click(action);
    assert.deepEqual(p.calls, []);
  } finally { p.unmount(); }
});

test('an explicitly configured scanner works without any available credential catalog', async () => {
  const p = await page({ status: 'unavailable', nativeAvailable: false, scanAvailable: true });
  try {
    assert.doesNotMatch(p.html(), /data-security="scan" disabled/);
    await p.click('scan');
    assert.deepEqual(p.calls, ['/api/security/scans']);
    assert.match(p.html(), /正在执行/);
  } finally { p.unmount(); }
});
