/**
 * The app's link to its server (madarch-64o5.85): one place that knows the server cannot be reached, one retry schedule
 * and one recovered state. A request that fails at the network level, or a proxy's 503 while the server starts, reports
 * the loss; a probe asks the server again with backoff until it answers, and every open page reads again then. The reader
 * sees one calm line with the next retry, never a request's own words.
 */
import { useSyncExternalStore } from 'react';

/** Why the server cannot answer: it is not there, or it says it is starting. */
export type UnreachableReason = 'offline' | 'starting';

/** What the app knows of the link: whether it is down and why, the next probe, and the recovery count. */
export interface ConnectionState {
  readonly offline: boolean;
  readonly reason: UnreachableReason | null;
  /** How many probe attempts have been made since the loss. */
  readonly attempt: number;
  /** The epoch millisecond of the next probe, or null while one is under way. */
  readonly nextRetryAt: number | null;
  /** Grows once for each return from offline, so readers know to ask again. */
  readonly generation: number;
  /** True for a short while after a return, while the frame says «Связь восстановлена». */
  readonly restored: boolean;
}

type Listener = () => void;

/** The wait before each probe, in milliseconds: quick at first, then far enough apart not to hammer a sleeping server. */
const RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 10_000] as const;
/** How long «Связь восстановлена» stays after the server answers. */
const RESTORED_MS = 2000;

let offline = false;
let reason: UnreachableReason | null = null;
let attempt = 0;
let nextRetryAt: number | null = null;
let generation = 0;
let restored = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let restoredTimer: ReturnType<typeof setTimeout> | undefined;
let probe: (() => Promise<void>) | undefined;
const listeners = new Set<Listener>();
let snapshot: ConnectionState = { offline: false, reason: null, attempt: 0, nextRetryAt: null, generation: 0, restored: false };

function publish(): void {
  snapshot = { offline, reason, attempt, nextRetryAt, generation, restored };
  for (const listener of listeners) listener();
}

function schedule(): void {
  if (timer !== undefined || probe === undefined) return;
  const wait = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] as number;
  nextRetryAt = Date.now() + wait;
  publish();
  timer = setTimeout(() => {
    timer = undefined;
    nextRetryAt = null;
    void askAgain();
  }, wait);
}

/** One probe: the app's own read of the server, whose success is what returns the connection. */
async function askAgain(): Promise<void> {
  if (!offline) return;
  attempt += 1;
  nextRetryAt = null;
  publish();
  const ask = probe;
  if (ask === undefined) return;
  try {
    await ask();
  } catch {
    // Still unreachable: the next probe is scheduled below.
  }
  if (offline) schedule();
}

/**
 * Reports a request that could not reach the server. A 503 is the server saying it is starting, and that reason stays
 * until the server answers: a probe's connection refusal in the same restart must not turn a restart into a lost tunnel.
 */
export function reportOffline(why: UnreachableReason = 'offline'): void {
  const nextReason: UnreachableReason = why === 'starting' || reason === 'starting' ? 'starting' : 'offline';
  if (!offline) {
    offline = true;
    reason = nextReason;
    attempt = 0;
    restored = false;
    if (restoredTimer !== undefined) {
      clearTimeout(restoredTimer);
      restoredTimer = undefined;
    }
    publish();
  } else if (reason !== nextReason) {
    reason = nextReason;
    publish();
  }
  schedule();
}

/** Reports that the server answered: the calm state lifts, and every reader learns to ask again. */
export function reportOnline(): void {
  if (!offline) return;
  offline = false;
  reason = null;
  attempt = 0;
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  nextRetryAt = null;
  generation += 1;
  restored = true;
  if (restoredTimer !== undefined) clearTimeout(restoredTimer);
  restoredTimer = setTimeout(() => {
    restoredTimer = undefined;
    restored = false;
    publish();
  }, RESTORED_MS);
  publish();
}

/** A reader's «Повторить сейчас»: probe at once, and let the normal schedule follow a failure. */
export function retryNow(): void {
  if (!offline) return;
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  attempt = 0;
  nextRetryAt = null;
  publish();
  void askAgain();
}

/** Registers the app's probe (one GET to the server); returns the way to unregister it. */
export function setConnectionProbe(next: () => Promise<void>): () => void {
  probe = next;
  if (offline) schedule();
  return () => {
    if (probe !== next) return;
    probe = undefined;
    forgetConnection();
  };
}

/** Forgets the link's state: an app that went away leaves the next mount a fresh line to the server. */
function forgetConnection(): void {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  if (restoredTimer !== undefined) {
    clearTimeout(restoredTimer);
    restoredTimer = undefined;
  }
  offline = false;
  reason = null;
  attempt = 0;
  nextRetryAt = null;
  generation = 0;
  restored = false;
  publish();
}

/** The current recovery count: a read records the one it answered under, so a return from offline is a new read. */
export function connectionGeneration(): number {
  return generation;
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const current = (): ConnectionState => snapshot;

/** The link's state, for the frame's one calm line and for every read that must ask again after a return. */
export function useConnection(): ConnectionState {
  return useSyncExternalStore(subscribe, current, current);
}
