/** The model and history helpers the surviving tests share (the old src/index.ts surface, kept test-side). */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { compileModel } from '../src/model/compile.js';
import { CompiledModel as CompiledModelSchema, type CompiledModel, type CompiledElement, type CompiledEntity, type CompiledInterface, type CompiledRelation, type CompiledScenario, type CompiledState, type CompiledZone, type CompiledEnvironment } from '../src/model/compiled-schema.js';
import { parseModel, type LoadResult, type ModelSourceFile } from '../src/model/load.js';
import type { ModelError, ModelWarning } from '../src/model/errors.js';
import type { PositionedModel } from '../src/model/validate.js';
import type { ValidatedModel } from '../src/model/schema.js';
import type { AssertionChange, Clock, HistoryStore } from '../src/history-types.js';
import { CLASHABLE_KINDS, type ReadModel } from '../src/history-assertions.js';
import { startServer, type StartedServer } from '../src/server/http.js';

export { CompiledModelSchema, compileModel, parseModel, startServer, CLASHABLE_KINDS };
export type { AssertionChange, Clock, CompiledElement, CompiledEntity, CompiledInterface, CompiledModel, CompiledRelation, CompiledScenario, CompiledState, CompiledZone, CompiledEnvironment, HistoryStore, ReadModel, StartedServer, ValidatedModel };

/** Every kind of assertion a source may make (the shape `src/history/assertions.ts` keeps for itself). */
export const ASSERTION_KINDS = ['element', 'interface', 'relation', 'entity', 'scenario', 'category', 'zone', 'environment', 'state'] as const;
export type AssertionKind = (typeof ASSERTION_KINDS)[number];

/** The model of a repository, compiled, or the errors that refused it. */
export interface LoadAndCompileResult {
  model?: CompiledModel;
  errors: ModelError[];
  warnings: ModelWarning[];
  positions?: PositionedModel;
}

export function loadAndCompileModel(repoRoot: string): LoadAndCompileResult {
  const { model, errors, warnings, positions } = loadModel(repoRoot);
  if (errors.length > 0 || model === undefined) return { errors, warnings };
  return { model: compileModel(model), errors: [], warnings, positions };
}

/** Reads a repository's `madarch/*.yaml` (the shape `src/model/load.ts` keeps for itself). */
function loadModel(repoRoot: string): LoadResult {
  const madarchDir = join(repoRoot, 'madarch');
  let entries: string[];
  try {
    entries = readdirSync(madarchDir);
  } catch {
    return { errors: [{ file: 'madarch', line: 1, path: '', message: 'the madarch folder was not found' }], warnings: [] };
  }
  const errors: ModelError[] = [];
  const yamlNames = entries.filter((name) => name.endsWith('.yaml')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of entries.filter((entry) => entry.endsWith('.yml')).sort()) {
    errors.push({ file: relative(repoRoot, join(madarchDir, name)), line: 1, path: '', message: `"${name}" uses the ".yml" extension; madarch only reads "*.yaml" files, so it is ignored — rename it to ".yaml"` });
  }
  if (yamlNames.length === 0) {
    errors.push({ file: 'madarch', line: 1, path: '', message: 'the madarch folder has no *.yaml files: a model needs at least one' });
    return { errors, warnings: [] };
  }
  const files: ModelSourceFile[] = [];
  for (const name of yamlNames) {
    const filePath = join(madarchDir, name);
    const relativeFile = relative(repoRoot, filePath);
    try {
      files.push({ path: relativeFile, text: readFileSync(filePath, 'utf8') });
    } catch (error) {
      errors.push({ file: relativeFile, line: 1, path: '', message: `could not be read as a file: ${(error as Error).message}` });
    }
  }
  const parsed = parseModel(files);
  errors.push(...parsed.errors);
  if (errors.length > 0 || parsed.model === undefined) return { errors, warnings: parsed.warnings };
  return { model: parsed.model, errors: [], warnings: parsed.warnings, positions: parsed.positions };
}

/** The compiled model's canonical text (the shape `src/model/compile.ts` keeps for itself). */
export function serializeCompiledModel(model: CompiledModel): string {
  return `${JSON.stringify(model, null, 2)}\n`;
}

/** The kinds two sources may share: their definitions union rather than clash. */
export const SHARED_KINDS: readonly AssertionKind[] = ['category', 'zone', 'environment', 'state'];

/** Whether states form exactly one chain (the shape `src/history/assertions.ts` keeps for itself). */
export function isOneStateChain(states: readonly { id: string; after?: string }[]): boolean {
  if (states.length <= 1) return true;
  const followers = new Map<string, string>();
  let roots = 0;
  for (const state of states) {
    if (state.after === undefined) roots++;
    else followers.set(state.after, state.id);
  }
  if (roots !== 1) return false;
  const root = states.find((state) => state.after === undefined)!;
  const visited = new Set<string>([root.id]);
  let current = root.id;
  while (followers.has(current)) {
    const next = followers.get(current)!;
    if (visited.has(next)) return false;
    visited.add(next);
    current = next;
  }
  return visited.size === states.length;
}
