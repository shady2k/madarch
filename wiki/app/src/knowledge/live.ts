/**
 * The wiki's status and its live channel (decision 0029: "an empty graph shows
 * what to do next; a fill updates the open pages as it goes"). The server's one
 * change stream (`/api/events`) says `change` when a file of the product or a
 * commit of the fill changes what a page shows; the status, which carries the
 * fill's place, is read again then, and `version` changes so an open page reads
 * itself again. There is no polling: a quiet product asks for nothing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { eventsAddress, getStatus } from './api.js';
import type { WikiStatus } from './types.js';

/** How long a burst of commits is gathered into one read. */
export const GATHER_MS = 250;

export function useWikiStatus(): { status: WikiStatus | null; error: string | null; version: number; refresh: () => void } {
  const [status, setStatus] = useState<WikiStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const reading = useRef(false);
  const again = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One read at a time: during a fill the database answers between commits, so a read is never cut short by the
  // next commit's event (that would starve the page); a change that lands while one is under way asks for one more.
  const load = useCallback((): void => {
    if (reading.current) {
      again.current = true;
      return;
    }
    reading.current = true;
    const mine = new AbortController();
    controller.current = mine;
    getStatus(mine.signal).then(
      (next) => {
        if (mine.signal.aborted) return;
        setStatus(next);
        setError(null);
        setVersion((held) => held + 1);
      },
      (failure: unknown) => {
        if (mine.signal.aborted) return;
        setError(failure instanceof Error ? failure.message : String(failure));
      },
    ).finally(() => {
      reading.current = false;
      if (again.current && !mine.signal.aborted) {
        again.current = false;
        load();
      }
    });
  }, []);

  useEffect(() => {
    load();
    if (typeof EventSource === 'undefined') return () => controller.current?.abort();
    const source = new EventSource(eventsAddress());
    const gather = (): void => {
      if (timer.current !== null) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        load();
      }, GATHER_MS);
    };
    source.addEventListener('change', gather);
    return () => {
      source.close();
      controller.current?.abort();
      // A remount (StrictMode) must not find the aborted read still holding the slot.
      reading.current = false;
      again.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [load]);

  return { status, error, version, refresh: load };
}

/**
 * One read of the server for a page, kept alive across the commits of a fill.
 * `key` names what is read (a page's id, a kind and its filter); `version` moves
 * after each commit. A new key abandons the read in flight and clears the data; a
 * new version never cuts a read short and never clears the data: it asks for one
 * more read once the one under way ends, so a slow answer is not starved by the
 * next commit, and the page keeps showing what it has until the new one arrives.
 */
export function useRead<T>(key: string, version: number, read: (signal: AbortSignal) => Promise<T>): { data: T | null; error: string | null } {
  const [state, setState] = useState<{ key: string; data: T | null; error: string | null }>({ key, data: null, error: null });
  const flight = useRef<{ key: string; controller: AbortController } | null>(null);
  const queued = useRef(false);
  const latest = useRef({ key, read });
  latest.current = { key, read };
  const start = useCallback((): void => {
    const { key: asked, read: reader } = latest.current;
    const controller = new AbortController();
    flight.current = { key: asked, controller };
    reader(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ key: asked, data, error: null });
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) setState((held) => ({ key: asked, data: held.key === asked ? held.data : null, error: failure instanceof Error ? failure.message : String(failure) }));
      },
    ).finally(() => {
      if (flight.current?.controller !== controller) return;
      flight.current = null;
      if (queued.current || latest.current.key !== asked) {
        queued.current = false;
        start();
      }
    });
  }, []);
  useEffect(() => {
    if (flight.current !== null && flight.current.key !== key) {
      flight.current.controller.abort();
      flight.current = null;
      queued.current = false;
    }
    if (flight.current !== null) {
      queued.current = true;
      return;
    }
    start();
  }, [key, version, start]);
  useEffect(() => () => {
    flight.current?.controller.abort();
    flight.current = null;
    queued.current = false;
  }, []);
  return state.key === key ? { data: state.data, error: state.error } : { data: null, error: null };
}
