import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

class Element {
  innerHTML = ''; textContent = ''; value = ''; hidden = false; disabled = false; open = false;
  dataset: Record<string, string> = {}; listeners: Record<string, Function> = {};
  classList = { add() {}, remove() {}, toggle() {} };
  setAttribute() {} addEventListener(name: string, fn: Function) { this.listeners[name] = fn; }
  showModal() { this.open = true; } close() { this.open = false; }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
async function fixture() {
  const elements = new Map<string, Element>(), handlers: Record<string, Function> = {};
  const requests: { path: string; body: any }[] = [], prompts: string[] = [];
  let tick: Function = () => {}, answer = false;
  const el = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const job = { id: 'synthetic-job', task_id: 1, title: 'Synthetic task', state: 'recovery_required',
    reconciliation_outcome: 'unresolved', can_stop: false, created_at: '2026-10-01T00:00:00+00:00',
    access: 'workspace-write', crew_link: '/fixture/team', label: '原运行待重新核对',
    snapshot: { agents: [{ name: 'Synthetic member', state: 'completed', output: 'Preserved result' }] } };
  const board = { jobs: [job], tasks: [{ task_id: 1, sources: [1], line: 'Synthetic task', title: 'Synthetic task',
    status: 'blocked', eligible: true, cwd: '/fixture', next: 'Read', acceptance: 'Check', owner: 'Codex' }] };
  vm.runInNewContext(readFileSync(new URL('../web/task-board.js', import.meta.url), 'utf8'), {
    document: { getElementById: el, querySelector: el, querySelectorAll: () => [],
      addEventListener: (name: string, fn: Function) => { handlers[name] = fn; } },
    setInterval(fn: Function) { tick = fn; },
    confirm(message: string) { prompts.push(message); return answer; },
    fetch: async (path: string, options?: any) => {
      if (!options) return { ok: true, json: async () => board };
      const body = JSON.parse(options.body); requests.push({ path, body });
      if (body.confirm_ended === true) {
        Object.assign(job, { state: 'blocked', reconciliation_outcome: 'finished', user_confirmed_ended: true,
          label: '用户确认结束，未经 Crew 证实；成果和回执已保留。' });
        return { ok: true, json: async () => ({ outcome: 'finished', job }) };
      }
      return { ok: true, json: async () => ({ outcome: 'unresolved', job }) };
    }, Date, console,
  });
  await flush();
  const click = (attribute: string) => {
    const button = new Element(); button.dataset[attribute] = job.id;
    const selector = attribute === 'confirmEnded' ? '[data-confirm-ended]' : '[data-reconcile]';
    handlers.click({ target: { closest: (q: string) => q === selector ? button : null } });
    return button;
  };
  return { el, job, requests, prompts, click, tick: () => tick(), answer: (value: boolean) => { answer = value; } };
}

test('only unresolved recovery cards offer the explicit ended confirmation', async () => {
  const f = await fixture();
  assert.match(f.el('jobs').innerHTML, /data-confirm-ended="synthetic-job"[^>]*>确认原运行已结束/);
  for (const [state, outcome, canStop] of [
    ['recovery_required', '', false], ['recovery_required', 'live', true],
    ['running', 'unresolved', true], ['blocked', 'finished', false], ['completed', 'finished', false],
  ] as const) {
    Object.assign(f.job, { state, reconciliation_outcome: outcome, can_stop: canStop });
    await f.tick();
    assert.doesNotMatch(f.el('jobs').innerHTML, /data-confirm-ended=/);
    f.answer(true); f.click('confirmEnded'); await flush();
    assert.equal(f.requests.length, 0, 'stale confirmation controls cannot submit');
  }
});

test('cancelling ended confirmation sends nothing and preserves pending state and result', async () => {
  const f = await fixture();
  f.click('confirmEnded'); await flush();
  assert.equal(f.prompts.length, 1);
  assert.match(f.prompts[0], /未经 Crew 证实/);
  assert.match(f.prompts[0], /blocked|需处理/);
  assert.match(f.prompts[0], /不.*验收.*不.*合并/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.job.state, 'recovery_required');
  assert.match(f.el('jobs').innerHTML, /Preserved result/);
});

test('accepting confirmation sends the exact job once and exposes the unverified blocked result', async () => {
  const f = await fixture(); f.answer(true);
  f.click('confirmEnded'); f.click('confirmEnded'); await flush();
  assert.deepEqual(f.requests, [{ path: '/api/reconcile', body: { job_id: 'synthetic-job', confirm_ended: true } }]);
  assert.equal(f.job.state, 'blocked');
  assert.match(f.el('jobs').innerHTML, /用户确认结束，未经 Crew 证实/);
  assert.match(f.el('notice').textContent, /未经 Crew 证实/);
  assert.match(f.el('jobs').innerHTML, /Preserved result/);
  assert.doesNotMatch(f.el('jobs').innerHTML, /data-confirm-ended=/);
  assert.equal(f.el('run-state').textContent, '待命');
  assert.match(f.el('ready').innerHTML, /data-draggable="true"/);
});

test('ordinary reconciliation does not implicitly confirm the run ended', async () => {
  const f = await fixture(); f.answer(true);
  f.click('reconcile'); await flush();
  assert.deepEqual(f.requests, [{ path: '/api/reconcile', body: { job_id: 'synthetic-job' } }]);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.job.state, 'recovery_required');
});
