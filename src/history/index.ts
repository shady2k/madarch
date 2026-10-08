/**
 * The model-history capability's interface: keeping every version of every
 * source's compiled model, with both time axes, from the first write. This
 * module and `assertions.ts` touch no Bun-specific API; the only
 * implementation so far, `src/adapters/sqlite-history.ts`, sits behind
 * `HistoryStore`.
 *
 * The kinds the history keeps are `ASSERTION_KINDS` (see `assertions.ts`):
 * the compiled model's every top-level array — elements, interfaces,
 * relations, data entities, scenarios, categories, zones, environments and
 * states.
 */
export type {
  AssertionChange,
  AssertionRecord,
  AssertionsInput,
  Clock,
  Discrepancy,
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
  assembleSourceModel,
  environmentDefinitionWithoutBindings,
  isOneStateChain,
  type AlsoDefinedAs,
  type Assertion,
  type AssertionKind,
  type EnvironmentDefinition,
  type ReadEnvironment,
  type ReadModel,
  type SharedEntity,
} from './assertions.js';
