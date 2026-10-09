import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Exercise the shipped browser module without changing its build.
import { mountTeamDock } from '../web/team-dock.js';

class Element {
  [key: string]: any;
  children: Element[] = []; attrs: Record<string, string> = {}; handlers: Record<string, Function[]> = {}; dataset = {}; style = {}; className = ''; value = ''; hidden = false; disabled = false; parent: Element | undefined; text = '';
  tag: string; constructor(tag: string) { this.tag = tag; }
  set textContent(text: string) { this.text = text; this.children = []; }
  get textContent(): string { return this.text + this.children.map(c => c.textContent).join(''); }
  append(...nodes: Element[]) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  replaceChildren(...nodes: Element[]) { this.children = []; this.text = ''; this.append(...nodes); }
  insertBefore(n: Element, before: Element | null) { n.remove(); n.parent = this; const i = before ? this.children.indexOf(before) : this.children.length; this.children.splice(i, 0, n); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  addEventListener(key: string, fn: Function) { (this.handlers[key] ??= []).push(fn); }
  matches(selector: string) { return selector.startsWith('.') ? this.className.split(' ').includes(selector.slice(1)) : this.tag === selector; }
  querySelector(selector: string): Element | undefined { for (const c of this.children) { if (c.matches(selector)) return c; const n = c.querySelector(selector); if (n) return n; } }
  async fire(key: string, event: any = {}) { for (const fn of this.handlers[key] || []) await fn({ preventDefault() {}, target: this, ...event }); }
  focus() {}
}

test('shipped footer expands a member, preserves draft during SSE, answers questions and disables actions offline', async () => {
  const g = globalThis as any, originals = Object.fromEntries(['document', 'window', 'EventSource'].map(k => [k, g[k]]));
  const streams: any[] = [], windowHandlers: Record<string, Function> = {}, calls: any[] = [];
  g.document = { createElement(tag: string) { return new Element(tag); } };
  g.window = { addEventListener(k: string, f: Function) { windowHandlers[k] = f; }, removeEventListener(k: string) { delete windowHandlers[k]; } };
  g.EventSource = class { closed = false; handlers: Record<string, Function> = {}; constructor() { streams.push(this); } addEventListener(k: string, f: Function) { this.handlers[k] = f; } close() { this.closed = true; } onerror() {} };
  const state: any = { projectId: 'p', status: 'running', run: { id: 'run', mode: 'codex-team' }, members: [], messages: [], agents: [{ threadId: 'child', name: '<img onerror=boom>', role: 'worker', state: 'running', turnId: 'turn', events: [{ id: 'e', text: '<script>boom</script>' }] }], nativeTasks: [{ id: 'task', threadId: 'child', title: 'Inspect', state: 'running', files: [], acceptance: ['Explain'], reviews: [] }], inputs: [{ id: 'input', requestId: 7, threadId: 'child', turnId: 'turn', state: 'pending', questions: [{ id: 'format', header: '格式', question: '用什么格式？' }] }] };
  const root = new Element('section'); let cleanup: Function | undefined;
  const emit = () => streams[0].handlers.snapshot({ data: JSON.stringify(state) });
  try {
    cleanup = mountTeamDock(root, { projectId: 'p', api: async (url: string, options: any) => { if (options) { calls.push([url, options.body]); if (url.endsWith('/answer')) state.inputs[0].state = 'resolved'; } return structuredClone(state); } });
    emit(); await root.querySelector('.crew-dock-member')!.fire('click');
    assert.equal(root.querySelector('.crew-dock-panel')!.hidden, false); assert.match(root.textContent, /<img onerror=boom>/); assert.equal(root.querySelector('img'), undefined);
    const textarea = root.querySelector('textarea')!; textarea.value = 'Keep this draft'; await textarea.fire('input');
    state.agents[0].step = 'New activity'; emit(); assert.equal(root.querySelector('textarea'), textarea); assert.equal(textarea.value, 'Keep this draft');
    const requestForm = root.querySelector('.crew-dock-inputs')!.children[0]!, answer = requestForm.querySelector('input')!;
    answer.value = 'JSON'; await answer.fire('input'); await requestForm.fire('submit');
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ['/api/team/answer', { projectId: 'p', runId: 'run', inputId: 'input', answers: { format: 'JSON' } }]);
    assert.equal(root.querySelector('.crew-dock-inputs')!.children.length, 0);
    await root.querySelector('.crew-dock-form')!.fire('submit'); assert.equal(calls[1][1].threadId, 'child'); assert.equal(calls[1][1].text, 'Keep this draft');
    textarea.value = 'Offline draft'; await textarea.fire('input'); windowHandlers.offline!();
    assert.equal(textarea.disabled, true); assert.match(root.textContent, /最后观测/);
    cleanup!(); assert.equal(streams[0].closed, true); assert.equal(root.children.length, 0);
  } finally { cleanup?.(); for (const [k, value] of Object.entries(originals)) { if (value === undefined) delete g[k]; else g[k] = value; } }
});
