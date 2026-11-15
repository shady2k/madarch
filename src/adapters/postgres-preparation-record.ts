/**
 * The records madarch writes beside a store's data directory about its preparation, and the reading of them that every
 * caller shares. They live here, apart from the cluster's own module, so a caller that only asks "is this store being
 * prepared?" — the Windows stop, say — does not load PostgreSQL's client, its library calls and the release identity.
 *
 * `madarch.preparing` is written before an initdb is spawned and names it once it has a pid; `madarch.prepared` is
 * written once that initdb ends. A folder that holds files and neither record is no preparation of ours.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Our record of a preparation under way, beside the data directory. */
export const PREPARING_FILE = 'madarch.preparing';
/** Our record that a preparation finished, beside the data directory. */
export const PREPARED_FILE = 'madarch.prepared';

/** What `madarch.preparing` holds: who is making the cluster, and the initdb it spawned, once there is one. */
export interface PreparingRecord {
  readonly version: string;
  readonly startedAt: string;
  readonly initdb?: { readonly pid: number; readonly startTime?: string };
}

export function preparingRecordPath(dataDir: string): string { return join(dirname(dataDir), PREPARING_FILE); }
export function preparedRecordPath(dataDir: string): string { return join(dirname(dataDir), PREPARED_FILE); }

/** Whether a preparation madarch started is under way in this data directory: its record is there and no prepared one is. */
export function preparationInProgress(dataDir: string): boolean {
  return existsSync(preparingRecordPath(dataDir)) && !existsSync(preparedRecordPath(dataDir));
}
