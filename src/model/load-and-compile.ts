import type { CompiledModel } from './compile.js';
import { compileModel } from './compile.js';
import type { ModelError, ModelWarning } from './errors.js';
import { loadModel } from './load.js';
import type { PositionedModel } from './validate.js';

export interface LoadAndCompileResult {
  model?: CompiledModel;
  errors: ModelError[];
  /** Problems that do not refuse the model, exactly as `loadModel` returns them. */
  warnings: ModelWarning[];
  /** Where every element, interface and relation was declared; present and complete only when the model was accepted. */
  positions?: PositionedModel;
}

/** Loads a repository's model and compiles it, or reports why it could not; warnings come back either way. */
export function loadAndCompileModel(repoRoot: string): LoadAndCompileResult {
  const { model, errors, warnings, positions } = loadModel(repoRoot);
  if (errors.length > 0 || model === undefined) {
    return { errors, warnings };
  }
  return { model: compileModel(model), errors: [], warnings, positions };
}
