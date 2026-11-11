/** Transaction and receipt storage for the one-time authored Markdown importer. */
import { withSpan } from '../obs/trace.js';
import type { DatabaseOwner, OuterTransaction } from './database-owner.js';

/** A source's path and legacy id retain its uid even when its bytes change before archiving. */
export async function commitAuthoredImport(owner: DatabaseOwner, identity: { migration: string; path: string; legacyId: string }, words: string, publish: (tx: OuterTransaction, uid: string | undefined) => Promise<void>): Promise<boolean> {
  return await withSpan('authored.import.commit', {}, async () => await owner.transaction('write', async (tx) => {
    const receiptPrefix = `${JSON.stringify(identity).slice(0, -1)},`;
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [receiptPrefix]);
    const receipts = await tx.query<{ words: string; change: { vertices: { uid: string; state: string }[] } }>(
      'SELECT words, change FROM operation WHERE left(words, length($1)) = $1 ORDER BY seq', [receiptPrefix],
    );
    if (receipts.rows.at(-1)?.words === words) return false;
    const first = receipts.rows[0];
    const uid = first?.change.vertices.find((vertex) => vertex.state === 'declared')?.uid;
    if (first !== undefined && uid === undefined) throw new Error(`${import.meta.path}:1: the authored import receipt has no declared entity uid`);
    await publish(tx, uid);
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
