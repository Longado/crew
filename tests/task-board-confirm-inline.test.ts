import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

class Element {
  innerHTML = ''; textContent = ''; value = ''; hidden = false; disabled = false; open = false;
  dataset: Record<string, string> = {};
  classList = { add() {}, remove() {}, toggle() {} };
  setAttribute() {} addEventListener() {} showModal() {} close() {}
}
const flush = () => new Promise(resolve => setImmediate(resolve));
async function fixture() {
  const elements = new Map<string, Element>(), handlers: Record<string, Function> = {};
  const requests: any[] = [], timers = new Map<number, { at: number; fn: Function }>();
  let clock = 10000, timerId = 0, refresh: Function = () => {};
  const el = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const job = { id: 'synthetic-job', title: 'Synthetic task', state: 'recovery_required',
    reconciliation_outcome: 'unresolved', can_stop: false, created_at: '2026-10-01T00:00:00Z',
    access: 'workspace-write', crew_link: '/fixture/team', snapshot: {} };
  vm.runInNewContext(readFileSync(new URL('../web/task-board.js', import.meta.url), 'utf8'), {
    document: { getElementById: el, querySelector: el, querySelectorAll: () => [],
      addEventListener: (name: string, fn: Function) => { handlers[name] = fn; } },
    get confirm() { throw Error('Native confirmation is unavailable'); },
    setInterval(fn: Function) { refresh = fn; },
    setTimeout(fn: Function, ms: number) { timers.set(++timerId, { at: clock + ms, fn }); return timerId; },
    clearTimeout(id: number) { timers.delete(id); },
    Date: class extends Date { static now() { return clock; } },
    fetch: async (path: string, options?: any) => {
      if (!options) return { ok: true, json: async () => ({ tasks: [], jobs: [job] }) };
      requests.push({ path, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ outcome: 'unresolved', job }) };
    }, console,
  });
  await flush();
  const click = (attribute = 'confirmEnded') => {
    const button = new Element(); button.dataset[attribute] = job.id;
    const selector = attribute === 'confirmEnded' ? '[data-confirm-ended]' : '[data-reconcile]';
    handlers.click({ target: { closest: (q: string) => q === selector && attribute !== 'elsewhere' ? button : null } });
  };
  return { el, job, requests, click, refresh: () => refresh(),
    advance(ms: number, fire = true) {
      clock += ms;
      if (fire) for (const [id, timer] of timers) if (timer.at <= clock) { timers.delete(id); timer.fn(); }
    } };
}

test('inline confirmation needs two clicks without accessing native confirm and suppresses duplicate submits', async () => {
  const f = await fixture();
  f.click();
  assert.equal(f.requests.length, 0);
  assert.match(f.el('jobs').innerHTML, /再点一次确认：记为用户确认结束，未经 Crew 证实/);
  assert.match(f.el('jobs').innerHTML, /任务转为需处理（blocked）.*保留成果和回执.*不自动验收.*不合并隔离成果/);
  await f.refresh();
  f.click(); f.click();
  assert.deepEqual(f.requests, [{ path: '/api/reconcile', body: { job_id: 'synthetic-job', confirm_ended: true } }]);
  await flush();
});

test('expired confirmation resets and requires two fresh clicks even if the timer was suspended', async () => {
  for (const fireTimer of [true, false]) {
    const f = await fixture(); f.click();
    f.advance(6000, fireTimer);
    if (fireTimer) assert.doesNotMatch(f.el('jobs').innerHTML, /再点一次确认/);
    f.click(); assert.equal(f.requests.length, 0);
    f.click(); assert.equal(f.requests.length, 1);
    await flush();
  }
});

test('clicking elsewhere or reconciling cancels the armed confirmation', async () => {
  const f = await fixture();
  f.click(); f.click('elsewhere');
  assert.doesNotMatch(f.el('jobs').innerHTML, /再点一次确认/);
  f.click(); assert.equal(f.requests.length, 0);
  f.click('reconcile'); await flush();
  assert.deepEqual(f.requests[0].body, { job_id: 'synthetic-job' });
  f.click(); assert.equal(f.requests.length, 1);
});

test('a refreshed live receipt invalidates the armed confirmation', async () => {
  const f = await fixture(); f.click();
  Object.assign(f.job, { reconciliation_outcome: 'live', can_stop: true });
  await f.refresh(); f.click();
  assert.equal(f.requests.length, 0);
  Object.assign(f.job, { reconciliation_outcome: 'unresolved', can_stop: false });
  await f.refresh(); f.click();
  assert.equal(f.requests.length, 0);
});
