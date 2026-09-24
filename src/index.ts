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
  type IntendedModel,
} from './model/schema.js';
export { loadModel, type LoadResult } from './model/load.js';
export {
  compileModel,
  SCHEMA_VERSION,
  type CompiledModel,
  type CompiledElement,
  type CompiledInterface,
  type CompiledRelation,
  type CompiledCategory,
} from './model/compile.js';

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
