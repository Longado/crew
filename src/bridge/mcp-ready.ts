interface StartupEvent { threadId: string | null; name: string; status: string; error?: string | null }
/** Cache startup events even when they precede thread/start's RPC response. */
export function createBridgeReadyGate() {
  const states = new Map<string, StartupEvent>();
  const waiting = new Map<string, { resolve(): void; reject(error: Error): void }>();
  let closed = false;
  function settle(threadId: string) {
    const state = states.get(threadId); const waiter = waiting.get(threadId);
    if (!state || !waiter) return;
    if (state.status === 'ready') waiter.resolve();
    else if (['failed', 'cancelled'].includes(state.status)) waiter.reject(new Error(`Codex Bridge MCP initialization ${state.status}`));
  }
  return {
    accept(event: StartupEvent) {
      if (closed || event.name !== 'corpus_bridge' || !event.threadId) return;
      states.set(event.threadId, event); settle(event.threadId);
    },
    wait(threadId: string, timeoutMs = 60_000) {
      if (closed) return Promise.reject(new Error('Team stopped'));
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(threadId); reject(new Error('Timed out waiting for Codex Bridge MCP initialization')); }, timeoutMs);
        waiting.set(threadId, { resolve() { clearTimeout(timer); waiting.delete(threadId); resolve(); }, reject(error) { clearTimeout(timer); waiting.delete(threadId); reject(error); } });
        settle(threadId);
      });
    },
    close() { closed = true; for (const waiter of waiting.values()) waiter.reject(new Error('Team stopped')); waiting.clear(); states.clear(); },
  };
}
