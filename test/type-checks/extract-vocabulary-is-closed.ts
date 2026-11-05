/**
 * Not a test suite: a compile-time check that the extractors' vocabulary is closed (decision 0033, item 7;
 * the mapping check's P1 item). `bun run check` (`tsc --noEmit`) fails if an extraction record accepts a kind or
 * relation type the extractors do not declare, and also fails if the `@ts-expect-error` below stops being an
 * error — so a new emission must first be declared beside its extractor, exactly where the code that emits it
 * lives. This file is not named `*.test.ts`, so `bun test` never runs it; only `tsc` reads it.
 */
import type { ExtractedEdge, ExtractedNode } from '../../src/extract/records.js';

/** A node record of every shape, its kind a declared one: this must type-check with no error. */
const declared: ExtractedNode = { key: 'code.symbol:a#b', kind: 'code.symbol', label: 'b', properties: {} };
/** An edge of a declared relation type: this must type-check too. */
const declaredEdge: ExtractedEdge = { type: 'code.contains', from: declared.key, to: declared.key, discriminator: '', properties: {} };

// @ts-expect-error — "code.cache" is emitted by no extractor's declaration: a new kind is declared before it is emitted.
const undeclaredKind: ExtractedNode = { key: 'code.cache:x', kind: 'code.cache', label: 'x', properties: {} };
// @ts-expect-error — "code.caches" is emitted by no extractor's declaration: a new relation is declared before it is emitted.
const undeclaredEdge: ExtractedEdge = { type: 'code.caches', from: declared.key, to: declared.key, discriminator: '', properties: {} };

export { declared, declaredEdge, undeclaredKind, undeclaredEdge };
