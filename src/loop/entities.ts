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
 * This module renders those files from structured graph records. It resolves nothing against the
 * graph and runs no git: `answer.ts` writes and commits, `plan.ts` decides.
 */
import { stringify as stringifyYaml } from 'yaml';
import type { WrittenAt } from '../knowledge/index/page.js';
import { questionFootnoteId } from './ids.js';

export const QUESTIONS_FOLDER = 'docs/questions';
export const CORRECTIONS_FOLDER = 'docs/corrections';
export const QUESTION_KIND = 'question';
export const CORRECTION_KIND = 'correction';

export const QUESTION_TYPES = ['contradiction', 'ambiguous-term', 'undocumented', 'gap'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];


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

/** The headings of a question file, in the language of the wiki it is written for (the files are read in either). */
export const QUESTION_HEADINGS = {
  en: { question: 'Question', why: 'Why it matters', sources: 'What the sources say', answer: 'Answer', answeredBy: 'Answered by' },
  ru: { question: 'Вопрос', why: 'Почему это важно', sources: 'Что говорят источники', answer: 'Ответ', answeredBy: 'Ответил(а)' },
} as const;
export type QuestionLanguage = keyof typeof QUESTION_HEADINGS;

export interface Question {
  readonly producer?: string | null;
  /** The language the file's headings are in; English when absent (files written before the headings were localized). */
  readonly language?: QuestionLanguage;
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


/**
 * Where a statement is: the page id and the statement's name (a footnote name, possibly `name~2`). Only the pages the
 * writer writes have statements a person can correct (`product:` and `domain:`); a graph key such as
 * `code.symbol\u003asrc/pay.ts#Factory` also has a hash and is not one.
 */
export function parseStatementRef(ref: string): { page: string; statement: string } | undefined {
  const hash = ref.indexOf('#');
  if (hash <= 0 || hash === ref.length - 1) return undefined;
  const page = ref.slice(0, hash);
  if (!/^(product|domain):[a-z][a-z0-9-]*$/.test(page)) return undefined;
  return { page, statement: ref.slice(hash + 1) };
}

const quote = (text: string): string => text.split('\n').map((line) => (line === '' ? '>' : `> ${line}`)).join('\n');

/** A sentence for the page: one line, with a full stop at its end. */
function sentence(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return /[.!?…]$/.test(one) ? one : `${one}.`;
}

function frontMatterText(record: Record<string, unknown>): string {
  return stringifyYaml(record, { lineWidth: 0 }).trimEnd();
}

const authorRecord = (author: Author): Record<string, string> => ({ name: author.name, email: author.email, verified: author.verified });

/** The names of the footnotes of a question's sides: a content hash, unique within the file; an old file keeps its names. */
function footnoteNames(sides: readonly Side[]): string[] {
  const taken = new Set<string>();
  return sides.map((side) => {
    const base = questionFootnoteId(side.claim, side.grounds);
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
  const words = QUESTION_HEADINGS[question.language ?? 'en'];
  const lines = [
    '---', frontMatterText(front), '---', '',
    `## ${words.question}`, '', question.question.trim(), '',
    `## ${words.why}`, '', question.why.trim(), '',
    `## ${words.sources}`, '',
    ...question.sides.map((side, index) => `- ${sentence(side.claim)}[^${names[index]}]`), '',
    ...question.sides.map((side, index) => `[^${names[index]}]: ${side.grounds.map((ground) => `[${ground.replace(/^.*[:#/]/, '') || ground}](madarch:${ground})`).join(', ')}`),
  ];
  if (question.answer !== null) {
    lines.push('', `## ${words.answer}`, '', quote(question.answer.text.trim()), '', `${words.answeredBy} ${question.answer.by.name} <${question.answer.by.email}> at ${question.answer.at} (${question.answer.by.verified}).`);
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
