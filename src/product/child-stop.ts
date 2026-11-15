/**
 * Ends a child this process started, within a bound. A role that will not leave after SIGTERM — or one whose output a
 * descendant still holds open — is not a wait a command may keep forever: it is killed, and a child that outlives even
 * that is named so the caller can fail with what happened instead of hanging on it.
 */
export interface StoppableChild {
  readonly pid: number | undefined;
  kill(signal?: NodeJS.Signals | number): unknown;
  /** Ends when the child has ended: a process's own `exited`, or a close event that also waits for its output. */
  readonly exited: Promise<unknown>;
}

export type ChildStopOutcome = 'ended' | 'killed' | 'stuck';

export interface ChildStopOptions {
  /** What the child is, for the lines this prints: "the api role". */
  readonly what: string;
  /** How long SIGTERM is given before the child is killed. */
  readonly graceMs?: number;
  /** How long the kill is given before the child is called stuck. */
  readonly killWaitMs?: number;
  readonly log?: (line: string) => void;
}

/** Answers whether `work` finished within `ms`; a rejection counts as finished, since the caller waits for an end. */
async function within(work: Promise<unknown>, ms: number): Promise<boolean> {
  return await Promise.race([work.then(() => true, () => true), new Promise<boolean>((answer) => { const timer = setTimeout(() => answer(false), ms); (timer as unknown as { unref?: () => void }).unref?.(); })]);
}

/**
 * Asks the child to stop and answers how it ended. SIGTERM is always sent first: the caller may already have sent it,
 * and a second one costs nothing.
 */
export async function stopChildWithin(child: StoppableChild, options: ChildStopOptions): Promise<ChildStopOutcome> {
  const graceMs = options.graceMs ?? 30_000;
  const killWaitMs = options.killWaitMs ?? 10_000;
  const log = options.log ?? ((line: string) => console.error(line));
  try { child.kill('SIGTERM'); } catch { /* gone between the check and the signal */ }
  if (await within(child.exited, graceMs)) return 'ended';
  log(`${options.what} (pid ${String(child.pid)}) did not end within ${String(graceMs)} ms of SIGTERM, so it is killed`);
  try { child.kill('SIGKILL'); } catch { /* gone */ }
  if (await within(child.exited, killWaitMs)) return 'killed';
  log(`${options.what} (pid ${String(child.pid)}) did not end within ${String(killWaitMs)} ms of SIGKILL: something of it still holds this process's output open`);
  return 'stuck';
}
