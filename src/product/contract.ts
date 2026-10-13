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
import { KindsRegistry, type EvidenceFields, type GoalLevel, type StorageForm, type QuestionForm, type OverviewSources } from './schema.js';
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
  /**
   * The contract version the refusal names, when the refusal is about the
   * version itself (a version this madarch does not know): the wiki names
   * it in the banner it serves instead of the registry.
   */
  version?: number;
}

/** One link field a kind's documents may carry, as the registry declares it. */
export interface RegistryLink {
  /** The form field's name the documents of the kind write the link under, like `Serves`. */
  field: string;
  /** The kinds the field's link may name, by the kinds' own names. */
  targets: readonly string[];
  /** The label the linked page shows its backlinks under; `undefined`, the wiki words the backlink generically. */
  backlink?: string;
  /** Whether the field names one document or many: `many` where the registry left it out. */
  cardinality: 'one' | 'many';
  /** Whether a document of the kind must carry the link at all. */
  required: boolean;
}

/** One document kind as a registry names it, at the place its fields stand. */
/**
 * One reservation the engine names instead of dropping: what contract v1
 * reserves (the 0021 amendment) beside what this engine version implements,
 * at the field line it stands on.
 */
export interface ReservationFinding {
  file: string;
  line: number;
  path: string;
  message: string;
}

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
  /** The statuses a document of the kind may carry in its `Status` field; where the kind names none, no status is judged. */
  statuses?: readonly string[];
  /** The link fields the kind's documents may carry, each naming its target kinds; where the kind names none, it carries no links. */
  links?: readonly RegistryLink[];
  /**
   * The storage form the kind is kept in (the 0021 amendment, the owner's
   * refinement of 2026-10-12 ~22:15 MSK); `document` stands where it is
   * left out. A form this engine version does not implement is kept in the
   * declaration and named by a reservation finding, never dropped.
   */
  storage?: StorageForm;
  /**
   * The field names the kind's fact carries its evidence in, reserved for
   * the `fact` storage form: the source system, the ref or commit, the
   * record id. The fact's truth stays with the system it came from,
   * read-only in the wiki.
   */
  evidence?: EvidenceFields;
  questions?: QuestionForm;
}

/** One stage of the registry's stage list, in the list's own order. */
export interface RegistryStage {
  id: string;
  name?: string;
  expected?: readonly string[];
}

/** What reading a registry file gave: the contract version it declares, the kinds and the stages of the file, or the refusals. */
export type RegistryRead =
  | { ok: true; contract: number; kinds: RegistryKind[]; stages: RegistryStage[]; goals?: GoalLevel[]; overview?: OverviewSources; reservations: ReservationFinding[] }
  | { ok: false; errors: ContractError[] };


/**
 * The contract versions this madarch reads (contract v1, the owner's
 * refinement of 0021, 2026-10-12). The registry file carries the version
 * in its `contract` field and the published schema carries it in its
 * `$id`; moving either side to a new version is a deliberate change on
 * each side, never a silent reinterpretation.
 */
export const KNOWN_CONTRACT_VERSIONS: readonly number[] = [1];

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

/**
 * What a kind's folder is refused for, or `undefined` when the folder is a
 * plain place under `docs/`: it starts `docs/`, climbs no segment (`..`) and
 * holds no absolute or empty leg, so a value like `docs/../../outside`
 * cannot name a place outside the documents.
 */
function folderProblemOf(folder: string): string | undefined {
  if (!folder.startsWith(DOCS_PREFIX)) return `"${folder}" is not a place under the documents: a kind lives inside docs/`;
  const legs = folder.slice(DOCS_PREFIX.length).split('/');
  for (const leg of legs) {
    if (leg === '..') return `"${folder}" climbs out of the documents: a kind lives inside docs/`;
    if (leg === '') return `"${folder}" holds an empty segment: a kind lives inside docs/`;
  }
  return undefined;
}

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

  // The contract version gate: the version is the registry's own word
  // (contract v1 carries `contract: 1`). A file that is no mapping at all
  // is the schema's refusal (`must be object`), so no version is asked of
  // it here; a mapping that names a version this madarch does not know is
  // refused for the version it names — the wiki serves such a product
  // with plain pages under these words, never failing silently.
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const carried = (value as Record<string, unknown>)['contract'];
    if (typeof carried !== 'number' || !Number.isInteger(carried)) {
      errors.push({
        file,
        line: lineForPath(doc, lineCounter, ['contract']),
        path: 'contract',
        message: carried === undefined
          ? 'the registry carries no contract version: write "contract: 1" on the file'
          : `${JSON.stringify(carried)} is not a contract version: the version is a whole number`,
      });
      return { ok: false, errors };
    }
    if (!KNOWN_CONTRACT_VERSIONS.includes(carried)) {
      errors.push({
        file,
        line: lineForPath(doc, lineCounter, ['contract']),
        path: 'contract',
        version: carried,
        message: `the registry declares contract ${carried}; this madarch reads contract ${KNOWN_CONTRACT_VERSIONS.join(' and ')}`,
      });
      return { ok: false, errors };
    }
  }

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

  const parsed = value as { contract: number; stages: RegistryStage[]; kinds: RegistryKind[]; goals?: GoalLevel[]; overview?: OverviewSources };
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
  // A link's target may name a kind declared later in the file, so the
  // names are collected before the kinds are judged one by one.
  const kindNames = new Set<string>(parsed.kinds.map((kind) => kind.name));
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
    const folderProblem = folderProblemOf(kind.folder);
    if (folderProblem !== undefined) {
      errors.push({
        file,
        line: lines.at(['kinds', index, 'folder']),
        path: `kinds[${index}].folder`,
        message: folderProblem,
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
    // The kind's allowed statuses: names, each given once (their case does
    // not make two statuses of one).
    const seenStatuses = new Set<string>();
    for (const [statusIndex, status] of (kind.statuses ?? []).entries()) {
      const key = status.toLowerCase();
      if (seenStatuses.has(key)) {
        errors.push({
          file,
          line: lines.at(['kinds', index, 'statuses', statusIndex]),
          path: `kinds[${index}].statuses[${statusIndex}]`,
          message: `the status "${status}" is named twice: each allowed status is given once`,
        });
      }
      seenStatuses.add(key);
    }
    // The kind's declared links: one field a time, each target naming a kind
    // of the registry, the reader's words standing at the line they are on.
    // A link field is never named as one of the generic fields madarch reads
    // itself (decision 0021, the contract-v1 amendment): the documents' id,
    // kind, status and links are the engine's own words, and a link field
    // spelled as one of them — the case does not make it another field —
    // would be read twice by different halves of the engine.
    const seenLinkFields = new Map<string, number>();
    for (const [linkIndex, link] of (kind.links ?? []).entries()) {
      const key = link.field.toLowerCase();
      const generic = DOCUMENT_FIELD_NAMES.find((carry) => carry.toLowerCase() === key);
      if (generic !== undefined) {
        errors.push({
          file,
          line: lines.at(['kinds', index, 'links', linkIndex, 'field']),
          path: `kinds[${index}].links[${linkIndex}].field`,
          message: `"${link.field}" is one of the generic fields madarch reads itself (${DOCUMENT_FIELD_NAMES.join(', ')}): a kind declares one link a field of its own, never one of these`,
        });
      }
      const first = seenLinkFields.get(key);
      if (first !== undefined) {
        errors.push({
          file,
          line: lines.at(['kinds', index, 'links', linkIndex, 'field']),
          path: `kinds[${index}].links[${linkIndex}].field`,
          message: `the field "${link.field}" is declared twice, first on line ${first}: a kind declares one link a field`,
        });
      } else {
        seenLinkFields.set(key, lines.at(['kinds', index, 'links', linkIndex, 'field']));
      }
      for (const [targetIndex, target] of link.targets.entries()) {
        if (kindNames.has(target)) continue;
        errors.push({
          file,
          line: lines.at(['kinds', index, 'links', linkIndex, 'targets', targetIndex]),
          path: `kinds[${index}].links[${linkIndex}].targets[${targetIndex}]`,
          message: `"${target}" names no kind of the registry: a link goes to a kind the registry declares`,
        });
      }
    }
  });

  // The stage list is never empty from the schema; a registry that carries
  // kinds but no stage list at all is the schema's refusal, not this one's.
  // The evidence shape rides the fact storage form (the 0021 amendment):
  // a kind carrying its evidence field names declares how it is stored first.
  parsed.kinds.forEach((kind, index) => {
    if (kind.evidence !== undefined && (kind.storage ?? 'document') !== 'fact') {
      errors.push({
        file,
        line: lines.at(['kinds', index, 'evidence']),
        path: `kinds[${index}].evidence`,
        message: 'the evidence shape rides the fact storage form: a kind carrying its evidence fields declares "storage: fact"',
      });
    }
  });
  if (errors.length > 0) return { ok: false, errors };

  // The reservations the engine keeps on contract v1 (the 0021 amendment):
  // a kind stored in a form this engine version does not implement, an
  // imported fact's evidence shape beside the authored documents, and the
  // goals section the wiki does not compute. Each is a named finding for
  // the serving side, never a refusal and never a drop.
  const reservations: ReservationFinding[] = [];
  parsed.kinds.forEach((kind, index) => {
    const form = kind.storage ?? 'document';
    if (form === 'document') return;
    reservations.push({
      file,
      line: lines.at(['kinds', index, 'storage']),
      path: `kinds[${index}].storage`,
      message: `the kind "${kind.name}" declares the storage form "${form}"; this engine version serves documents only — the kind and its records are kept and named, never dropped`,
    });
    if (kind.evidence !== undefined) {
      reservations.push({
        file,
        line: lines.at(['kinds', index, 'evidence']),
        path: `kinds[${index}].evidence`,
        message: `the kind "${kind.name}" carries its evidence (source, ref, record); this engine version does not read imported graphs — the shape is kept as data, never dropped`,
      });
    }
  });
  if (parsed.goals !== undefined) {
    reservations.push({
      file,
      line: lines.at(['goals']),
      path: 'goals',
      message: 'the manifest carries the reserved goals section; this engine version does not compute maturity levels — the section is kept as data, never dropped',
    });
  }
  return { ok: true, contract: parsed.contract, kinds: parsed.kinds as RegistryKind[], stages: parsed.stages, goals: parsed.goals, overview: parsed.overview, reservations };
}


/** The generic field names a document may carry (decision 0021). */
const DOCUMENT_FIELD_NAMES = ['id', 'kind', 'status', 'links'] as const;

/** How one document's generic fields read: the fields, or the refusals. */
export type DocumentFieldsRead =
  | { ok: true; fields: DocumentFields }
  | { ok: false; errors: ContractError[] };

/**
 * Reads one document's generic fields from its Markdown: the block above
 * the first `## ` heading, outside code spans (a heading with `#` starting
 * the line never carries a field), one field a line as `Name: value`. The four generic names are read; an unknown name is ignored, the
 * way a manifest grows by fields a later version adds. Refusals name the
 * file, the line and the field the problem stands on.
 */
export function parseDocumentFields(file: string, markdown: string): DocumentFieldsRead {
  const errors: ContractError[] = [];
  const fields: DocumentFields = {};
  let sectionOpened = false;
  markdown.replace(/\r\n/g, '\n').split('\n').forEach((raw, index) => {
    const line = index + 1;
    if (typeof raw !== 'string') return;
    if (index > 0 && raw.match(/^#/)) sectionOpened = true;
    if (sectionOpened || raw.trim() === '' || raw.trimStart().startsWith('#')) return;
    const field = raw.match(/^([A-Za-z][A-Za-z0-9 ]*?):\s*(.*)$/);
    if (field === null) return;
    const name = field[1]!;
    const value = field[2]!.trim();
    if (value === '') return;
    const generic = DOCUMENT_FIELD_NAMES.find((carry) => carry.toLowerCase() === name.toLowerCase());
    if (generic === undefined) return;
    if (generic === 'links') {
      const links = value.split(',').map((part) => part.trim()).filter((part) => part !== '');
      if (links.length === 0) {
        errors.push({ file, line, path: 'links', message: `"${value}" names no link target: links is a list of ids, comma-separated` });
        return;
      }
      if (fields.links === undefined) fields.links = [];
      fields.links!.push(...links);
      return;
    }
    if (fields[generic] !== undefined) {
      errors.push({ file, line, path: generic, message: `"${name}" is written twice: a field is given once` });
      return;
    }
    if (generic === 'kind' || generic === 'status') {
      // A plain word: the sharp shapes of each are the registry's own forms' business.
      const word = value.match(/^[A-Za-z][A-Za-z0-9 _-]*$/);
      if (word === null) {
        errors.push({ file, line, path: generic, message: `"${name}: ${value}" is not a word: write a name the reader recognises` });
        return;
      }
    }
    fields[generic] = value;
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, fields };
}
