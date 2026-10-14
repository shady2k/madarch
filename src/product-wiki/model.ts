/**
 * The product's architecture model, read for the wiki (feature E,
 * madarch-iuc.15): the product's own model in the product repository's
 * `model/` folder (the same `*.yaml` files the loader reads from
 * `madarch/`, at the folder the product program lays out) merged with each
 * declared code repository's own `madarch/` model under `repos/`.
 *
 * The merge rule: the product's model is the spine — its own files first,
 * in file-name order, then each repository's files in the manifest's
 * repository order, each repository's files in file-name order. The loader
 * (`parseModel`) already concatenates sections across files and refuses
 * duplicate ids, so a product element and a repository element with one id
 * is a named compile error, never a silent override; a repository file may
 * refine what the product declared (a `refines` relation, a child
 * element), which is the set's own refinement rule. The model is read
 * fresh on every ask — the same live rule the wiki's pages follow.
 *
 * Two kinds of problem, never a silent smaller result:
 * - `errors` — the model does not compile; each names file, line and path.
 * - `notes` — the wiki still shows a model, but from less than the whole
 *   input: a declared repository with no checkout, a model file that could
 *   not be read. Each names what is missing, at its place.
 *
 * Determinism: a merged model renders at the fixed moment
 * (`NO_REPO_TIME`), never the clock.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseModel, type LoadResult, type ModelSourceFile } from '../model/load.js';
import { compileModel } from '../model/compile.js';
import type { ProductIdentity } from '../product/manifest.js';

/** The product's own model folder, at the product repository's root. */
export const PRODUCT_MODEL_FOLDER = 'model';

/** The folder of a code repository's own model, within the repository. */
export const REPO_MODEL_FOLDER = 'madarch';

/** The fixed moment a merged model renders at (src/wiki/build.ts's rule). */
export const NO_REPO_TIME = Date.UTC(2026, 0, 1);

/** One problem, named where it was found. */
export interface ModelProblem {
  readonly file: string;
  readonly line: number;
  readonly path: string;
  readonly message: string;
}

export interface ProductModelResult {
  /** The merged compiled model; present only when every file parsed and compiled. */
  readonly model?: ReturnType<typeof compileModel>;
  /** The compile's own errors; empty when the model compiled. */
  readonly errors: readonly ModelProblem[];
  /** What the shown model was built from less than the whole input, each named at its place. */
  readonly notes: readonly ModelProblem[];
  /** The loader's warnings, when the model compiled. */
  readonly warnings: readonly ModelProblem[];
  /** The folders read, in reading order. */
  readonly sources: readonly string[];
}

/**
 * The raw bytes of every model source, digested: the freshness key the
 * wiki's revision rides (feature E) — a saved model file changes the
 * digest, so the wiki's stream reports a change and the section is asked
 * again, exactly like a saved document. The bytes only: no parse, no
 * compile — this runs at every pages ask.
 */
export function modelSourceDigest(product: Pick<ProductIdentity, 'folder' | 'repos'>): string {
  const hash = createHash('sha256');
  const digestFolder = (prefix: string, folder: string): void => {
    for (const name of yamlFiles(folder)) {
      const path = prefix + name;
      try {
        hash.update(`${path}\u0000`);
        hash.update(readFileSync(join(folder, name)));
        hash.update('\u0000');
      } catch {
        hash.update(`${path}\u0000unreadable\u0000`);
      }
    }
  };
  digestFolder(`${PRODUCT_MODEL_FOLDER}/`, join(product.folder, PRODUCT_MODEL_FOLDER));
  for (const repo of product.repos) {
    digestFolder(`repos/${repo.name}/${REPO_MODEL_FOLDER}/`, join(product.folder, 'repos', repo.name, REPO_MODEL_FOLDER));
  }
  return hash.digest('hex');
}

/** Lists a folder's `*.yaml` files in name order; `[]` when the folder is absent. */
function yamlFiles(folder: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(folder);
  } catch {
    return [];
  }
  return entries.filter((name) => name.endsWith('.yaml')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Reads one file, or reports why it could not. */
function readAt(path: string): { text?: string; message?: string } {
  try {
    if (!statSync(path).isFile()) return { message: `${path} is not a file: the model reads *.yaml files` };
    return { text: readFileSync(path, 'utf8') };
  } catch (error) {
    return { message: `${path} could not be read: ${(error as Error).message}` };
  }
}

/**
 * Reads every `*.yaml` file of one model folder, named as `prefix + name`
 * in errors and notes. An unreadable file is a note (the model renders
 * from the rest, the note names the file); a `.yml` beside it is named the
 * way the loader names one.
 */
function readFolder(prefix: string, folder: string, into: ModelSourceFile[], notes: ModelProblem[]): void {
  for (const name of yamlFiles(folder)) {
    const path = prefix + name;
    const read = readAt(join(folder, name));
    if (read.text === undefined) {
      notes.push({ file: path, line: 1, path: '', message: read.message ?? `${path} could not be read` });
      continue;
    }
    into.push({ path, text: read.text });
  }
}

/**
 * Reads the product's merged model: `model/` of the product repository,
 * then `madarch/` of every repository the manifest declares that is checked
 * out under `repos/`. A declared repository with no checkout is a note, and
 * a repository with no `madarch/` folder contributes nothing — the set's
 * skill writes one, and until then the product's model stands alone.
 */
export function readProductModel(product: Pick<ProductIdentity, 'folder' | 'repos'>): ProductModelResult {
  const errors: ModelProblem[] = [];
  const notes: ModelProblem[] = [];
  const warnings: ModelProblem[] = [];
  const files: ModelSourceFile[] = [];
  const sources: string[] = [];

  readFolder(`${PRODUCT_MODEL_FOLDER}/`, join(product.folder, PRODUCT_MODEL_FOLDER), files, notes);
  sources.push(PRODUCT_MODEL_FOLDER);

  for (const repo of product.repos) {
    const repoFolder = join(product.folder, 'repos', repo.name);
    const modelFolder = join(repoFolder, REPO_MODEL_FOLDER);
    let held = false;
    try {
      held = statSync(modelFolder).isDirectory();
    } catch {
      held = false;
    }
    if (!held) {
      let checked = false;
      try {
        checked = statSync(repoFolder).isDirectory();
      } catch {
        checked = false;
      }
      if (checked) continue; // checked out, no model yet: nothing to read
      notes.push({
        file: `repos/${repo.name}`,
        line: 1,
        path: '',
        message: `the repository "${repo.name}" is declared in the manifest but is not checked out at ${repoFolder}: its model (if any) is not in the wiki`,
      });
      continue;
    }
    readFolder(`repos/${repo.name}/${REPO_MODEL_FOLDER}/`, modelFolder, files, notes);
    sources.push(`repos/${repo.name}/${REPO_MODEL_FOLDER}`);
  }

  if (files.length === 0) {
    return {
      errors: [{
        file: PRODUCT_MODEL_FOLDER,
        line: 1,
        path: '',
        message: `no model: ${PRODUCT_MODEL_FOLDER}/ holds no *.yaml file and no repository's madarch/ holds one`,
      }],
      notes,
      warnings,
      sources,
    };
  }

  const loaded: LoadResult = parseModel(files);
  for (const error of loaded.errors) errors.push(error);
  for (const warning of loaded.warnings) warnings.push(warning);
  if (loaded.model === undefined) return { errors, notes, warnings, sources };
  const compiled = compileModel(loaded.model);
  return { model: compiled, errors: [], notes, warnings, sources };
}
