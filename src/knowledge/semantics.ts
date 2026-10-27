/**
 * What a passage of a document means (madarch-ztyq.3, decision 0032 section 4).
 *
 * A document's sections are classified in three passes, in this order:
 * (a) explicit metadata and the manifest's conventions (`kinds.yaml`, front
 * matter); (b) deterministic structure (heading ancestry, list nesting); (c) a
 * classifier that reads what is left and names what each passage means. This
 * module holds the vocabulary of the third pass and the interface the host
 * fills: the production host answers it from jev and the agent, and every
 * committed test answers it with `fakeClassifier()`, which is deterministic.
 *
 * A passage that holds several meanings is split by the classifier: it answers
 * one reading per passage, each with its own lines, and the section's own text
 * stays as the document writes it. A reading is a proposal: `other` says the
 * classifier found no general kind, and no answer at all says the classifier
 * has not read the passage yet, which the caller reports rather than drops.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { sha256Hex } from '../graph/digest.js';
import { byCodePoint } from '../model/order.js';
import type { Finding } from './kinds.js';

/** The general kinds a passage of a document can be. */
export type SemanticKind = 'scenario' | 'actor' | 'rule' | 'quality' | 'decision' | 'procedure' | 'term' | 'other';

/** Every general kind, in the order the decision names them. */
export const SEMANTIC_KINDS: readonly SemanticKind[] = ['scenario', 'actor', 'rule', 'quality', 'decision', 'procedure', 'term', 'other'];

/** Whether a text names a general kind. */
export function isSemanticKind(value: string): value is SemanticKind {
  return (SEMANTIC_KINDS as readonly string[]).includes(value);
}

/** One block of a section, as the classifier is shown it: a list item or a paragraph. */
export interface PassageBlock {
  /** The 1-based line the block starts at, and the last line it covers. */
  readonly line: number;
  readonly endLine: number;
  /** The block's text as the document writes it, its list mark and indentation aside. */
  readonly text: string;
}

/** A section as the classifier is asked about it. */
export interface PassageRequest {
  /** The repository the document belongs to; null for the product repository. */
  readonly repo: string | null;
  readonly path: string;
  /** The heading texts that enclose the section, from the document's first heading down to it. */
  readonly headingPath: readonly string[];
  /** The section's text, and the lines it covers. */
  readonly text: string;
  readonly line: number;
  readonly endLine: number;
  /** The blocks the section is made of, in document order, so a classifier may split it. */
  readonly blocks: readonly PassageBlock[];
}

/** One meaning a classifier read in a section: what it is, where it stands and the text it holds. */
export interface PassageReading {
  readonly kind: SemanticKind;
  readonly text: string;
  readonly line: number;
  readonly endLine: number;
}

/**
 * The typed classifier of the third pass. The production host fills it from jev
 * and the agent; the tests fill it from `fakeClassifier()`.
 */
export interface SemanticClassifier {
  /** The meanings of the section, in document order; an empty answer says the classifier has not read it. */
  classify(request: PassageRequest): readonly PassageReading[];
}

/** What a deterministic classifier answers per heading: one general kind for the whole section, or one per block. */
export type FakeAnswers = Readonly<Record<string, SemanticKind | readonly SemanticKind[]>>;

/**
 * A deterministic classifier: it answers from a table of heading text to
 * general kind, one kind for every block of the section, in order (the last
 * kind named covers the blocks left). A heading the table does not name is not
 * read, so nothing is invented. Every committed test uses this one, and no test
 * runs a model.
 */
export function fakeClassifier(answers: FakeAnswers): SemanticClassifier {
  const table = new Map<string, readonly SemanticKind[]>();
  for (const [heading, answer] of Object.entries(answers)) table.set(normaliseHeading(heading), typeof answer === 'string' ? [answer] : [...answer]);
  return {
    classify(request: PassageRequest): readonly PassageReading[] {
      const heading = normaliseHeading(request.headingPath[request.headingPath.length - 1] ?? '');
      const kinds = table.get(heading);
      if (kinds === undefined || kinds.length === 0) return [];
      if (request.blocks.length === 0) return [{ kind: kinds[0]!, text: request.text, line: request.line, endLine: request.endLine }];
      return request.blocks.map((block, index) => ({
        kind: kinds[Math.min(index, kinds.length - 1)]!,
        text: block.text,
        line: block.line,
        endLine: block.endLine,
      }));
    },
  };
}

/** The key an answer is kept under: the document, its headings and the section's text, so an edited section is asked again. */
export function classificationKey(request: Pick<PassageRequest, 'repo' | 'path' | 'headingPath' | 'text'>): string {
  return sha256Hex(new TextEncoder().encode([request.repo ?? '', request.path, request.headingPath.join('\u0000'), request.text].join('\u0001'))).slice(0, 32);
}

/**
 * One reading as the product's store keeps it: its general kind, its text, and the lines it covers counted from the
 * section's own first line (`start: 0` is that line). Absolute lines are a property of one read of one document, not of
 * a meaning: a paragraph inserted above an unchanged section moves every line of it, and a reading stored by absolute
 * line would then name the wrong passage (madarch-ztyq.3, the review of finding 6). The section's text is part of the
 * key, so an edited section is asked again and its relative ranges are read against the section as it stands now.
 */
export interface StoredReading {
  readonly kind: SemanticKind;
  readonly text: string;
  /** The passage's first line and last line, counted from 0 at the section's first line. */
  readonly start: number;
  readonly end: number;
}

/** The readings of one read, as the store keeps them: absolute lines counted back to the section's first line. */
export function relativeReadings(readings: readonly PassageReading[], sectionLine: number): StoredReading[] {
  return readings.map((reading) => ({ kind: reading.kind, text: reading.text, start: reading.line - sectionLine, end: reading.endLine - sectionLine }));
}

/**
 * A classifier that answers from readings already kept: what jev and the agent read, filled by the host. It rebases the
 * reading's relative range onto the section as the document has it now, so an insertion before the section moves the
 * readings with it instead of losing them.
 */
export function storedClassifier(answers: ReadonlyMap<string, readonly StoredReading[]>): SemanticClassifier {
  return {
    classify(request: PassageRequest): readonly PassageReading[] {
      const held = answers.get(classificationKey(request));
      if (held === undefined) return [];
      return held.map((reading) => ({ kind: reading.kind, text: reading.text, line: request.line + reading.start, endLine: request.line + reading.end }));
    },
  };
}

/** The file the readings are kept in, beside the product in its store (never in the repository). */
export const CLASSIFICATIONS_FILE = 'doc-classifications.json';

/** Valid readings read back from the store; a reading that names no general kind is a finding, not a reading. */
function readingsOf(file: string, key: string, value: unknown, line: number): { readings: StoredReading[]; findings: Finding[] } {
  const findings: Finding[] = [];
  if (!Array.isArray(value)) {
    findings.push({ file, line, message: `the readings of the section ${JSON.stringify(key)} are a list of { kind, text, start, end }` });
    return { readings: [], findings };
  }
  const readings: StoredReading[] = [];
  value.forEach((entry: unknown, index) => {
    const body = entry as Record<string, unknown> | null;
    const field = (name: string): unknown => (body === null || typeof body !== 'object' ? undefined : body[name]);
    const kind = field('kind');
    const text = field('text');
    const start = field('start');
    const end = field('end');
    const whole = (number: unknown): number | undefined => (typeof number === 'number' && Number.isInteger(number) && number >= 0 ? number : undefined);
    if (typeof kind !== 'string' || !isSemanticKind(kind) || typeof text !== 'string' || whole(start) === undefined || whole(end) === undefined || (end as number) < (start as number)) {
      findings.push({ file, line, message: `the ${String(index + 1)}th reading of the section ${JSON.stringify(key)} is not { kind: ${SEMANTIC_KINDS.join('|')}, text, start, end }, its lines counted from the section's first line` });
      return;
    }
    readings.push({ kind, text, start: start as number, end: end as number });
  });
  return { readings, findings };
}

/** The readings a host filled into the product's store; a store that cannot be read is a finding naming the file and the line. */
export function readClassificationStore(file: string): { answers: Map<string, readonly StoredReading[]>; findings: Finding[] } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { answers: new Map(), findings: [] };
    return { answers: new Map(), findings: [{ file, line: 1, message: `the classifications cannot be read: ${(error as Error).message}` }] };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { answers: new Map(), findings: [{ file, line: 1, message: `the classifications are not valid JSON: ${(error as Error).message}` }] };
  }
  const body = value as Record<string, unknown> | null;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { answers: new Map(), findings: [{ file, line: 1, message: 'the classifications are { "sections": { "<key>": [ { kind, text, start, end } ] } }' }] };
  const sections = body['sections'];
  if (sections === null || typeof sections !== 'object' || Array.isArray(sections)) return { answers: new Map(), findings: [{ file, line: 1, message: 'the classifications hold a "sections" mapping of a key to its readings' }] };
  const answers = new Map<string, readonly StoredReading[]>();
  const findings: Finding[] = [];
  for (const [key, entry] of Object.entries(sections as Record<string, unknown>).sort(([a], [b]) => byCodePoint(a, b))) {
    const line = text.split('\n').findIndex((candidate) => candidate.includes(key)) + 1;
    const read = readingsOf(file, key, entry, line > 0 ? line : 1);
    findings.push(...read.findings);
    answers.set(key, read.readings);
  }
  return { answers, findings };
}

/** Writes the readings a host filled into the product's store, in a file of its own so a reader never sees half of one. */
export function writeClassificationStore(file: string, answers: ReadonlyMap<string, readonly StoredReading[]>): void {
  const sections: Record<string, readonly StoredReading[]> = {};
  for (const [key, readings] of [...answers].sort(([a], [b]) => byCodePoint(a, b))) sections[key] = readings;
  const text = `${JSON.stringify({ sections }, null, 2)}\n`;
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new Error(`${file}: the classifications could not be written: ${(error as Error).message}`);
  }
}

/**
 * A heading's text as a declaration writes it: marks removed, spaces collapsed, lower case, a closing colon dropped.
 * Read character by character: no expression over a document's text stands between a heading and what it is called
 * (madarch-ztyq.3, the review of finding 1).
 */
export function normaliseHeading(text: string): string {
  let stripped = '';
  for (const char of text) if (char !== '`' && char !== '*' && char !== '_' && char !== '~') stripped += char;
  let collapsed = '';
  for (const char of stripped) {
    const space = char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
    if (space && collapsed.endsWith(' ')) continue;
    collapsed += space ? ' ' : char;
  }
  let named = collapsed.trim().toLowerCase();
  if (named.endsWith(':')) named = named.slice(0, -1).trim();
  return named;
}
