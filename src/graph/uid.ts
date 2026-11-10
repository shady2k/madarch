/**
 * A node's stable id (decision 0034, item 2): a UUIDv5 over madarch's namespace
 * and the kind's natural key values, so two machines that find the same entity
 * give it the same uid, and a key's values never change for an entity. A kind
 * with no natural key is not written here: such an entity gets a random uuid
 * when it is created.
 */
import { createHash } from 'node:crypto';

/** Madarch's UUIDv5 namespace: the one every machine derives a key's uid in. */
export const UID_NAMESPACE = Buffer.from('6f1d9a2e4b8c5d7e9f012a3b4c5d6e7f', 'hex');

/** The uid of one entity of a kind, from its key values in the contract's order. */
export function keyUid(kind: string, values: readonly string[]): string {
  const hash = createHash('sha1').update(UID_NAMESPACE).update(`${kind}\0${values.join('\0')}`, 'utf8').digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
