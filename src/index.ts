/** madarch's public interface. */

export type { ModelError } from './model/errors.js';
export {
  ElementKind,
  Element,
  Interface,
  Relation,
  Category,
  Evidence,
  Binding,
  Transfer,
  TransferDirection,
  ModelFile,
  Zone,
  ZonesChange,
  Environment,
  EnvironmentZonesChange,
  State,
  DEFAULT_STATE_ID,
  type IntendedModel,
  type ValidatedModel,
} from './model/schema.js';
export { loadModel, parseModel, type LoadResult, type ModelSourceFile } from './model/load.js';
export {
  compileModel,
  serializeCompiledModel,
  SCHEMA_VERSION,
  type CompiledModel,
  type CompiledElement,
  type CompiledInterface,
  type CompiledRelation,
  type CompiledCategory,
  type CompiledZone,
  type CompiledEnvironment,
  type CompiledState,
} from './model/compile.js';
export {
  CompiledModel as CompiledModelSchema,
  CompiledElement as CompiledElementSchema,
  COMPILED_SCHEMA_VERSION,
} from './model/compiled-schema.js';
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
} from './history/types.js';
export { ASSERTION_KINDS, CLASHABLE_KINDS, SHARED_KINDS, isOneStateChain, type Assertion, type AssertionKind } from './history/assertions.js';
export { createSqliteHistory, type SqliteHistoryOptions } from './adapters/sqlite-history.js';

import type { CompiledModel } from './model/compile.js';
import { compileModel } from './model/compile.js';
import type { ModelError } from './model/errors.js';
import { loadModel } from './model/load.js';

export interface LoadAndCompileResult {
  model?: CompiledModel;
  errors: ModelError[];
}

/** Loads a repository's model and compiles it, or reports why it could not. */
export function loadAndCompileModel(repoRoot: string): LoadAndCompileResult {
  const { model, errors } = loadModel(repoRoot);
  if (errors.length > 0 || model === undefined) {
    return { errors };
  }
  return { model: compileModel(model), errors: [] };
}
