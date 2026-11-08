/**
 * What the last fill changed, as kept beside the store (madarch-u3vw2): the file that marks a run under way and the
 * list of one completed run. A list belongs to the run whose start and end it names; a run that was under way when the
 * server stopped leaves no list, because the one beside the store is the run before it. Nothing here reads the graph or
 * the clock.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangedPage } from './model.js';

export const ACTIVE_FILL_FILE = 'fill-active.json';
export const CHANGED_PAGES_FILE = 'changed-pages.json';

/** The run a kept result names: its start tells it from an earlier one, and its end says it completed. */
export interface RecordedRun {
  readonly startedAt: string | null;
  readonly finishedAt: string;
}

/** The pages a completed run changed, or undefined when none was recorded, the run did not complete, or a run is active. */
export function readChangedPages(folder: string, lastRun: RecordedRun | undefined): ChangedPage[] | undefined {
  if (existsSync(join(folder, ACTIVE_FILL_FILE))) return undefined;
  try {
    const kept = JSON.parse(readFileSync(join(folder, CHANGED_PAGES_FILE), 'utf8')) as { startedAt?: unknown; finishedAt?: unknown; pages?: unknown };
    if (lastRun === undefined || lastRun.startedAt === null) return undefined;
    if (kept.startedAt !== lastRun.startedAt || kept.finishedAt !== lastRun.finishedAt || !Array.isArray(kept.pages)) return undefined;
    const pages: ChangedPage[] = [];
    for (const entry of kept.pages) {
      const page = entry as { id?: unknown; title?: unknown } | null;
      if (page !== null && typeof page === 'object' && typeof page.id === 'string' && typeof page.title === 'string') pages.push({ id: page.id, title: page.title });
    }
    return pages;
  } catch {
    return undefined;
  }
}

/** Removes the list of the run before and the mark of a run interrupted at launch; a completed list is left alone. */
export function invalidateInterruptedRun(folder: string): boolean {
  if (!existsSync(join(folder, ACTIVE_FILL_FILE))) return false;
  rmSync(join(folder, CHANGED_PAGES_FILE), { force: true });
  rmSync(join(folder, ACTIVE_FILL_FILE), { force: true });
  return true;
}
