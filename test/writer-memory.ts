/** In-memory writer sinks and journals for tests (the shapes src/writer/run.ts and src/writer/journal.ts keep for themselves). */
import { byCodePoint } from '../src/model/order.js';
import type { PageSink } from '../src/writer/tools.js';
import { recordOf, type Journal } from '../src/writer/journal.js';

type JournalRecord = ReturnType<typeof recordOf>;

/** A sink that keeps the pages in a map. */
export function memorySink(): PageSink & { readonly pages: Map<string, string> } {
  const pages = new Map<string, string>();
  return {
    pages,
    write: async (relativePath, content) => { pages.set(relativePath, content); },
    read: async (relativePath) => {
      const page = pages.get(relativePath);
      if (page === undefined) throw new Error(`the sink holds no ${relativePath}`);
      return page;
    },
    list: async (folder) => [...pages.keys()].filter((key) => key.startsWith(`${folder}/`)).sort(byCodePoint),
  };
}

/** A journal that keeps its records in memory. */
export function memoryJournal(run = 'run-test'): Journal & { readonly records: JournalRecord[] } {
  const records: JournalRecord[] = [];
  return { file: `memory:${run}`, run, records, record: (context, entry) => { records.push(recordOf(context, entry)); } };
}
