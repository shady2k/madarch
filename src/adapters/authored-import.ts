/** Transaction and receipt storage for the one-time authored Markdown importer. */
import { withSpan } from '../obs/trace.js';
import type { DatabaseOwner, OuterTransaction } from './database-owner.js';

/** A source's receipt and entity publication commit together; retries publish nothing twice. */
export async function commitAuthoredImport(owner: DatabaseOwner, lock: string, words: string, publish: (tx: OuterTransaction) => Promise<void>): Promise<boolean> {
  return await withSpan('authored.import.commit', {}, async () => await owner.transaction('write', async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lock]);
    const receipt = await tx.query<{ words: string }>('SELECT words FROM operation WHERE words = $1 LIMIT 1', [words]);
    if (receipt.rows.length > 0) return false;
    await publish(tx);
    return true;
  }));
}

/** Authored history survives entity deletion and must never be discarded by a store reset. */
export async function authoredHistoryPresent(owner: DatabaseOwner): Promise<boolean> {
  return await withSpan('authored.history.present', {}, async () => await owner.transaction('snapshot', async (tx) => {
    const result = await tx.query<{ present: boolean }>("SELECT EXISTS (SELECT 1 FROM operation WHERE author LIKE 'person:%') AS present");
    return result.rows[0]!.present;
  }));
}
