/**
 * The committed answer-key check: read a filled product's wiki through the same
 * page and document readers a person sees, build one evidence pack per answer
 * key item, and decide only the classes the structured evidence can decide.
 *
 * A pack is decided `fully` when every location has a page (or document), every
 * exact symbol and anchor is present, every `judge.mustShow` phrase is present
 * verbatim, and every `judge.mustLink` resolves to a page or a path the pack
 * shows. `partly` is structural: some locations are present and some are not,
 * or some exact needles are present and some are not. `none` means no location
 * has a page or document at all. Everything else is `unsure` and is written to
 * `answer-key-unsure.json` for the later reader (`jev`) step. The threshold is
 * computed and reported; it never makes this command exit non-zero.
 *
 * The main answer key has no `expectedOpenQuestions` field. The explicit eight
 * questions remain in `examples/training-repository/agent-stage/answer-key.json`;
 * they are read from there and reported as a separate source, never invented as
 * a field of the main key and never silently mapped to an `open.*` item.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readProduct, MANIFEST_FILE } from '../product/manifest.js';
import { KnowledgeProduct } from './product.js';
import type { Block, DocumentPage } from './model.js';
import { judgeAnswerKeyCheck, judgeLines, type Judge, type JudgeReport } from './answer-key-judge.js';
import { acpJudge } from './answer-key-acp-judge.js';
import type { DraftEnv } from '../product/home.js';

export type Classification = 'fully' | 'partly' | 'none' | 'unsure';

export interface AnswerKeyLocation {
  readonly snapshot: string;
  readonly path: string;
  readonly symbol?: string;
  readonly anchor?: string;
}

export interface AnswerKeyItem {
  readonly id: string;
  readonly location?: AnswerKeyLocation;
  readonly locations?: readonly AnswerKeyLocation[];
  readonly expectedWikiStatement: string;
  readonly evidenceClass: string;
  readonly viewpoints: readonly string[];
  readonly requiredNow: boolean;
  readonly judge: {
    readonly readerTask: string;
    readonly mustShow: readonly string[];
    readonly mustLink: readonly string[];
    readonly mustNotClaim: readonly string[];
  };
  readonly checks?: readonly unknown[];
}

export interface AnswerKey {
  readonly fixtureVersion?: number;
  readonly snapshots: Readonly<Record<string, string>>;
  readonly plantedCounts?: Readonly<Record<string, unknown>>;
  readonly countingRules?: Readonly<Record<string, unknown>>;
  readonly items: readonly AnswerKeyItem[];
}

export interface ExpectedQuestion {
  readonly type: string;
  readonly subject: string;
  readonly file: string;
}

export interface ExpectedQuestionSet {
  readonly file: string;
  readonly field: string;
  readonly questions: readonly ExpectedQuestion[];
}

export interface EvidenceDocumentRef {
  readonly repo: string | null;
  readonly path: string;
  readonly title: string;
}

export interface EvidenceQuestion {
  readonly slug: string;
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly state: string;
  readonly about: readonly string[];
}

export interface EvidencePage {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly blocks: readonly Block[];
  readonly findings: readonly { readonly file: string; readonly line: number; readonly message: string }[];
  readonly notes: readonly string[];
  readonly historicalAbsent?: boolean;
  readonly history?: {
    readonly coverage: 'covered' | 'unfilled' | 'before' | 'unknown';
    readonly commit: string | null;
    readonly effectiveAt: string | null;
  };
}

export interface EvidenceDocument {
  readonly repo: string | null;
  readonly path: string;
  readonly title: string;
  readonly markdown: string;
  readonly commit: string | null;
}

export interface ResolvedPlace {
  readonly repo: string | null;
  readonly fullPath: string;
}

/** The product reads the check needs, kept behind this seam so a fixture is a plain object. */
export interface EvidenceSource {
  readonly productFolder: string;
  documents(): Promise<readonly EvidenceDocumentRef[]>;
  resolvePlace(path: string, snapshot: string): Promise<ResolvedPlace | undefined>;
  expectedFullPath(path: string): string;
  isFinal(snapshot: string): boolean;
  page(id: string, snapshot: string): Promise<EvidencePage | undefined>;
  document(repo: string | null, path: string): Promise<EvidenceDocument | undefined>;
  questions(): readonly EvidenceQuestion[];
}

export interface EvidencePassage {
  /** The id a judge quotes: one of the pack's own passages, never a passage it invents. */
  readonly id: string;
  readonly page: string;
  readonly block: string;
  readonly line?: number;
  readonly text: string;
}

type RawPassage = Omit<EvidencePassage, 'id'>;

export interface LocationEvidence {
  readonly location: AnswerKeyLocation;
  readonly pageId: string | null;
  readonly symbolPageId: string | null;
  readonly documentPageId: string | null;
  readonly pages: readonly { readonly id: string; readonly kind: string; readonly title: string }[];
  readonly documents: readonly { readonly repo: string | null; readonly path: string; readonly title: string; readonly commit: string | null }[];
  readonly passages: readonly EvidencePassage[];
  readonly present: boolean;
  readonly found: boolean;
  readonly missingNeedles: readonly string[];
  readonly historyCoverage: 'covered' | 'unfilled' | 'before' | 'unknown' | null;
  readonly sourceTruncated: boolean;
  readonly fullPath: string;
  readonly error: { readonly file: string; readonly line: number; readonly message: string; readonly fullPath: string } | null;
}

export interface AnswerKeyPack {
  readonly item: AnswerKeyItem;
  readonly classification: Classification;
  readonly reason: string;
  readonly questionItem: boolean;
  readonly locations: readonly LocationEvidence[];
  readonly passages: readonly EvidencePassage[];
  readonly checks: {
    readonly locationsPresent: number;
    readonly locationsTotal: number;
    readonly locationsFound: number;
    readonly mustShowMatched: readonly string[];
    readonly mustShowMissing: readonly string[];
    readonly mustLinkMatched: readonly string[];
    readonly mustLinkUnresolved: readonly string[];
    readonly statementExact: boolean;
  };
  readonly expectedQuestions?: readonly ExpectedQuestion[];
  readonly currentQuestions?: readonly EvidenceQuestion[];
  /** Set only when the role-based judging step ran (madarch-j6ho.2). */
  readonly judgedBy?: 'jev' | 'classification' | 'analysis';
  readonly judgeReason?: string;
  readonly judgePassages?: readonly string[];
}

export interface AnswerKeyCounts {
  readonly fully: number;
  readonly partly: number;
  readonly none: number;
  readonly unsure: number;
}

export interface AnswerKeyThreshold {
  readonly fullyAtLeast: number;
  readonly noneAtMost: number;
  readonly expectedQuestions: number;
}

export interface AnswerKeySeam {
  readonly mainKeyField: 'missing';
  readonly mainKeyOpenItems: number;
  readonly expectedQuestionSource: string;
  readonly expectedQuestionField: string;
  readonly expectedQuestionCount: number;
  readonly questionsMatched: 'unsure';
  readonly note: string;
  readonly problems: readonly string[];
}

export interface AnswerKeyQuestionSummary {
  readonly source: string;
  readonly field: string;
  readonly expected: readonly ExpectedQuestion[];
  readonly current: readonly EvidenceQuestion[];
}

export interface AnswerKeyCheck {
  readonly keyFile: string;
  readonly productFolder: string;
  readonly totalItems: number;
  readonly counts: AnswerKeyCounts;
  readonly fullyRatio: number;
  readonly threshold: AnswerKeyThreshold;
  readonly thresholdMet: boolean;
  readonly gate: 'reported-only';
  readonly seam: AnswerKeySeam;
  readonly questions: AnswerKeyQuestionSummary;
  readonly items: readonly AnswerKeyPack[];
  /** The role-based judging step's account; absent until it runs. */
  readonly judge?: JudgeReport;
}

const QUESTION_ITEM_PREFIX = 'open.';
const FINAL_SNAPSHOT = 'snapshot-final';

function fullPath(file: string): string {
  return resolve(file);
}

function fail(file: string, line: number, message: string): never {
  throw new Error(`${file}:${line}: ${message}; full path ${fullPath(file)}`);
}

function readJson(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    fail(file, 1, `cannot read the file: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(file, 1, `the file is not JSON: ${(error as Error).message}`);
  }
}

function record(value: unknown, file: string, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(file, 1, `${where} must be an object`);
  return value as Record<string, unknown>;
}

function list(value: unknown, file: string, where: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(file, 1, `${where} must be an array`);
  return value;
}

function string(value: unknown, file: string, where: string): string {
  if (typeof value !== 'string' || value === '') fail(file, 1, `${where} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, file: string, where: string): string | undefined {
  if (value === undefined) return undefined;
  return string(value, file, where);
}

function boolean(value: unknown, file: string, where: string): boolean {
  if (typeof value !== 'boolean') fail(file, 1, `${where} must be a boolean`);
  return value;
}

function strings(value: unknown, file: string, where: string): readonly string[] {
  return list(value, file, where).map((one, at) => string(one, file, `${where}[${at}]`));
}

export function readAnswerKey(file: string): AnswerKey {
  const value = record(readJson(file), file, 'the answer key');
  const snapshots = record(value['snapshots'], file, 'snapshots');
  for (const [name, commit] of Object.entries(snapshots)) string(commit, file, `snapshots.${name}`);
  const rawItems = list(value['items'], file, 'items');
  if (rawItems.length === 0) fail(file, 1, 'items is empty: the check would silently compare nothing');
  const ids = new Set<string>();
  const items = rawItems.map((raw, at): AnswerKeyItem => {
    const item = record(raw, file, `items[${at}]`);
    const id = string(item['id'], file, `items[${at}].id`);
    if (ids.has(id)) fail(file, 1, `items[${at}].id repeats ${id}`);
    ids.add(id);
    const location = item['location'] === undefined ? undefined : readLocation(item['location'], file, `items[${at}].location`);
    const locations = item['locations'] === undefined ? undefined : list(item['locations'], file, `items[${at}].locations`).map((one, index) => readLocation(one, file, `items[${at}].locations[${index}]`));
    if (location === undefined && (locations === undefined || locations.length === 0)) fail(file, 1, `items[${at}] has no location or locations`);
    const judge = record(item['judge'], file, `items[${at}].judge`);
    return {
      id,
      ...(location === undefined ? {} : { location }),
      ...(locations === undefined ? {} : { locations }),
      expectedWikiStatement: string(item['expectedWikiStatement'], file, `items[${at}].expectedWikiStatement`),
      evidenceClass: string(item['evidenceClass'], file, `items[${at}].evidenceClass`),
      viewpoints: strings(item['viewpoints'], file, `items[${at}].viewpoints`),
      requiredNow: boolean(item['requiredNow'], file, `items[${at}].requiredNow`),
      judge: {
        readerTask: string(judge['readerTask'], file, `items[${at}].judge.readerTask`),
        mustShow: strings(judge['mustShow'], file, `items[${at}].judge.mustShow`),
        mustLink: strings(judge['mustLink'], file, `items[${at}].judge.mustLink`),
        mustNotClaim: strings(judge['mustNotClaim'], file, `items[${at}].judge.mustNotClaim`),
      },
      ...(item['checks'] === undefined ? {} : { checks: list(item['checks'], file, `items[${at}].checks`) }),
    };
  });
  for (const snapshot of items.flatMap((item) => (item.locations ?? (item.location === undefined ? [] : [item.location])).map((one) => one.snapshot))) {
    if (!Object.hasOwn(snapshots, snapshot)) fail(file, 1, `a location names snapshot ${snapshot}, which snapshots does not hold`);
  }
  return {
    ...(value['fixtureVersion'] === undefined ? {} : { fixtureVersion: number(value['fixtureVersion'], file, 'fixtureVersion') }),
    snapshots: snapshots as Record<string, string>,
    ...(value['plantedCounts'] === undefined ? {} : { plantedCounts: record(value['plantedCounts'], file, 'plantedCounts') }),
    ...(value['countingRules'] === undefined ? {} : { countingRules: record(value['countingRules'], file, 'countingRules') }),
    items,
  };
}

function number(value: unknown, file: string, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(file, 1, `${where} must be a finite number`);
  return value;
}

function readLocation(value: unknown, file: string, where: string): AnswerKeyLocation {
  const location = record(value, file, where);
  return {
    snapshot: string(location['snapshot'], file, `${where}.snapshot`),
    path: string(location['path'], file, `${where}.path`),
    ...(location['symbol'] === undefined ? {} : { symbol: string(location['symbol'], file, `${where}.symbol`) }),
    ...(location['anchor'] === undefined ? {} : { anchor: string(location['anchor'], file, `${where}.anchor`) }),
  };
}

export function readExpectedQuestions(file: string): ExpectedQuestionSet {
  const value = record(readJson(file), file, 'the expected-question key');
  const field = 'expectedOpenQuestions';
  const raw = list(value[field], file, field);
  if (raw.length === 0) fail(file, 1, `${field} is empty: the check would report no expected questions`);
  return {
    file,
    field,
    questions: raw.map((one, at) => {
      const question = record(one, file, `${field}[${at}]`);
      return {
        type: string(question['type'], file, `${field}[${at}].type`),
        subject: string(question['subject'], file, `${field}[${at}].subject`),
        file: string(question['file'], file, `${field}[${at}].file`),
      };
    }),
  };
}

export function questionItems(key: AnswerKey): readonly AnswerKeyItem[] {
  return key.items.filter((item) => item.id.startsWith(QUESTION_ITEM_PREFIX));
}

function locationsOf(item: AnswerKeyItem): readonly AnswerKeyLocation[] {
  if (item.locations !== undefined && item.locations.length > 0) return item.locations;
  return item.location === undefined ? [] : [item.location];
}

function normalSpace(text: string): string {
  let out = '';
  let space = false;
  for (const character of text) {
    if (character === ' ' || character === '\n' || character === '\r' || character === '\t') {
      if (!space && out !== '') {
        out += ' ';
        space = true;
      }
    } else {
      out += character;
      space = false;
    }
  }
  return out.trim();
}

function includesText(haystack: string, needle: string): boolean {
  const normalized = normalSpace(needle);
  return normalized !== '' && normalSpace(haystack).includes(normalized);
}

function wordCharacter(character: string | undefined): boolean {
  if (character === undefined || character === '') return false;
  return (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') || character === '_';
}

function boundaryAt(text: string, at: number, length: number): boolean {
  const before = at === 0 ? undefined : text[at - 1];
  const after = text[at + length];
  return !wordCharacter(before) && !wordCharacter(after);
}

function includesExact(haystack: string, needle: string): boolean {
  const normalized = normalSpace(needle);
  if (normalized === '') return false;
  const text = normalSpace(haystack);
  let from = 0;
  for (;;) {
    const at = text.indexOf(normalized, from);
    if (at < 0) return false;
    if (boundaryAt(text, at, normalized.length)) return true;
    from = at + 1;
  }
}

function includesWord(haystack: string, needle: string): boolean {
  return includesExact(haystack, needle);
}

function excerpt(text: string, at: number, length: number): string {
  const radius = 240;
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + length + radius);
  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`;
}

function lineAt(text: string, at: number, base: number): number {
  let line = base;
  for (let index = 0; index < at; index += 1) if (text[index] === '\n') line += 1;
  return line;
}

function stringValues(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const one of value) stringValues(one, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const one of Object.values(value as Record<string, unknown>)) stringValues(one, out);
  }
}

function pageHasTruncatedSource(page: EvidencePage): boolean {
  for (const block of page.blocks) {
    const value = block as unknown as { type?: unknown; truncated?: unknown };
    if (value.type === 'source' && value.truncated === true) return true;
  }
  return false;
}

function pageText(page: EvidencePage): string {
  const values: string[] = [];
  stringValues(page.blocks, values);
  stringValues(page.findings, values);
  stringValues(page.notes, values);
  return values.join('\n');
}

function blockLocation(block: Block): { path?: string; lineStart?: number } {
  const value = block as unknown as { location?: { path?: unknown; lineStart?: unknown } };
  const location = value.location;
  if (location === undefined) return {};
  return {
    ...(typeof location.path === 'string' ? { path: location.path } : {}),
    ...(typeof location.lineStart === 'number' ? { lineStart: location.lineStart } : {}),
  };
}

function sourcePassages(page: EvidencePage, block: Block, needles: readonly string[]): RawPassage[] {
  const value = block as unknown as { type?: unknown; text?: unknown };
  if (value.type !== 'source' || typeof value.text !== 'string') return [];
  const text = value.text;
  const lineStart = blockLocation(block).lineStart ?? 1;
  const found: RawPassage[] = [];
  if (needles.length === 0) {
    found.push({ page: page.id, block: 'source', line: lineStart, text: excerpt(text, 0, 0) });
    return found;
  }
  for (const needle of needles) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(needle, from);
      if (at < 0) break;
      found.push({ page: page.id, block: 'source', line: lineAt(text, at, lineStart), text: excerpt(text, at, needle.length) });
      from = at + needle.length;
      if (found.length >= 8) return found;
    }
  }
  return found;
}

const READABLE_BLOCKS = new Set(['source', 'markdown', 'body', 'properties', 'related', 'diagrams', 'history', 'title']);
const NOT_PROSE = new Set(['href', 'url', 'key', 'id', 'type', 'language', 'repo', 'path', 'lineStart', 'lineEnd', 'anchor', 'name', 'empty', 'truncated', 'source', 'location']);

function proseValues(value: unknown, field: string | undefined, out: string[]): void {
  if (field !== undefined && NOT_PROSE.has(field)) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const one of value) proseValues(one, undefined, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, one] of Object.entries(value as Record<string, unknown>)) proseValues(one, key, out);
  }
}

function genericBlockPassages(page: EvidencePage, block: Block, needles: readonly string[]): RawPassage[] {
  const type = typeof (block as { type?: unknown }).type === 'string' ? String((block as { type?: unknown }).type) : 'block';
  if (!READABLE_BLOCKS.has(type)) return [];
  const values: string[] = [];
  proseValues(block, undefined, values);
  const found: RawPassage[] = [];
  for (const text of values) {
    if (needles.length === 0) {
      if (text.trim() !== '') found.push({ page: page.id, block: type, text: excerpt(text, 0, 0) });
    } else {
      for (const needle of needles) {
        let from = 0;
        for (;;) {
          const at = text.indexOf(needle, from);
          if (at < 0) break;
          found.push({ page: page.id, block: type, text: excerpt(text, at, needle.length) });
          from = at + needle.length;
          if (found.length >= 8) return found;
        }
      }
    }
  }
  return found;
}

function passagesOfPage(page: EvidencePage, needles: readonly string[]): RawPassage[] {
  const found: RawPassage[] = [];
  for (const block of page.blocks) {
    const source = sourcePassages(page, block, needles);
    if (source.length > 0) found.push(...source);
    else found.push(...genericBlockPassages(page, block, needles));
    if (found.length >= 12) break;
  }
  if (found.length === 0) {
    const text = pageText(page);
    if (text !== '') found.push({ page: page.id, block: 'page', text: excerpt(text, 0, 0) });
  }
  const seen = new Set<string>();
  return found.filter((passage) => {
    const key = `${passage.page}\u0000${passage.block}\u0000${passage.line ?? ''}\u0000${passage.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function passagesOfDocument(document: EvidenceDocument, needles: readonly string[]): RawPassage[] {
  const page = `document:${document.repo ?? ''}:${document.path}`;
  const lines = document.markdown.split('\n');
  const found: RawPassage[] = [];
  for (const [index, line] of lines.entries()) {
    if (needles.length === 0 || needles.some((needle) => line.includes(needle))) {
      const start = Math.max(0, index - 2);
      const end = Math.min(lines.length, index + 3);
      found.push({ page, block: 'document', line: index + 1, text: lines.slice(start, end).join('\n') });
      if (found.length >= 12) break;
    }
  }
  if (found.length === 0) found.push({ page, block: 'document', line: 1, text: excerpt(document.markdown, 0, 0) });
  return found;
}

function linkMatches(link: string, text: string): boolean {
  return includesText(text, link);
}

function decide(pack: Omit<AnswerKeyPack, 'classification' | 'reason'>): { classification: Classification; reason: string } {
  if (pack.questionItem) return { classification: 'unsure', reason: 'expected-question-needs-a-reader' };
  const locations = pack.locations;
  if (locations.length === 0) return { classification: 'none', reason: 'item-has-no-location' };
  for (const location of locations) {
    if (location.historyCoverage !== null && location.historyCoverage !== 'covered') return { classification: 'unsure', reason: 'history-not-covered' };
  }
  const present = locations.filter((location) => location.present).length;
  if (present === 0) return { classification: 'none', reason: 'no-location-has-a-page' };
  if (present < locations.length) return { classification: 'partly', reason: 'some-locations-have-no-page' };
  const found = locations.filter((location) => location.found).length;
  if (found < locations.length && locations.some((location) => location.sourceTruncated && !location.found)) return { classification: 'unsure', reason: 'source-truncated' };
  if (found === 0) return { classification: 'unsure', reason: 'no-exact-source-in-the-pages' };
  if (found < locations.length) return { classification: 'partly', reason: 'some-locations-lack-the-exact-source' };
  if (pack.checks.mustShowMissing.length === 0 && pack.checks.mustLinkUnresolved.length === 0) return { classification: 'fully', reason: 'required-elements-and-links-present' };
  return { classification: 'unsure', reason: 'semantic-reading-needed' };
}

export async function buildAnswerKeyCheck(source: EvidenceSource, key: AnswerKey, expected: ExpectedQuestionSet, keyFile: string): Promise<AnswerKeyCheck> {
  const documents = await source.documents();
  const questions = source.questions();
  const items: AnswerKeyPack[] = [];
  for (const item of key.items) {
    const questionItem = item.id.startsWith(QUESTION_ITEM_PREFIX);
    const locationEvidence: (Omit<LocationEvidence, 'passages'> & { passages: RawPassage[] })[] = [];
    const passages: RawPassage[] = [];
    const allText: string[] = [];
    for (const location of locationsOf(item)) {
      const needles = [location.symbol, location.anchor].filter((one): one is string => one !== undefined);
      const place = await source.resolvePlace(location.path, location.snapshot);
      const pageId = place?.repo === undefined || place?.repo === null ? null : `code.file:${location.path}`;
      const symbolPageId = pageId === null || location.symbol === undefined ? null : `code.symbol:${location.path}#${location.symbol}`;
      const documentRef = documents.find((one) => one.path === location.path && (place === undefined || one.repo === place.repo));
      const documentPageId = documentRef === undefined ? null : `document:${documentRef.repo ?? ''}:${documentRef.path}`;
      const filePage = pageId === null ? undefined : await source.page(pageId, location.snapshot);
      const symbolPage = symbolPageId === null ? undefined : await source.page(symbolPageId, location.snapshot);
      const pages = [filePage, symbolPage].filter((one): one is EvidencePage => one !== undefined);
      const document = source.isFinal(location.snapshot) && place !== undefined ? await source.document(place.repo, location.path) : undefined;
      const pagePresent = pages.some((one) => one.historicalAbsent !== true);
      const present = pagePresent || document !== undefined;
      const locationPassages: RawPassage[] = [];
      const locationText: string[] = [];
      for (const page of pages) {
        locationPassages.push(...passagesOfPage(page, needles));
        locationText.push(pageText(page));
        if (page.findings.length > 0) locationText.push(JSON.stringify(page.findings));
        if (page.notes.length > 0) locationText.push(JSON.stringify(page.notes));
      }
      if (document !== undefined) {
        locationPassages.push(...passagesOfDocument(document, needles));
        locationText.push(document.markdown);
      }
      allText.push(...locationText);
      const localText = locationText.join('\n');
      const matchedHere = item.judge.mustShow.filter((phrase) => includesWord(localText, phrase));
      if (matchedHere.length > 0) {
        for (const page of pages) locationPassages.push(...passagesOfPage(page, matchedHere));
        if (document !== undefined) locationPassages.push(...passagesOfDocument(document, matchedHere));
      }
      const missingNeedles = needles.filter((needle) => !includesExact(localText, needle));
      const historyCoverage = pages.find((one) => one.history !== undefined)?.history?.coverage ?? null;
      const found = present && missingNeedles.length === 0;
      const evidence: Omit<LocationEvidence, 'passages'> & { passages: RawPassage[] } = {
        location,
        pageId,
        symbolPageId,
        documentPageId,
        pages: pages.map((one) => ({ id: one.id, kind: one.kind, title: one.title })),
        documents: document === undefined ? [] : [{ repo: document.repo, path: document.path, title: document.title, commit: document.commit }],
        passages: locationPassages,
        present,
        found,
        missingNeedles,
        historyCoverage,
        sourceTruncated: pages.some((one) => pageHasTruncatedSource(one)),
        fullPath: place?.fullPath ?? source.expectedFullPath(location.path),
        error: present ? null : {
          file: location.path,
          line: 1,
          fullPath: place?.fullPath ?? source.expectedFullPath(location.path),
          message: place === undefined
            ? `no linked repository or product document holds ${location.path}`
            : `the wiki has no page for ${location.path} at ${location.snapshot}`,
        },
      };
      locationEvidence.push(evidence);
      passages.push(...locationPassages);
    }
    // A judge quotes passages by id. The ids are made once per pack, from the passages the evidence actually
    // holds, so an id the pack does not have cannot be accepted later (madarch-j6ho.2).
    const passageIds = new Map<string, EvidencePassage>();
    const withId = (passage: RawPassage): EvidencePassage => {
      const key = JSON.stringify([passage.page, passage.block, passage.line ?? null, passage.text]);
      const held = passageIds.get(key);
      if (held !== undefined) return held;
      const made: EvidencePassage = { id: `p${passageIds.size + 1}`, ...passage };
      passageIds.set(key, made);
      return made;
    };
    const finalizedLocations: LocationEvidence[] = locationEvidence.map((location) => ({ ...location, passages: location.passages.map(withId) }));
    const finalizedPassages = passages.map(withId);
    const combined = allText.join('\n');
    const mustShowMatched = item.judge.mustShow.filter((phrase) => includesWord(combined, phrase));
    const mustShowMissing = item.judge.mustShow.filter((phrase) => !includesWord(combined, phrase));
    const mustLinkMatched = item.judge.mustLink.filter((link) => linkMatches(link, combined));
    const mustLinkUnresolved = item.judge.mustLink.filter((link) => !linkMatches(link, combined));
    const partial = {
      item,
      questionItem,
      locations: finalizedLocations,
      passages: finalizedPassages,
      checks: {
        locationsPresent: finalizedLocations.filter((location) => location.present).length,
        locationsTotal: finalizedLocations.length,
        locationsFound: finalizedLocations.filter((location) => location.found).length,
        mustShowMatched,
        mustShowMissing,
        mustLinkMatched,
        mustLinkUnresolved,
        statementExact: includesText(combined, item.expectedWikiStatement),
      },
      ...(questionItem ? { expectedQuestions: expected.questions, currentQuestions: questions } : {}),
    };
    const decision = decide(partial);
    items.push({ ...partial, classification: decision.classification, reason: decision.reason });
  }
  const counts: AnswerKeyCounts = {
    fully: items.filter((item) => item.classification === 'fully').length,
    partly: items.filter((item) => item.classification === 'partly').length,
    none: items.filter((item) => item.classification === 'none').length,
    unsure: items.filter((item) => item.classification === 'unsure').length,
  };
  const threshold: AnswerKeyThreshold = { fullyAtLeast: 0.9, noneAtMost: 0, expectedQuestions: 8 };
  const open = questionItems(key);
  const seamProblems: string[] = [];
  if (open.length !== expected.questions.length) seamProblems.push(`the main key has ${open.length} ${QUESTION_ITEM_PREFIX} items but ${expected.file} holds ${expected.questions.length} ${expected.field} entries; they are reported side by side, not paired`);
  if (expected.questions.length !== threshold.expectedQuestions) seamProblems.push(`${expected.file} holds ${expected.questions.length} ${expected.field} entries, not the milestone's ${threshold.expectedQuestions}`);
  const fullyRatio = items.length === 0 ? 0 : counts.fully / items.length;
  return {
    keyFile,
    productFolder: source.productFolder,
    totalItems: items.length,
    counts,
    fullyRatio,
    threshold,
    thresholdMet: fullyRatio >= threshold.fullyAtLeast && counts.none <= threshold.noneAtMost && expected.questions.length === threshold.expectedQuestions && open.length === expected.questions.length && seamProblems.length === 0,
    gate: 'reported-only',
    seam: {
      mainKeyField: 'missing',
      mainKeyOpenItems: open.length,
      expectedQuestionSource: expected.file,
      expectedQuestionField: expected.field,
      expectedQuestionCount: expected.questions.length,
      questionsMatched: 'unsure',
      note: 'The main answer key has no expectedOpenQuestions field. The explicit questions are read from the older agent-stage key and reported as a separate source; no open.* item is assumed to be the same question.',
      problems: seamProblems,
    },
    questions: { source: expected.file, field: expected.field, expected: expected.questions, current: questions },
    items,
  };
}

export function thresholdLine(check: AnswerKeyCheck): string {
  return `threshold (computed, not gated): fully ${check.counts.fully}/${check.totalItems} = ${(check.fullyRatio * 100).toFixed(1)}% (needs >= ${(check.threshold.fullyAtLeast * 100).toFixed(0)}%), none ${check.counts.none} (needs <= ${check.threshold.noneAtMost}), expected questions ${check.questions.expected.length} (needs ${check.threshold.expectedQuestions})`;
}

export function reportText(check: AnswerKeyCheck): string {
  const lines: string[] = [];
  lines.push(`answer-key check: ${check.totalItems} items in ${check.keyFile}`);
  lines.push(`product: ${check.productFolder}`);
  lines.push(`fully ${check.counts.fully}, partly ${check.counts.partly}, none ${check.counts.none}, unsure ${check.counts.unsure}`);
  lines.push(thresholdLine(check));
  lines.push(`threshold met: ${check.thresholdMet ? 'yes' : 'no'}; this command reports it and does not gate on it`);
  lines.push(`expected questions: ${check.questions.expected.length} from ${check.questions.source}#${check.questions.field}`);
  lines.push(`main key open items: ${check.seam.mainKeyOpenItems}; seam: ${check.seam.note}`);
  if (check.seam.problems.length > 0) for (const problem of check.seam.problems) lines.push(`seam problem: ${problem}`);
  for (const [index, question] of check.questions.expected.entries()) lines.push(`  ${index + 1}. [${question.type}] ${question.subject} (${question.file})`);
  lines.push(`current question pages: ${check.questions.current.length}`);
  for (const item of check.items) if (item.classification === 'unsure') lines.push(`unsure ${item.item.id}: ${item.reason}`);
  lines.push(...judgeLines(check));
  return lines.join('\n');
}

export function writeAnswerKeyCheck(check: AnswerKeyCheck, outFolder: string): { packs: string; unsure: string; report: string } {
  mkdirSync(outFolder, { recursive: true });
  const packs = join(outFolder, 'answer-key-packs.json');
  const unsure = join(outFolder, 'answer-key-unsure.json');
  const report = join(outFolder, 'answer-key-report.json');
  writeFileSync(packs, `${JSON.stringify(check, null, 2)}\n`);
  writeFileSync(unsure, `${JSON.stringify({
    keyFile: check.keyFile,
    productFolder: check.productFolder,
    counts: check.counts,
    threshold: check.threshold,
    thresholdMet: check.thresholdMet,
    gate: check.gate,
    seam: check.seam,
    questions: check.questions,
    judge: check.judge,
    items: check.items.filter((item) => item.classification === 'unsure'),
  }, null, 2)}\n`);
  writeFileSync(report, `${JSON.stringify({
    keyFile: check.keyFile,
    productFolder: check.productFolder,
    totalItems: check.totalItems,
    counts: check.counts,
    fullyRatio: check.fullyRatio,
    threshold: check.threshold,
    thresholdMet: check.thresholdMet,
    gate: check.gate,
    seam: check.seam,
    questions: { source: check.questions.source, field: check.questions.field, expected: check.questions.expected, current: check.questions.current },
    judge: check.judge,
    reasons: check.items.map((item) => ({ id: item.item.id, classification: item.classification, reason: item.reason })),
  }, null, 2)}\n`);
  return { packs, unsure, report };
}

/** The product-backed source: real page and document reads, no rendering and no agent. */
export class ProductEvidenceSource implements EvidenceSource {
  private documentsCache: Promise<readonly EvidenceDocumentRef[]> | undefined;
  private readonly repositoryNames: readonly string[];
  private readonly finalCommit: string | undefined;

  constructor(private readonly product: KnowledgeProduct, readonly productFolder: string, private readonly key: AnswerKey, private readonly manifestFile: string) {
    const read = readProduct(productFolder);
    if (!read.ok) fail(read.file, read.line, read.message);
    this.repositoryNames = read.product.repos.map((repo) => repo.name);
    this.finalCommit = key.snapshots[FINAL_SNAPSHOT];
  }

  async documents(): Promise<readonly EvidenceDocumentRef[]> {
    if (this.documentsCache === undefined) this.documentsCache = this.product.documents().then((listing) => listing.documents);
    return await this.documentsCache;
  }

  async resolvePlace(path: string, snapshot: string): Promise<ResolvedPlace | undefined> {
    const documents = await this.documents();
    const document = documents.find((one) => one.path === path);
    if (document !== undefined && (document.repo === null || this.isFinal(snapshot))) return this.place(document.repo, path);
    for (const repository of this.repositoryNames) {
      const root = join(this.productFolder, 'repos', repository);
      if (existsSync(join(root, path))) return this.place(repository, path);
    }
    if (document !== undefined) return this.place(document.repo, path);
    if (this.repositoryNames.length === 1) return this.place(this.repositoryNames[0] ?? null, path);
    return undefined;
  }

  private place(repo: string | null, path: string): ResolvedPlace {
    const root = repo === null ? this.productFolder : join(this.productFolder, 'repos', repo);
    let full = join(root, path);
    try {
      full = realpathSync(full);
    } catch {
      // The error still names the place the product expected, with its full path.
    }
    return { repo, fullPath: full };
  }

  expectedFullPath(path: string): string {
    const repository = this.repositoryNames[0];
    return repository === undefined ? join(this.productFolder, path) : join(this.productFolder, 'repos', repository, path);
  }

  isFinal(snapshot: string): boolean {
    return this.finalCommit === undefined ? snapshot === FINAL_SNAPSHOT : this.key.snapshots[snapshot] === this.finalCommit;
  }

  async page(id: string, snapshot: string): Promise<EvidencePage | undefined> {
    let path: string;
    if (id.startsWith('code.file:')) path = id.slice('code.file:'.length);
    else if (id.startsWith('code.symbol:')) {
      const rest = id.slice('code.symbol:'.length);
      const at = rest.indexOf('#');
      if (at < 0) return undefined;
      path = rest.slice(0, at);
    } else return undefined;
    const place = await this.resolvePlace(path, snapshot);
    if (place === undefined || place.repo === null) return undefined;
    const result = await this.product.page(id, undefined, this.isFinal(snapshot) ? {} : { history: { repo: place.repo, at: snapshot } });
    if (!result.ok) return undefined;
    return {
      id: result.page.id,
      kind: result.page.kind,
      title: result.page.title,
      blocks: result.page.blocks,
      findings: result.page.findings,
      notes: result.page.notes,
      ...(result.page.historicalAbsent === true ? { historicalAbsent: true } : {}),
      ...(result.page.history === undefined ? {} : { history: { coverage: result.page.history.coverage, commit: result.page.history.commit, effectiveAt: result.page.history.effectiveAt } }),
    };
  }

  async document(repo: string | null, path: string): Promise<EvidenceDocument | undefined> {
    const document: DocumentPage | undefined = await this.product.document(repo, path);
    if (document === undefined) return undefined;
    return { repo: document.repo, path: document.path, title: document.title, markdown: document.markdown, commit: document.commit };
  }

  questions(): readonly EvidenceQuestion[] {
    return this.product.questions().rows.map((row) => ({ slug: row.slug, id: row.id, title: row.title, type: row.type, state: row.state, about: row.about }));
  }
}

export interface RunAnswerKeyCheckOptions {
  readonly productFolder: string;
  readonly storeRoot: string;
  readonly keyFile: string;
  readonly questionKeyFile: string;
  readonly outFolder: string;
  /** The host's older reader; when passed it judges first and no model role is started. */
  readonly jev?: Judge;
  /** How a role's resolved pair becomes a judge; the production ACP judge when absent. Tests pass fakes. */
  readonly judgeForPair?: (pair: import('./model-roles.js').ModelPair, role: import('./model-roles.js').ModelRole) => Judge;
  /** The environment the role agents start in; the process's own when absent. */
  readonly env?: DraftEnv;
}

export async function runAnswerKeyCheck(options: RunAnswerKeyCheckOptions): Promise<{ check: AnswerKeyCheck; written: { packs: string; unsure: string; report: string } }> {
  const key = readAnswerKey(options.keyFile);
  const expected = readExpectedQuestions(options.questionKeyFile);
  const product = new KnowledgeProduct({ productFolder: options.productFolder, storeRoot: options.storeRoot });
  try {
    const source = new ProductEvidenceSource(product, options.productFolder, key, join(options.productFolder, MANIFEST_FILE));
    const built = await buildAnswerKeyCheck(source, key, expected, options.keyFile);
    const check = await judgeAnswerKeyCheck(built, {
      ...(options.jev === undefined ? {} : { jev: options.jev }),
      roles: product.modelRoles(),
      judgeForPair: options.judgeForPair ?? ((pair, role) => acpJudge(pair, role, { env: options.env ?? process.env })),
    });
    return { check, written: writeAnswerKeyCheck(check, options.outFolder) };
  } finally {
    await product.close();
  }
}

export function defaultStoreRoot(): string {
  return join(homedir(), '.madarch', 'knowledge');
}

export function defaultAnswerKeyFile(root: string): string {
  return join(root, 'examples', 'training-repository', 'answer-key.json');
}

export function defaultQuestionKeyFile(root: string): string {
  return join(root, 'examples', 'training-repository', 'agent-stage', 'answer-key.json');
}
