/** Retry metadata for future assertions. No assertion facts are stored here. */
import { randomBytes } from 'node:crypto';
import { withSpan } from '../obs/trace.js';
import type { SqlExecutor } from '../sql-driver.js';

/** UUIDv7's clock bits identify creation time only; recorded order is always database sequence order. */
function assertionUid(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6]! & 15) | 0x70;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The host supplies a retained operation vertex and stable logical slot, not a newly generated retry token. */
export async function reserveAssertionIdentity(tx: SqlExecutor, operationUid: string, slot: string, intentDigest: string): Promise<string> {
  return await withSpan('graph.reserveAssertionIdentity', {}, async () => {
    if (slot.length === 0 || intentDigest.length === 0) throw new Error(`${import.meta.path}:19: assertion operation slot or intent digest is empty`);
    const operation = await tx.query<{ id: string }>(
      `SELECT n.id::text AS id FROM node n JOIN entity e ON e.id = n.entity_id
       WHERE n.uid = $1::uuid AND e.name = 'operation' AND NOT n.removed`, [operationUid]);
    const node = operation.rows[0]?.id;
    if (node === undefined) throw new Error(`${import.meta.path}:24: operation ${operationUid} is not a retained operation vertex`);
    const inserted = await tx.query<{ uid: string }>(
      `INSERT INTO operation_assertion_receipt (operation_node, slot, assertion_uid, intent_digest) VALUES ($1, $2, $3::uuid, $4)
       ON CONFLICT (operation_node, slot) DO NOTHING RETURNING assertion_uid::text AS uid`, [node, slot, assertionUid(), intentDigest]);
    if (inserted.rows[0] !== undefined) return inserted.rows[0].uid;
    const held = await tx.query<{ uid: string; intent_digest: string }>(
      'SELECT intent_digest, assertion_uid::text AS uid FROM operation_assertion_receipt WHERE operation_node = $1 AND slot = $2', [node, slot]);
    if (held.rows[0]!.intent_digest !== intentDigest) throw new Error(`${import.meta.path}:31: operation ${operationUid} slot ${slot} was already accepted with a different intent`);
    return held.rows[0]!.uid;
  });
}
