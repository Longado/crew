import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Exercise the shipped browser module without changing its build.
import { mountTeam } from '../web/team.js';

// A DOM substitute for control flow; it does not measure or validate layout.
class Element {
  [key: string]: any;
  children: Element[] = []; attrs: Record<string, string> = {}; handlers: Record<string, Function[]> = {};
  dataset: Record<string, string> = {}; style = {}; className = ''; hidden = false; disabled = false; open = false;
  parent?: Element; text = ''; storedValue?: string; scrollTop = 0; scrollHeight = 0; clientHeight = 0;
  tag: string; constructor(tag: string) { this.tag = tag; }
  get value(): string { return this.storedValue ?? (this.tag === 'select' ? this.children[0]?.value : this.tag === 'option' ? this.text : '') ?? ''; }
  set value(v: string) { this.storedValue = v; }
  get textContent(): string { return this.text + this.children.map(c => c.textContent).join(''); }
  set textContent(v: string) { this.text = v; this.children = []; }
  get lastElementChild() { return this.children.at(-1); }
  classList = { toggle: (name: string, on: boolean) => { const set = new Set(this.className.split(' ').filter(Boolean)); if (on) set.add(name); else set.delete(name); this.className = [...set].join(' '); } };
  append(...nodes: Element[]) { for (const n of nodes) { if (n.tag === 'fragment') this.append(...n.children); else { n.parent = this; this.children.push(n); } } }
  replaceChildren(...nodes: Element[]) { this.children = []; this.text = ''; this.append(...nodes); }
  setAttribute(k: string, v: string) { this.attrs[k] = v; if (k === 'class') this.className = v; if (k === 'value') this.value = v; if (k === 'hidden') this.hidden = true; if (k.startsWith('data-')) this.dataset[k.slice(5)] = v; }
  addEventListener(k: string, fn: Function) { (this.handlers[k] ??= []).push(fn); }
  async fire(k: string) { for (const fn of this.handlers[k] || []) await fn({ target: this, preventDefault() {} }); }
  matches(s: string): boolean { return s[0] === '.' ? this.className.split(' ').includes(s.slice(1)) : s[0] === '[' ? s.slice(1, -1) in this.attrs : this.tag === s; }
  querySelectorAll(selector: string): Element[] {
    const all = this.children.flatMap(c => [c, ...c.querySelectorAll('*')]);
    if (selector === '*') return all;
    return all.filter(n => selector.split(',').some(s => { const parts = s.trim().split(/\s+/); if (!n.matches(parts.pop()!)) return false; let p = n.parent; while (parts.length) { const part = parts.pop()!; while (p && !p.matches(part)) p = p.parent; if (!p) return false; p = p.parent; } return true; }));
  }
  querySelector(s: string) { return this.querySelectorAll(s)[0]; }
  set innerHTML(html: string) {
    this.replaceChildren(); const stack: Element[] = [this];
    for (const m of html.matchAll(/<\/(\w+)>|<(\w+)([^>]*)>|([^<]+)/g)) {
      if (m[1]) { assert.equal(stack.pop()!.tag, m[1], 'balanced shipped markup'); }
      else if (m[2]) { const n = new Element(m[2]); for (const a of m[3]!.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) n.setAttribute(a[1]!, a[2] ?? ''); stack.at(-1)!.append(n); if (!['input', 'br', 'path'].includes(n.tag)) stack.push(n); }
      else stack.at(-1)!.text += m[4];
    }
    assert.equal(stack.length, 1);
  }
}

test('compact team keeps settings collapsed, sends the chosen run and reveals new approvals without losing drafts', async () => {
  const g = globalThis as any, originals = Object.fromEntries(['document', 'window', 'EventSource'].map(k => [k, g[k]]));
  const streams: any[] = [], handlers: Record<string, Function> = {}, calls: any[] = [];
  g.document = { createElement: (t: string) => new Element(t), createDocumentFragment: () => new Element('fragment') };
  g.window = { addEventListener: (k: string, f: Function) => { handlers[k] = f; }, removeEventListener: (k: string) => { delete handlers[k]; } };
  g.EventSource = class { handlers: Record<string, Function> = {}; closed = false; constructor() { streams.push(this); } addEventListener(k: string, f: Function) { this.handlers[k] = f; } close() { this.closed = true; } };
  const state: any = { projectId: 'p', status: 'idle', members: [], messages: [] }, root = new Element('main'); let cleanup: Function | undefined;
  const emit = () => streams[0].handlers.snapshot({ data: JSON.stringify(state) });
  try {
    cleanup = mountTeam(root, { projectId: 'p', dirs: ['/sample'], api: async (url: string, options: any) => { if (options) { calls.push([url, options.body]); if (url.endsWith('/start')) Object.assign(state, { status: 'running', run: { id: 'r', mode: 'codex-team', cwd: '/sample', goal: options.body.goal, access: options.body.access }, members: [{ id: 'codex', connection: 'ready' }] }); } return structuredClone(state); } });
    emit(); const $ = (s: string) => root.querySelector(s)!;
    assert.equal($('.team-options').open, false); assert.equal($('.team-stage').open, false);
    $('.team-goal').value = 'Check routes'; await $('.team-goal').fire('input'); $('.team-access').value = 'workspace-write'; await $('.team-access').fire('change');
    assert.match($('.team-options-summary').textContent, /修改隔离副本/); assert.equal($('.team-start').disabled, false);
    await $('.team-start').fire('click');
    assert.deepEqual(calls[0], ['/api/team/start', { projectId: 'p', mode: 'codex-team', cwd: '/sample', goal: 'Check routes', access: 'workspace-write' }]);
    $('.team-input').value = 'Retain my draft'; await $('.team-input').fire('input');
    assert.equal($('.team-tasks').open, false);
    state.approvals = [{ id: 'approval', state: 'pending', detail: 'Inspect this command' }]; emit();
    assert.equal($('.team-tasks').open, true); assert.equal($('.team-input').value, 'Retain my draft');
    $('.team-tasks').open = false; emit(); assert.equal($('.team-tasks').open, false, 'same request respects manual collapse');
    state.approvals.push({ id: 'next', state: 'pending', detail: 'Another command' }); emit(); assert.equal($('.team-tasks').open, true);
    state.run.mode = 'delegation'; state.setup = { command: 'claude --channel example', instructions: 'Connect Claude' }; emit();
    assert.equal($('.team-stage').open, true, 'connection command must remain visible');
    $('.team-stage').open = false; emit(); assert.equal($('.team-stage').open, false);
    handlers.offline!(); assert.equal($('.team-approval-list').querySelector('button')!.disabled, true); assert.equal($('.team-send').disabled, true);
    cleanup!(); assert.equal(streams[0].closed, true);
  } finally { cleanup?.(); for (const [k, v] of Object.entries(originals)) { if (v === undefined) delete g[k]; else g[k] = v; } }
});
