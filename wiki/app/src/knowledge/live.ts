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
