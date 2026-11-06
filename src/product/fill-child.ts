/**
 * The fill's own process (decision 0033, item 27; the owner: "Ну он и должен быть отдельным процессом"): the wiki's
 * fill button and `madarch fill` start `madarch knowledge-fill`, a child of madarch's own, which runs the one
 * orchestrator over the product's store through `startKnowledgeFill` — the same entry both call. The server never
 * opens the fill's store and never runs a fill's statement; it reads the state file the child writes and asks the
 * run to pause or stop through the run's own control file, which the orchestrator host already consumes.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { selfCommand } from './self-command.js';
import { readFillState, type FillProgress } from '../knowledge/fill-run.js';

/** One running fill's child process, as the host holds it. */
export interface FillChild {
  readonly pid: number;
  /** The exit code, or null for a child a signal ended. */
  readonly exited: Promise<number | null>;
  /** Asked to end: SIGTERM, and SIGKILL after a grace. */
  kill(): void;
  readonly signal: AbortSignal;
}

/** How long a fill's child is given to end after it was told to stop, before it is killed. */
const FILL_CHILD_GRACE_MS = 10_000;

/** The product's own control file, the one the orchestrator host's control reads (`consumeFillControl`). */
function fillControlFile(productFolder: string): string {
  return join(productFolder, '.madarch', 'fill', 'control.json');
}

/**
 * A person's pause or stop, written for the run's own state machine to consume: the smallest means there is, because
 * the orchestrator host already reads this file and its own machine decides what a pause or a stop does to a run.
 */
export function writeFillControl(productFolder: string, runId: string, action: 'pause' | 'stop'): void {
  writeFileSync(fillControlFile(productFolder), `${JSON.stringify({ runId, action })}\n`);
}

/** Starts one product's fill as a child process of madarch: the command both the wiki and `madarch fill` run. */
export function spawnFillChild(options: { readonly productFolder: string; readonly storeFolder: string; readonly runId: string; readonly workers?: number }): FillChild {
  const words: string[] = [
    'knowledge-fill', '--product', options.productFolder, '--store', options.storeFolder, '--run', options.runId,
    ...(options.workers === undefined ? [] : ['--workers', String(options.workers)]),
  ];
  const { command, args } = selfCommand(words);
  const controller = new AbortController();
  const child = Bun.spawn([command, ...args], { stdin: 'ignore', stdout: 'ignore', stderr: 'inherit', env: process.env });
  const exited = child.exited.then((code: number) => { controller.abort(); return code; }, () => { controller.abort(); return null; });
  return {
    pid: child.pid,
    exited,
    signal: controller.signal,
    kill: () => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, FILL_CHILD_GRACE_MS);
      killer.unref?.();
      void exited.then(() => clearTimeout(killer));
    },
  };
}

/** The state a fill's child last wrote, or undefined when it wrote none. */
export function lastFillState(storeFolder: string): FillProgress | undefined {
  return readFillState(storeFolder);
}
