import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { spawn } from 'node-pty';
import type { IPty, IPtyForkOptions } from 'node-pty';
import { prepareProvider, terminalEnv } from './provider.ts';
import type { TerminalProvider } from './provider.ts';
export type { TerminalProvider } from './provider.ts';
export class TerminalError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.name = 'TerminalError'; this.status = status; }
}
export interface TerminalChunk { seq: number; data: string }
export interface TerminalSnapshot {
  id: string; projectId: string; provider: TerminalProvider; cwd: string;
  state: 'running' | 'exited' | 'error'; exitCode: number | null; createdAt: string;
  cols: number; rows: number; output: TerminalChunk[]; lastSeq: number; truncated: boolean; error?: string;
}
export type TerminalEvent = ({ type: 'output' } & TerminalChunk) | { type: 'state'; session: Omit<TerminalSnapshot, 'output'> };
export interface CreateTerminal { provider: TerminalProvider; cwd: string; cols?: number; rows?: number; requestId: string }
export interface TerminalManagerOptions {
  spawn?: (command: string, args: string[], options: IPtyForkOptions) => IPty;
  prepare?: typeof prepareProvider;
  maxSessions?: number; replayBytes?: number; stopGraceMs?: number;
}
export function createTerminalManager(options: TerminalManagerOptions = {}) {
  type Session = { snapshot: TerminalSnapshot; pty?: IPty; listeners: Set<(event: TerminalEvent) => void>; bytes: number; stopping?: boolean; timer?: NodeJS.Timeout; done: Promise<void>; finish(): void };
  const sessions = new Map<string, Session>();
  const requests = new Map<string, { fingerprint: string; promise: Promise<TerminalSnapshot> }>();
  let closed = false, creating = 0;
  const replayBytes = options.replayBytes ?? 256 * 1024;
  const copy = (s: Session): TerminalSnapshot => ({ ...s.snapshot, output: s.snapshot.output.map(chunk => ({ ...chunk })) });
  function lookup(projectId: string, id: string) {
    const s = sessions.get(id); if (!s || s.snapshot.projectId !== projectId) throw new TerminalError(404, 'Terminal not found'); return s;
  }
  function emit(s: Session, event: TerminalEvent) { for (const listener of s.listeners) { try { listener(event); } catch { /* A disconnected client cannot affect the PTY. */ } } }
  function dimensions(cols: number, rows: number) { if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 1 || rows > 200) throw new TerminalError(400, 'Invalid terminal dimensions'); }
  function signal(s: Session, name: string) {
    // Unix PTYs create their own session/process group. Never target the service's group.
    if (process.platform !== 'win32' && s.pty && s.pty.pid > 1) {
      try { process.kill(-s.pty.pid, name as NodeJS.Signals); return; } catch { /* Fall back to the owned PTY. */ }
    }
    try { s.pty?.kill(name); } catch { /* Already exited. */ }
  }
  function stopSession(s: Session) {
    if (s.snapshot.state !== 'running' || s.stopping) return;
    s.stopping = true;
    signal(s, 'SIGTERM');
    s.timer = setTimeout(() => { if (s.snapshot.state === 'running') signal(s, 'SIGKILL'); }, options.stopGraceMs ?? 1500);
    s.timer.unref();
  }
  return {
    list(projectId: string) { return [...sessions.values()].filter(s => s.snapshot.projectId === projectId).map(copy); },
    get(projectId: string, id: string) { return copy(lookup(projectId, id)); },
    create(projectId: string, input: CreateTerminal): Promise<TerminalSnapshot> {
      if (closed) return Promise.reject(new TerminalError(409, 'Terminal manager is closed'));
      if (!projectId || !input || !['codex', 'claude'].includes(input.provider) || typeof input.cwd !== 'string' || !input.cwd || typeof input.requestId !== 'string' || !input.requestId || input.requestId.length > 200) return Promise.reject(new TerminalError(400, 'Invalid terminal request'));
      const cols = input.cols ?? 100, rows = input.rows ?? 30;
      try { dimensions(cols, rows); } catch (error) { return Promise.reject(error); }
      const key = JSON.stringify([projectId, input.requestId]);
      const fingerprint = JSON.stringify([input.provider, input.cwd, cols, rows]);
      const existing = requests.get(key);
      if (existing) return existing.fingerprint === fingerprint ? existing.promise.then(s => copy(lookup(projectId, s.id))) : Promise.reject(new TerminalError(409, 'Request ID reused with different content'));
      if (creating + [...sessions.values()].filter(s => s.snapshot.state === 'running').length >= (options.maxSessions ?? 8)) return Promise.reject(new TerminalError(409, 'Active terminal limit reached'));
      creating++;
      const promise = (async () => {
        let cwd: string;
        try {
          cwd = await realpath(input.cwd);
          if (!(await stat(cwd)).isDirectory()) throw new Error('Not a directory');
        } catch { throw new TerminalError(400, 'Terminal cwd must be an existing directory'); }
        const env = terminalEnv();
        const launch = await (options.prepare ?? prepareProvider)(input.provider, env);
        if (closed) throw new TerminalError(409, 'Terminal manager is closed');
        let finish!: () => void;
        const s: Session = { snapshot: { id: randomUUID(), projectId, provider: input.provider, cwd, state: 'running', exitCode: null, createdAt: new Date().toISOString(), cols, rows, output: [], lastSeq: 0, truncated: false }, listeners: new Set(), bytes: 0, done: new Promise<void>(resolve => { finish = resolve; }), finish: () => finish() };
        sessions.set(s.snapshot.id, s);
        try {
          s.pty = (options.spawn ?? spawn)(launch.command, launch.args, { cwd, cols, rows, name: 'xterm-256color', env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) });
          s.pty.onData(data => {
            // Split huge writes so a single write cannot defeat the replay bound.
            for (let offset = 0; offset < data.length; offset += 4096) {
              const chunk = { seq: ++s.snapshot.lastSeq, data: data.slice(offset, offset + 4096) };
              s.snapshot.output.push(chunk); s.bytes += Buffer.byteLength(chunk.data);
              while (s.bytes > replayBytes && s.snapshot.output.length) { s.bytes -= Buffer.byteLength(s.snapshot.output.shift()!.data); s.snapshot.truncated = true; }
              emit(s, { type: 'output', ...chunk });
            }
          });
          s.pty.onExit(({ exitCode }) => { clearTimeout(s.timer); s.snapshot.state = 'exited'; s.snapshot.exitCode = exitCode; s.finish(); const { output: _, ...metadata } = s.snapshot; emit(s, { type: 'state', session: { ...metadata } }); });
        } catch { s.snapshot.state = 'error'; s.snapshot.error = `${input.provider} terminal could not start`; s.finish(); }
        return copy(s);
      })().finally(() => { creating--; });
      requests.set(key, { fingerprint, promise });
      void promise.catch(() => { requests.delete(key); });
      return promise;
    },
    input(projectId: string, id: string, data: string) {
      const s = lookup(projectId, id);
      if (typeof data !== 'string' || Buffer.byteLength(data) > 64 * 1024) throw new TerminalError(400, 'Terminal input exceeds limit');
      if (s.snapshot.state !== 'running' || s.stopping) throw new TerminalError(409, 'Terminal is not running');
      s.pty!.write(data);
    },
    resize(projectId: string, id: string, cols: number, rows: number) {
      const s = lookup(projectId, id); dimensions(cols, rows);
      if (s.snapshot.state !== 'running' || s.stopping) throw new TerminalError(409, 'Terminal is not running');
      s.pty!.resize(cols, rows); s.snapshot.cols = cols; s.snapshot.rows = rows; return copy(s);
    },
    stop(projectId: string, id: string) { const s = lookup(projectId, id); stopSession(s); return copy(s); },
    subscribe(projectId: string, id: string, listener: (event: TerminalEvent) => void) {
      const s = lookup(projectId, id); s.listeners.add(listener); return () => { s.listeners.delete(listener); };
    },
    async close() {
      closed = true;
      for (const s of sessions.values()) stopSession(s);
      await Promise.allSettled([...requests.values()].map(r => r.promise));
      await Promise.all([...sessions.values()].map(s => s.done));
      for (const s of sessions.values()) s.listeners.clear();
    },
  };
}
export type TerminalManager = ReturnType<typeof createTerminalManager>;
