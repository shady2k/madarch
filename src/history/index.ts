/**
 * The model-history capability's interface: keeping every version of every
 * source's compiled model, with both time axes, from the first write. This
 * module and `assertions.ts` touch no Bun-specific API; the only
 * implementation so far, `src/adapters/sqlite-history.ts`, sits behind
 * `HistoryStore`.
 */
export type { Clock, HistoryError, HistoryStore, ReadInput, StoreInput, StoreResult } from './types.js';
export { ASSERTION_KINDS, assertionsOf, assembleCompiledModel, type Assertion, type AssertionKind } from './assertions.js';
