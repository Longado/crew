import { existsSync } from 'node:fs';

/** A marker belongs only to this launcher's private run directory. */
export function stopRequested(markerPath: string) { return existsSync(markerPath); }

/** A busy local event loop can delay heartbeats without ending the owned team. */
export function createLivenessGuard(graceMs = 60_000) {
  let failedSince: number | undefined;
  return {
    shouldStop(status: number | undefined, at = Date.now()) {
      if (status === 401 || status === 410) return true;
      if (status !== undefined && status >= 200 && status < 300) {
        failedSince = undefined;
        return false;
      }
      failedSince ??= at;
      return at - failedSince >= graceMs;
    },
  };
}
