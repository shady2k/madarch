/**
 * One record store opened from a folder (madarch-8bdc.2.5, item 1): the PGlite
 * database the two passes publish into, and the reads of the normal form answer
 * from.
 *
 * The store lives under `<folder>/graph`, the shape a served checkout's state
 * folder already had, so the trace `<folder>/traces/<run>.jsonl` stands beside
 * it and `madarch trace --store <folder>` reads the run. The owner is the
 * process's one connection to that database and the caller closes it.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../adapters/database-owner.js';

/** One opened record store: its owner, and the folder the database lives in. */
export interface OpenRecordStore {
  readonly owner: DatabaseOwner;
  /** The folder holding the database (`<folder>/graph`) and the run's trace (`<folder>/traces`). */
  readonly folder: string;
  readonly databasePath: string;
  close(): Promise<void>;
}

/**
 * Opens the record store of one state folder, creating the database folder when
 * it is absent. The tables are the schema's (`createRecordSchema`), created by
 * the caller that is about to fill or read it, never here: an open store is a
 * connection, not a write.
 */
export function openRecordStore(folder: string): OpenRecordStore {
  const databasePath = join(folder, 'graph');
  mkdirSync(databasePath, { recursive: true });
  const owner = createPGliteDatabaseOwner({ path: databasePath, btreeGist: true, relaxedDurability: true });
  return {
    owner,
    folder,
    databasePath,
    close: async () => { await owner.close(); },
  };
}
