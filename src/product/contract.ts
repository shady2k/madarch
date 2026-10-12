/**
 * The contract of a product repository's kinds registry and stage list
 * (decision 0021, outcome 1 of the standalone charter): the reading half of
 * the registry the skill set writes at setup. What a registry file must name
 * per kind (its name, its id prefix, the folder the kind lives in, the stage
 * it belongs to and a next-step hint) and the stages as an ordered list, is
 * the schema's (`src/product/schema.ts`); this module adds the checks the
 * schema alone cannot carry — the prefix formatting, the folder being under
 * `docs/`, the stage naming a stage of the list, the hint's non-emptiness —
 * each refusal at the file and line the field stands on.
 *
 * Refusals are values, named the way this project names them: the file
 * relative to the product folder, the 1-based line, the field's path from
 * the registry's top and the words the reader prints. Nothing writes and
 * nothing reads the clock.
 */
import { LineCounter, parseDocument } from 'yaml';
import { Value } from 'typebox/value';
import { KindsRegistry } from './schema.js';
import { checkStrictYaml } from '../model/strict-yaml.js';
import { jsonPointerToSegments, lineForPath, segmentsToPath } from '../model/yaml-position.js';

/** One problem found in a registry or stages file, named where it stands. */
export interface ContractError {
  /** Path of the file relative to the product folder. */
  file: string;
  /** 1-based line in that file. */
  line: number;
  /** Path from the file's top, like `kinds[0].prefix`. Empty for whole-file problems. */
  path: string;
  message: string;
}

/** One document kind as a registry names it, at the place its fields stand. */
export interface RegistryKind {
  name: string;
  /** The document's id prefix, like `FR`. */
  prefix: string;
  /** The folder or file under the product the kind lives in, `docs/…`, like `docs/requirements`. */
  folder: string;
  /** The stage this kind belongs to: one of the stage list's stages. */
  stage: string;
  /** The next-step hint the wiki shows where the stage holds nothing of the kind. */
  hint: string;
}

/** One stage of the registry's stage list, in the list's own order. */
export interface RegistryStage {
  id: string;
  name?: string;
}

/** What reading a registry file gave: the kinds and the stages of the file, or the refusals. */
export type RegistryRead =
  | { ok: true; kinds: RegistryKind[]; stages: RegistryStage[] }
  | { ok: false; errors: ContractError[] };

/** A document's generic fields, as a document may carry them for madarch. */
export interface DocumentFields {
  id?: string;
  kind?: string;
  status?: string;
  links?: string[];
}

/** The folder prefix every kind folder must carry. */
const DOCS_PREFIX = 'docs/';

/** The id-prefix shape a registry's prefix carries: two to four capitals A-Z. */
const PREFIX_PATTERN = /^[A-Z]{1,4}$/;

/** Reads one kinds registry file's text: strict YAML, the schema, then the fields' own checks. */
export function parseContractText(file: string, text: string): RegistryRead {
  const errors: ContractError[] = [];

  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, keepSourceTokens: true, merge: false, uniqueKeys: false });
  const strictErrors = checkStrictYaml(doc, lineCounter, file, text);
  errors.push(...strictErrors);
  if (doc.errors.length > 0 || strictErrors.length > 0) {
    for (const parseError of doc.errors) {
      errors.push({ file, line: lineCounter.linePos(parseError.pos[0]).line, path: '', message: parseError.message });
    }
    return { ok: false, errors };
  }

  const value: unknown = doc.toJS();
  const schemaErrors = Value.Errors(KindsRegistry, value)
    .map((schemaError) => ({
      file,
      line: lineForPath(doc, lineCounter, jsonPointerToSegments(schemaError.instancePath)),
      path: segmentsToPath(jsonPointerToSegments(schemaError.instancePath)),
      message: schemaError.message,
    }));
  for (const schemaError of schemaErrors) {
    errors.push({ ...schemaError, file, message: schemaError.message });
  }
  if (schemaErrors.length > 0) return { ok: false, errors };

  const parsed = value as { stages: RegistryStage[]; kinds: RegistryKind[] };
  const lines = {
    at: (segments: (string | number)[]) => lineForPath(doc, lineCounter, segments),
  };

  // The stages: unique ids at the shape the schema already carries.
  const seenStages = new Map<string, number>();
  parsed.stages.forEach((stage, index) => {
    const first = seenStages.get(stage.id);
    if (first !== undefined) {
      errors.push({
        file,
        line: lines.at(['stages', index, 'id']),
        path: `stages[${index}].id`,
        message: `the stage "${stage.id}" is named twice, first on line ${first}: each stage is given once`,
      });
    } else {
      seenStages.set(stage.id, lines.at(['stages', index, 'id']));
    }
  });

  // The kinds: every field the check owns, each on the line it was written.
  const seenPrefixes = new Map<string, number>();
  parsed.kinds.forEach((kind, index) => {
    if (!PREFIX_PATTERN.test(kind.prefix)) {
      errors.push({
        file,
        line: lines.at(['kinds', index, 'prefix']),
        path: `kinds[${index}].prefix`,
        message: `"${kind.prefix}" is not an id prefix: one to four capitals (A-Z)`,
      });
    }
    const first = seenPrefixes.get(kind.prefix);
    if (first !== undefined) {
      errors.push({
        file,
        line: lines.at(['kinds', index, 'prefix']),
        path: `kinds[${index}].prefix`,
        message: `the id prefix "${kind.prefix}" is named twice, first on line ${first}: each kind is given one prefix`,
      });
    } else {
      seenPrefixes.set(kind.prefix, lines.at(['kinds', index, 'prefix']));
    }
    if (!kind.folder.startsWith(DOCS_PREFIX)) {
      errors.push({
        file,
        line: lines.at(['kinds', index, 'folder']),
        path: `kinds[${index}].folder`,
        message: `"${kind.folder}" is not a place under the documents: a kind lives inside docs/`,
      });
    }
    if (!seenStages.has(kind.stage)) {
      errors.push({
        file,
        line: lines.at(['kinds', index, 'stage']),
        path: `kinds[${index}].stage`,
        message: `"${kind.stage}" is not a stage of the list the registry names`,
      });
    }
    if (kind.hint.trim() === '') {
      errors.push({
        file,
        line: lines.at(['kinds', index, 'hint']),
        path: `kinds[${index}].hint`,
        message: 'the hint is empty: a reader stands where no word is',
      });
    }
  });

  // The stage list is never empty from the schema; a registry that carries
  // kinds but no stage list at all is the schema's refusal, not this one's.
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, kinds: parsed.kinds ?? [], stages: parsed.stages };
}
