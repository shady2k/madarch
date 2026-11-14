/**
 * The request watchdog (the owner's words, 2026-11-14): a span is written when it ends, so a request that never ends leaves
 * no trace of itself. Every request is therefore logged when it starts and when it ends, and one that is still running
 * after the bound logs a warning that names its path and the stage it stands in — the line the coordinator reads to see a
 * hung API from outside.
 */
export interface WatchdogClock {
  readonly setTimeout: (work: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export interface WatchdogReport {
  readonly requestId: string;
  readonly httpMethod: string;
  readonly httpPath: string;
  readonly stage: string;
  readonly elapsedMs: number;
}

export interface ArmedRequest {
  /** The stage the request stands in now: the line the warning names. */
  readonly stage: (value: string) => void;
  /** The request ended: the timer is cleared and no warning is written. */
  readonly done: () => void;
}

/** The bound after which a request still running is warned about, and the warning itself. */
export const WATCHDOG_MS = 2_000;

/**
 * Arms the watchdog for one request. `warn` is called once, when the bound passes while the request still runs; a request
 * that ends first clears the timer and warns nothing.
 */
export function watchRequest(
  request: { readonly requestId: string; readonly httpMethod: string; readonly httpPath: string },
  warn: (report: WatchdogReport) => void,
  options: { readonly afterMs?: number; readonly clock?: WatchdogClock; readonly now?: () => number } = {},
): ArmedRequest {
  const clock = options.clock ?? { setTimeout: (work: () => void, ms: number) => setTimeout(work, ms), clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  const now = options.now ?? (() => performance.now());
  const started = now();
  let stage = 'handling';
  let warned = false;
  const handle = clock.setTimeout(() => {
    warned = true;
    warn({ requestId: request.requestId, httpMethod: request.httpMethod, httpPath: request.httpPath, stage, elapsedMs: Math.round(now() - started) });
  }, options.afterMs ?? WATCHDOG_MS);
  return {
    stage: (value: string) => { stage = value; },
    done: () => { if (!warned) clock.clearTimeout(handle); },
  };
}
