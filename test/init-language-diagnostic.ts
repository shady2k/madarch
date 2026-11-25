import type { SpawnSyncReturns } from 'node:child_process';
/** Keep both child streams visible before an exit assertion hides the cause. */
export function reportInitFailure(run: Pick<SpawnSyncReturns<string>, 'status' | 'signal' | 'error' | 'stdout' | 'stderr'>): void {
 if (run.status === 0) return;
 console.error(`init child status=${String(run.status)} signal=${String(run.signal)} error=${String(run.error)}`);
 console.error('init child stdout:'); console.error(run.stdout ?? '');
 console.error('init child stderr:'); console.error(run.stderr ?? '');
}
