/** Federation-safe identity tuples, decision 0039 item 28. */
import { createHash, randomBytes } from 'node:crypto';
export const UID_NAMESPACE = Buffer.from('6f1d9a2e4b8c5d7e9f012a3b4c5d6e7f','hex');
function uuid(bytes: Uint8Array): string {
  const hex=Buffer.from(bytes).toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
}
/** Length-delimited names cannot collide by moving separators between fields. */
export function keyUid(kind: string, values: readonly string[]): string {
  const tuple=['madarch.identity.v1',kind,...values];
  const hash=createHash('sha1').update(UID_NAMESPACE);
  for(const value of tuple) {const bytes=Buffer.from(value,'utf8');const length=Buffer.alloc(4);length.writeUInt32BE(bytes.length);hash.update(length).update(bytes);}
  const bytes=hash.digest().subarray(0,16);bytes[6]=(bytes[6]!&15)|80;bytes[8]=(bytes[8]!&63)|128;
  return uuid(bytes);
}
/** UUIDv7 births for keyless identities, operation and assertion vertices. */
export function newUid(): string {
  const bytes=randomBytes(16);let millis=BigInt(Date.now());
  for(let i=5;i>=0;i--) {bytes[i]=Number(millis&255n);millis>>=8n;}
  bytes[6]=(bytes[6]!&15)|112;bytes[8]=(bytes[8]!&63)|128;
  return uuid(bytes);
}
