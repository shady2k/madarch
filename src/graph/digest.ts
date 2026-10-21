/**
 * The graph's digests (decision 0028): the payload digest a refill compares,
 * the edge identity's logical-key hash, the claim's revision digest and the
 * content digest. All of them hash canonical JSON (keys sorted by code point,
 * `src/model/canonical.ts`) or the bytes themselves.
 */
import { createHash } from 'node:crypto';
import { canonicalJsonDigest } from '../model/canonical.js';
import { byCodePoint } from '../model/order.js';

export type GraphId = string;

/** A byte span of a content node: half-open offsets into its bytes. */
export interface ByteSpan {
  start: number;
  end: number;
}

/** The SHA-256 hex digest of bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** What a node version believes apart from its times, states and producer. */
export function nodePayloadDigest(payload: { kind: string; label: string; properties: unknown; contentSha256: string | null; claimDigest: string | null }): string {
  return canonicalJsonDigest({ claimDigest: payload.claimDigest, contentSha256: payload.contentSha256, kind: payload.kind, label: payload.label, properties: payload.properties });
}

/** What an edge version believes apart from its times, states and producer. */
export function edgePayloadDigest(payload: { relation: string; src: GraphId; dst: GraphId; discriminator: string; position: ByteSpan | null; properties: unknown }): string {
  return canonicalJsonDigest({ discriminator: payload.discriminator, dst: payload.dst, position: payload.position, properties: payload.properties, relation: payload.relation, src: payload.src });
}

/**
 * An edge's logical key: its relation type, its two end identities and a
 * discriminator. A positioned occurrence's key is its type, the symbol (source),
 * the content node it points into (destination) and its starting byte.
 */
export function edgeKeyHash(key: { relation: string; src: GraphId; dst: GraphId; discriminator: string; position: ByteSpan | null }): string {
  const discriminator = key.position === null ? key.discriminator : `byte:${key.position.start}`;
  return canonicalJsonDigest({ discriminator, dst: key.dst, relation: key.relation, src: key.src });
}

/** An evidence span of a claim: a content digest and offsets. */
export interface EvidenceSpan {
  contentSha256: string;
  start: number;
  end: number;
}

export interface ClaimContent {
  statement: string;
  /** What kind of claim it is, in the caller's words. */
  claimKind: string;
  /** The identities of the nodes the claim is about. */
  subjects: readonly GraphId[];
  evidence: readonly EvidenceSpan[];
}

/**
 * The claim's canonical form (0028, "Claims, evidence, questions,
 * acceptance"): statement and kind, subjects' identities and evidence spans,
 * with field names and arrays sorted by code point. Duplicates collapse, so
 * the same claim written twice has one digest.
 */
export function claimCanonicalForm(claim: ClaimContent): { claimKind: string; evidence: { contentSha256: string; end: number; start: number }[]; statement: string; subjects: string[] } {
  const evidence = claim.evidence.map((span) => ({ contentSha256: span.contentSha256, end: span.end, start: span.start }));
  const keyed = new Map(evidence.map((span) => [JSON.stringify([span.contentSha256, span.start, span.end]), span]));
  return {
    claimKind: claim.claimKind,
    evidence: [...keyed.entries()].sort(([a], [b]) => byCodePoint(a, b)).map(([, span]) => span),
    statement: claim.statement,
    subjects: [...new Set(claim.subjects)].sort(byCodePoint),
  };
}

/** The revision digest of a claim: SHA-256 of its canonical form. */
export function claimDigest(claim: ClaimContent): string {
  return canonicalJsonDigest(claimCanonicalForm(claim));
}
