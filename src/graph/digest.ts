/**
 * The graph's digests (decision 0028): the payload digest a refill compares,
 * the edge identity's logical-key hash, the claim's revision digest and the
 * content digest. All of them hash canonical JSON (keys sorted by code point,
 * `src/model/canonical.ts`) or the bytes themselves.
 */
import { createHash } from 'node:crypto';

/** The SHA-256 hex digest of bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
