/**
 * The app's link to its server (madarch-64o5.85, the owner's walk): one place that knows the server cannot be reached,
 * one retry schedule and one recovered state. A request that fails at the network level reports the loss; a probe asks
 * the server again with backoff until it answers, and every open page reads again then. The reader sees one calm line,
 * never a request's own words.
 */
import { useSyncExternalStore } from 'react';

/** What the app knows of the link: whether it is down, how many probe attempts have been made, and the recovery count. */
export interface ConnectionState {
  readonly offline: boolean;
  readonly attempt: number;
  /** Grows once for each return from offline, so readers know to ask again. */
  readonly generation: number;
}

type Listener = () => void;

/** The wait before each probe, in milliseconds: quick at first, then far enough apart not to hammer a sleeping server. */
const RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 10_000] as const;

let offline = false;
let attempt = 0;
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let probe: (() => Promise<void>) | undefined;
const listeners = new Set<Listener>();
let snapshot: ConnectionState = { offline: false, attempt: 0, generation: 0 };

function publish(): void {
  snapshot = { offline, attempt, generation };
  for (const listener of listeners) listener();
}

function schedule(): void {
  if (timer !== undefined || probe === undefined) return;
  const wait = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] as number;
  timer = setTimeout(() => {
    timer = undefined;
    void askAgain();
  }, wait);
}

/** One probe: the app's own read of the server, whose success is what returns the connection. */
async function askAgain(): Promise<void> {
  if (!offline) return;
  attempt += 1;
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

/** Reports a request that could not reach the server: the calm state stands, and a probe is scheduled. */
export function reportOffline(): void {
  if (!offline) {
    offline = true;
    attempt = 0;
    publish();
  }
  schedule();
}

/** Reports that the server answered: the calm state lifts and every reader learns to ask again. */
export function reportOnline(): void {
  if (!offline) return;
  offline = false;
  attempt = 0;
  generation += 1;
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  publish();
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
  offline = false;
  attempt = 0;
  generation = 0;
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
