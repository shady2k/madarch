/**
 * The model-history capability's interface: keeping every version of every
 * source's compiled model, with both time axes, from the first write. This
 * module and `assertions.ts` touch no Bun-specific API; the only
 * implementation so far, `src/adapters/sqlite-history.ts`, sits behind
 * `HistoryStore`.
 */
export type {
  AssertionChange,
  AssertionRecord,
  AssertionsInput,
  Clock,
  HistoryError,
  HistoryStore,
  ReadInput,
  ReadResult,
  StoreInput,
  StoreResult,
} from './types.js';
export {
  ASSERTION_KINDS,
  CLASHABLE_KINDS,
  SHARED_KINDS,
  assertionsOf,
  assembleCompiledModel,
  environmentDefinitionWithoutBindings,
  isOneStateChain,
  type Assertion,
  type AssertionKind,
} from './assertions.js';
