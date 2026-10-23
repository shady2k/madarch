/**
 * The two entities of the loop that closes the wiki (decision 0029, "People
 * edit source entities"; madarch-m38l.7): a question the agent asks while it
 * writes, and a correction a person records against a statement. Both are
 * Markdown files in the product repository, one per entity, so git shows each
 * edit and review works:
 *
 * - `docs/questions/<slug>.md`: front matter (`id: question:<slug>`, `kind`,
 *   `title`, `type`, `status: open | answered`, `about`, `asked-in`,
 *   `asked-at`, and once answered `answered-by`, `answered-at`; once a rewrite
 *   used the answer `resolved-by`, `resolved-at`), then `## Question`,
 *   `## Why it matters`, `## What the sources say` (one grounded statement per
 *   side, in the footnote format of the pages) and `## Answer` (a quotation).
 * - `docs/corrections/<slug>.md`: front matter (`id: correction:<slug>`,
 *   `about: [<page id>#<statement name>]`, `statement` as it read, `status:
 *   open | applied`, `corrected-by`, `corrected-at`), then `## Correction`.
 *
 * This module renders and reads those files. It resolves nothing against the
 * graph and runs no git: `answer.ts` writes and commits, `plan.ts` decides.
 * Every error names the file and the line.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { byCodePoint } from '../model/order.js';
import { splitFrontMatter } from '../knowledge/markdown.js';
import { readWrittenAt, type WrittenAt } from '../knowledge/index/page.js';
import { slugOf } from '../writer/names.js';
import { groundLinks } from '../writer/sentences.js';

export const QUESTIONS_FOLDER = 'docs/questions';
export const CORRECTIONS_FOLDER = 'docs/corrections';
export const QUESTION_KIND = 'question';
export const CORRECTION_KIND = 'correction';
/** The mark every person's writing carries on a local install (decision 0031): git's author is whatever the person set. */
export const LOCAL_UNVERIFIED = 'local, not verified';

export const QUESTION_TYPES = ['contradiction', 'ambiguous-term', 'undocumented', 'gap'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/** Bounds on what an agent or a person may put in one file. */
export const MAX_TITLE = 160;
export const MAX_TEXT = 1200;
export const MAX_SIDES = 4;
export const MAX_ABOUT = 12;
export const MAX_ANSWER = 8000;
export const MAX_REASON = 4000;

/** A problem in a loop file: where it is and what it is. */
export class LoopFileError extends Error {
  constructor(readonly file: string, readonly line: number, message: string) {
    super(`${file}:${line}: ${message}`);
  }
}

export interface Author {
  readonly name: string;
  readonly email: string;
  /** How the author was verified; `local, not verified` on a local install. */
  readonly verified: string;
}

export interface Side {
  /** What this source says, one sentence. */
  readonly claim: string;
  /** Grounds as `madarch:` targets without the scheme: a graph key or `doc:<path>#<anchor>`. */
  readonly grounds: readonly string[];
}

export interface Question {
  readonly slug: string;
  readonly id: string;
  /** Repository-relative path of the file. */
  readonly file: string;
  readonly title: string;
  readonly type: QuestionType;
  readonly status: 'open' | 'answered';
  /** Page ids, statements (`<page id>#<name>`), graph keys and `doc:` targets the question is about. */
  readonly about: readonly string[];
  readonly askedIn: string | null;
  readonly askedAt: string | null;
  readonly question: string;
  readonly why: string;
  readonly sides: readonly Side[];
  readonly answer: { readonly text: string; readonly by: Author; readonly at: string } | null;
  /** The pages whose rewrite used the answer; empty until a refresh did. */
  readonly resolvedBy: readonly string[];
  readonly resolvedAt: string | null;
  readonly writtenAt: readonly WrittenAt[];
}

export interface Correction {
  readonly slug: string;
  readonly id: string;
  readonly file: string;
  readonly title: string;
  readonly status: 'open' | 'applied';
  /** The statement corrected: `<page id>#<statement name>`. */
  readonly about: string;
  /** The sentence as it read when the correction was made. */
  readonly statement: string;
  /** "Wrong, because ...": the person's reason. */
  readonly reason: string;
  readonly by: Author;
  readonly at: string;
  readonly resolvedBy: readonly string[];
  readonly resolvedAt: string | null;
}

export const questionPath = (slug: string): string => `${QUESTIONS_FOLDER}/${slug}.md`;
export const correctionPath = (slug: string): string => `${CORRECTIONS_FOLDER}/${slug}.md`;

/**
 * Where a statement is: the page id and the statement's name (a footnote name, possibly `name~2`). Only the pages the
 * writer writes have statements a person can correct (`product:` and `domain:`); a graph key such as
 * `code.symbol:src/pay.ts#Factory` also has a hash and is not one.
 */
export function parseStatementRef(ref: string): { page: string; statement: string } | undefined {
  const hash = ref.indexOf('#');
  if (hash <= 0 || hash === ref.length - 1) return undefined;
  const page = ref.slice(0, hash);
  if (!/^(product|domain):[a-z][a-z0-9-]*$/.test(page)) return undefined;
  return { page, statement: ref.slice(hash + 1) };
}

const quote = (text: string): string => text.split('\n').map((line) => (line === '' ? '>' : `> ${line}`)).join('\n');
const unquote = (lines: readonly string[]): string => lines.map((line) => line.replace(/^>\s?/, '')).join('\n').trim();

/** A sentence for the page: one line, with a full stop at its end. */
function sentence(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return /[.!?…]$/.test(one) ? one : `${one}.`;
}

function frontMatterText(record: Record<string, unknown>): string {
  return stringifyYaml(record, { lineWidth: 0 }).trimEnd();
}

const authorRecord = (author: Author): Record<string, string> => ({ name: author.name, email: author.email, verified: author.verified });

/** The names of the footnotes of a question's sides: readable, unique within the file. */
function footnoteNames(sides: readonly Side[]): string[] {
  const taken = new Set<string>();
  return sides.map((side) => {
    const base = slugOf(side.claim, side.grounds[0] ?? '');
    let name = base;
    for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
    taken.add(name);
    return name;
  });
}

/** The file of a question, canonical: the same question is the same bytes. */
export function renderQuestion(question: Omit<Question, 'file' | 'id'>): string {
  const front: Record<string, unknown> = {
    id: `${QUESTION_KIND}:${question.slug}`,
    kind: QUESTION_KIND,
    title: question.title,
    type: question.type,
    status: question.status,
    about: [...question.about],
    ...(question.askedIn === null ? {} : { 'asked-in': question.askedIn }),
    ...(question.askedAt === null ? {} : { 'asked-at': question.askedAt }),
    producer: 'agent',
    ...(question.answer === null ? {} : { 'answered-by': authorRecord(question.answer.by), 'answered-at': question.answer.at }),
    ...(question.resolvedBy.length === 0 ? {} : { 'resolved-by': [...question.resolvedBy], 'resolved-at': question.resolvedAt }),
    ...(question.writtenAt.length === 0 ? {} : { 'written-at': question.writtenAt.map((entry) => ({ ...entry })) }),
  };
  const names = footnoteNames(question.sides);
  const lines = [
    '---', frontMatterText(front), '---', '',
    '## Question', '', question.question.trim(), '',
    '## Why it matters', '', question.why.trim(), '',
    '## What the sources say', '',
    ...question.sides.map((side, index) => `- ${sentence(side.claim)}[^${names[index]}]`), '',
    ...question.sides.map((side, index) => `[^${names[index]}]: ${side.grounds.map((ground) => `[${ground.replace(/^.*[:#/]/, '') || ground}](madarch:${ground})`).join(', ')}`),
  ];
  if (question.answer !== null) {
    lines.push('', '## Answer', '', quote(question.answer.text.trim()), '', `Answered by ${question.answer.by.name} <${question.answer.by.email}> at ${question.answer.at} (${question.answer.by.verified}).`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderCorrection(correction: Omit<Correction, 'file' | 'id'>): string {
  const front: Record<string, unknown> = {
    id: `${CORRECTION_KIND}:${correction.slug}`,
    kind: CORRECTION_KIND,
    title: correction.title,
    status: correction.status,
    about: [correction.about],
    statement: correction.statement,
    producer: 'person',
    'corrected-by': authorRecord(correction.by),
    'corrected-at': correction.at,
    ...(correction.resolvedBy.length === 0 ? {} : { 'resolved-by': [...correction.resolvedBy], 'resolved-at': correction.resolvedAt }),
  };
  return `${['---', frontMatterText(front), '---', '', '## Correction', '', quote(correction.reason.trim())].join('\n')}\n`;
}

// ---- reading ---------------------------------------------------------------------------------

interface Parsed {
  readonly record: Record<string, unknown>;
  readonly body: string;
  readonly bodyLine: number;
}

function parseFile(file: string, text: string): Parsed {
  const { front, body, bodyLine } = splitFrontMatter(text.replace(/\r\n/g, '\n'));
  if (front === null) throw new LoopFileError(file, 1, 'the file has no front matter: it starts with --- , its fields, ---');
  let raw: unknown;
  try {
    raw = parseYaml(front);
  } catch (error) {
    throw new LoopFileError(file, 2, `the front matter is no YAML: ${(error as Error).message.split('\n')[0]}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new LoopFileError(file, 2, 'the front matter is a mapping');
  return { record: raw as Record<string, unknown>, body, bodyLine };
}

function text(file: string, record: Record<string, unknown>, key: string, required: boolean): string | null {
  const value = record[key];
  if (value === undefined || value === null) {
    if (required) throw new LoopFileError(file, 2, `the front matter lacks "${key}"`);
    return null;
  }
  if (typeof value !== 'string' && !(value instanceof Date)) throw new LoopFileError(file, 2, `"${key}" is a text`);
  const out = value instanceof Date ? value.toISOString() : value.trim();
  if (out === '' && required) throw new LoopFileError(file, 2, `"${key}" is a non-empty text`);
  return out === '' ? null : out;
}

function list(file: string, record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) throw new LoopFileError(file, 2, `"${key}" is a list of non-empty texts`);
  return (value as string[]).map((entry) => entry.trim());
}

function author(file: string, record: Record<string, unknown>, key: string): Author {
  const value = record[key];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new LoopFileError(file, 2, `"${key}" is { name, email, verified }`);
  const body = value as Record<string, unknown>;
  const field = (name: string): string => {
    const entry = body[name];
    if (typeof entry !== 'string' || entry.trim() === '') throw new LoopFileError(file, 2, `"${key}.${name}" is a non-empty text`);
    return entry.trim();
  };
  return { name: field('name'), email: field('email'), verified: field('verified') };
}

/** The lines of each `## Heading` section of a body, with the line the section's text starts at. */
function sections(body: string, bodyLine: number): Map<string, { lines: string[]; line: number }> {
  const out = new Map<string, { lines: string[]; line: number }>();
  let current: { lines: string[]; line: number } | undefined;
  for (const [index, raw] of body.split('\n').entries()) {
    const heading = /^##\s+(.+?)\s*$/.exec(raw);
    if (heading !== null) {
      current = { lines: [], line: bodyLine + index + 1 };
      out.set(heading[1]!, current);
    } else if (current !== undefined) current.lines.push(raw);
  }
  return out;
}

const paragraph = (lines: readonly string[]): string => lines.join('\n').trim();

export function parseQuestion(file: string, source: string): Question {
  const { record, body, bodyLine } = parseFile(file, source);
  const slug = file.replace(/^.*\//, '').replace(/\.md$/, '');
  const id = text(file, record, 'id', true)!;
  if (id !== `${QUESTION_KIND}:${slug}`) throw new LoopFileError(file, 2, `"id" is "${QUESTION_KIND}:${slug}" for this file name, got ${JSON.stringify(id)}`);
  if (record['kind'] !== QUESTION_KIND) throw new LoopFileError(file, 2, `"kind" is "${QUESTION_KIND}", got ${JSON.stringify(record['kind'])}`);
  const type = text(file, record, 'type', true)!;
  if (!(QUESTION_TYPES as readonly string[]).includes(type)) throw new LoopFileError(file, 2, `"type" is one of ${QUESTION_TYPES.join(', ')}, got ${JSON.stringify(type)}`);
  const status = text(file, record, 'status', true)!;
  if (status !== 'open' && status !== 'answered') throw new LoopFileError(file, 2, `"status" is open or answered, got ${JSON.stringify(status)}`);
  const found = sections(body, bodyLine);
  const section = (name: string): { lines: string[]; line: number } => {
    const held = found.get(name);
    if (held === undefined) throw new LoopFileError(file, bodyLine, `the file has no "## ${name}" section`);
    return held;
  };
  const sourceSection = section('What the sources say');
  const footnotes = new Map<string, string[]>();
  for (const raw of body.split('\n')) {
    const definition = /^\[\^([\p{L}\p{N}_-]+)\]:[ \t]*(.*)$/u.exec(raw.trim());
    if (definition !== null) footnotes.set(definition[1]!, groundLinks(definition[2]!).map((link) => link.target).filter((target) => target.startsWith('madarch:')).map((target) => target.slice('madarch:'.length)));
  }
  // The sides are the bullets of their own section, word for word: the answer below is never read as a source.
  const sides: Side[] = [];
  for (const line of sourceSection.lines) {
    const bullet = /^-\s+(.*?)\[\^([\p{L}\p{N}_-]+)\]\s*$/u.exec(line.trim());
    if (bullet === null) continue;
    sides.push({ claim: bullet[1]!.trim(), grounds: footnotes.get(bullet[2]!) ?? [] });
  }
  if (sides.length === 0) throw new LoopFileError(file, sourceSection.line, 'the section "What the sources say" holds no grounded statement: each side is a bullet, a sentence ending in a footnote that lists its grounds');
  const answered = status === 'answered';
  let answer: Question['answer'] = null;
  if (answered) {
    const part = found.get('Answer');
    if (part === undefined) throw new LoopFileError(file, bodyLine, 'the status is answered but the file has no "## Answer" section');
    const quoted = unquote(part.lines.filter((line) => line.startsWith('>')));
    if (quoted === '') throw new LoopFileError(file, part.line, 'the "## Answer" section holds no quoted answer');
    const at = text(file, record, 'answered-at', true)!;
    answer = { text: quoted, by: author(file, record, 'answered-by'), at };
  } else if (found.has('Answer')) throw new LoopFileError(file, found.get('Answer')!.line, 'the file has an "## Answer" section but its status is open');
  const resolvedBy = list(file, record, 'resolved-by');
  return {
    slug,
    id,
    file,
    title: text(file, record, 'title', true)!,
    type: type as QuestionType,
    status,
    about: list(file, record, 'about'),
    askedIn: text(file, record, 'asked-in', false),
    askedAt: text(file, record, 'asked-at', false),
    question: paragraph(section('Question').lines),
    why: paragraph(section('Why it matters').lines),
    sides,
    answer,
    resolvedBy,
    resolvedAt: text(file, record, 'resolved-at', false),
    writtenAt: readWrittenAt(record['written-at'], file),
  };
}

export function parseCorrection(file: string, source: string): Correction {
  const { record, body, bodyLine } = parseFile(file, source);
  const slug = file.replace(/^.*\//, '').replace(/\.md$/, '');
  const id = text(file, record, 'id', true)!;
  if (id !== `${CORRECTION_KIND}:${slug}`) throw new LoopFileError(file, 2, `"id" is "${CORRECTION_KIND}:${slug}" for this file name, got ${JSON.stringify(id)}`);
  if (record['kind'] !== CORRECTION_KIND) throw new LoopFileError(file, 2, `"kind" is "${CORRECTION_KIND}", got ${JSON.stringify(record['kind'])}`);
  const status = text(file, record, 'status', true)!;
  if (status !== 'open' && status !== 'applied') throw new LoopFileError(file, 2, `"status" is open or applied, got ${JSON.stringify(status)}`);
  const about = list(file, record, 'about');
  if (about.length !== 1 || parseStatementRef(about[0]!) === undefined) throw new LoopFileError(file, 2, '"about" is a list of one statement, written <page id>#<statement name>');
  const part = sections(body, bodyLine).get('Correction');
  if (part === undefined) throw new LoopFileError(file, bodyLine, 'the file has no "## Correction" section');
  const reason = unquote(part.lines.filter((line) => line.startsWith('>')));
  if (reason === '') throw new LoopFileError(file, part.line, 'the "## Correction" section holds no quoted reason');
  return {
    slug,
    id,
    file,
    title: text(file, record, 'title', true)!,
    status,
    about: about[0]!,
    statement: text(file, record, 'statement', true)!,
    reason,
    by: author(file, record, 'corrected-by'),
    at: text(file, record, 'corrected-at', true)!,
    resolvedBy: list(file, record, 'resolved-by'),
    resolvedAt: text(file, record, 'resolved-at', false),
  };
}

// ---- reading a product's folders ---------------------------------------------------------------

function filesOf(productFolder: string, folder: string): string[] {
  try {
    return readdirSync(join(productFolder, folder)).filter((name) => name.endsWith('.md')).sort(byCodePoint).map((name) => `${folder}/${name}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new LoopFileError(folder, 1, `the folder cannot be read: ${(error as Error).message}`);
  }
}

export interface Read<T> {
  readonly items: T[];
  /** Files that could not be read, each with its file and line: never left out silently. */
  readonly problems: LoopFileError[];
}

function readFolder<T>(productFolder: string, folder: string, parse: (file: string, text: string) => T): Read<T> {
  const items: T[] = [];
  const problems: LoopFileError[] = [];
  for (const file of filesOf(productFolder, folder)) {
    try {
      items.push(parse(file, readFileSync(join(productFolder, file), 'utf8')));
    } catch (error) {
      problems.push(error instanceof LoopFileError ? error : new LoopFileError(file, 1, (error as Error).message));
    }
  }
  return { items, problems };
}

/** The questions of a product, in id order, and the files that are none. */
export const readQuestions = (productFolder: string): Read<Question> => readFolder(productFolder, QUESTIONS_FOLDER, parseQuestion);
export const readCorrections = (productFolder: string): Read<Correction> => readFolder(productFolder, CORRECTIONS_FOLDER, parseCorrection);

/** A slug for a new entity that no file holds: the readable slug, then `-2`, `-3`. */
export function freeSlug(productFolder: string, folder: string, wanted: string): string {
  const taken = new Set(filesOf(productFolder, folder).map((file) => file.replace(/^.*\//, '').replace(/\.md$/, '')));
  let slug = wanted;
  for (let n = 2; taken.has(slug); n += 1) slug = `${wanted}-${n}`;
  return slug;
}
