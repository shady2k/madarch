/** Transaction and receipt storage for the one-time authored Markdown importer. */
import { executeManualOperation, type ManualRequest } from '../graph/manual-operation.js';
import type { WriteAnswer, WriteSource } from '../graph/graph-writes.js';
import { readKindAssertions } from '../graph/records.js';
import { canonicalJson } from '../graph/write.js';
import { byCodePoint } from '../model/order.js';
import { withSpan } from '../obs/trace.js';
import { type ProducerBinding } from '../graph/producer-binding.js';
import type { DatabaseOwner, OuterTransaction } from './database-owner.js';

/** The graph operation receipt preserves the original uid and exact source bytes. */
export interface AuthoredImportIdentity { readonly migration: string; readonly path: string; readonly legacyId: string; }
export async function authoredImportReceipts(tx: OuterTransaction, identity?: AuthoredImportIdentity): Promise<readonly { words: string; uid: string }[]> {
  const records = await readKindAssertions(tx, 'vertex', 'system.operation', ['result']);
  const receipts: { words: string; uid: string; sequence: bigint }[] = [];
  for (const record of records) {
    if (typeof record.values['result'] !== 'string') continue;
    const result = JSON.parse(record.values['result']) as { uid?: string; imported?: { identity: AuthoredImportIdentity; words: string } };
    if (result.imported === undefined) continue;
    if (identity !== undefined && canonicalJson(result.imported.identity) !== canonicalJson(identity)) continue;
    if (result.uid === undefined) throw new Error(`${import.meta.path}:19: an authored import receipt has no entity uid`);
    const input = result.imported;
    receipts.push({ words: input.words, uid: result.uid, sequence: record.assertions.reduce((max, assertion) => assertion.recordedSequence > max ? assertion.recordedSequence : max, 0n) });
  }
  return receipts.sort((a, b) => a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : byCodePoint(a.uid, b.uid));
}

/** Import identity is a scoped graph marker and a real target edge, never a receipt result. */
export async function authoredImportTarget(tx: OuterTransaction, path: string): Promise<string | undefined> {
  return await withSpan('authored.import.target', {}, async () => {
    const markers = await readKindAssertions(tx, 'vertex', 'system.authored-import', ['source_path', 'content_digest']);
    const matching = markers.filter(marker => marker.values['source_path'] === path);
    if (matching.length === 0) return undefined;
    const product = (await tx.query<{ uid: string }>("SELECT n.uid::text AS uid FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='system.product'")).rows[0];
    if (product === undefined) throw new Error(`${import.meta.path}:40: installed product identity is missing`);
    const links = await readKindAssertions(tx, 'edge', 'system.authored-import-target', []);
    const products = await readKindAssertions(tx, 'edge', 'system.authored-import-product', []);
    const productId = Number((await tx.query<{ id: string }>('SELECT id::text FROM node WHERE uid=$1::uuid', [product.uid])).rows[0]!.id);
    const scoped = new Set(matching.filter(marker => products.some(link => link.from === marker.id && link.to === productId)).map(marker => marker.id));
    const ids = [...new Set(links.filter(link => scoped.has(link.from!)).map(link => link.to!))];
    const targets = await tx.query<{ uid: string }>('SELECT uid::text AS uid FROM node WHERE id=ANY($1::bigint[]) ORDER BY uid::text COLLATE "C"', [ids]);
    if (targets.rows.length > 1) throw new Error(`${import.meta.path}:44: authored import path ${JSON.stringify(path)} names several target identities`);
    return targets.rows[0]?.uid;
  });
}

/** Authored history survives entity deletion and must never be discarded by a store reset. */
export async function authoredHistoryPresent(owner: DatabaseOwner): Promise<boolean> {
  return await withSpan('authored.history.present', {}, async () => await owner.transaction('snapshot', async (tx) => {
    return await authoredHistoryIn(tx);
  }));
}

/** Immutable assertion authors remain evidence of person-authored history after a retraction. */
export async function authoredHistoryIn(tx: OuterTransaction): Promise<boolean> {
  return await withSpan('authored.history.read', {}, async () => {
    const installed = await tx.query<{ installed: boolean }>("SELECT to_regclass('public.assertion') IS NOT NULL AS installed");
    if (!installed.rows[0]!.installed) return false;
    const result = await tx.query<{ present: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM assertion a JOIN edge author ON author.from_node=a.assertion_id
      JOIN entity relation ON relation.id=author.entity_id AND relation.name='system.assertion-author'
      JOIN node principal ON principal.id=author.to_node
      JOIN entity kind ON kind.id=principal.entity_id AND kind.name='person'
    ) AS present`);
    return result.rows[0]!.present;
  });
}

/** Bound storage operations used by the file importer. */
export interface AuthoredImportHost {
  receipts(identity: AuthoredImportIdentity): Promise<readonly { words: string; uid: string }[]>;
  write(source: WriteSource, operation: ManualRequest): Promise<WriteAnswer>;
}
export function authoredImportHost(owner: DatabaseOwner, binding: ProducerBinding): AuthoredImportHost {
  return {
    receipts: identity => owner.transaction('snapshot', tx => authoredImportReceipts(tx, identity)),
    write: (source, operation) => executeManualOperation(owner, source, operation, binding),
  };
}
