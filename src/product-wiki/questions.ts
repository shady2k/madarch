/**
 * Parses product question documents from the form declared in the product
 * registry. Identity, field names and section names are supplied as data.
 */
import { statSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { parseDocument } from 'yaml';
import type { QuestionForm } from '../product/schema.js';

/** The states a question stands in: the set's own three, nothing invented. */
export type QuestionState = 'open' | 'answered' | 'not-applicable';
export const QUESTION_TYPES = ['meaning', 'contradiction', 'undocumented-behaviour', 'assumption-check', 'term', 'unverifiable', 'decision-rationale', 'access-or-document-needed'] as const;
export type QuestionType = typeof QUESTION_TYPES[number];

/** One open question as the wiki's API carries it. */
export interface OpenQuestion {
  /** The path within the product of the question's document. */
  readonly path: string;
  /** The identity carried by the document. */
  readonly id: string;
  /** The identity line's title: the question in one line. */
  readonly title: string;
  /** The task-defined question category, supplied by the Markdown record. */
  readonly type: QuestionType;
  /** Explicitly access or document for access-or-document-needed questions. */
  readonly missing?: 'access' | 'document';
  /** The Markdown record's prompt. */
  readonly prompt: string;
  /** Claim, page or unit ids whose work depends on this question. */
  readonly dependsOn: readonly string[];
  /** Distinct dependent page/unit count; used as the ranking score. */
  readonly rank: number;
  /** Evidence recorded with a resolved answer, when present. */
  readonly evidence?: string;
  /** The `## Question` section: what is not known, in full. */
  readonly question: string;
  /** The configured answerer field's value. */
  readonly who: string;
  /** The configured references field's values, split and trimmed. */
  readonly concerns: readonly string[];
  /** The computed state: `open`, `answered` or `not-applicable`. */
  readonly state: QuestionState;
  /** The answer's text when the question is closed, left out while it is open. */
  readonly answer?: string;
  /** The file's last modification time, ISO; the question doc's own change, not a day it was asked. */
  readonly changedAt?: string;
}

/** One file read as a question document, or nothing: the file is not one. */
export type ReadQuestion = { ok: true; question: OpenQuestion; changedAt?: string } | { ok: false; why: 'not-a-question' } | { ok: false; why: 'unreadable'; message: string };

/**
 * One question document's text, parsed into the entry the wiki serves. A
 * document the set would not recognise — another identity line, sections out
 * of the question's own names — is not a question: the set's gate refuses it
 * on its own terms, and the wiki lists nothing for a file it cannot read as
 * one.
 */
export function parseQuestion(path: string, markdown: string, form: QuestionForm): OpenQuestion | undefined {
  const lines = markdown.split('\n');
  // Code fences of either tick close a section only outside themselves.
  // The fence rules are the set's scanner's: a row of three or more ticks or
  // tildes (with an info string) opens; the closing row is the same tick, at
  // least as long, on a line of its own; inside a fence nothing else counts.
  let fence: { marker: string; length: number } | undefined;
  const structural = (line: string): boolean => {
    const trimmed = line.replace(/^[ \t]+|[ \t]+$/g, '');
    const open = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
    if (open !== null) {
      const row = trimmed.match(/^(`{3,}|~{3,})$/);
      const marker = open[1]![0]!;
      if (fence === undefined) fence = { marker, length: open[1]!.length };
      else if (row !== null && marker === fence.marker && row[0]!.length >= fence.length) fence = undefined;
      return false;
    }
    return fence === undefined;
  };
  let first: string | undefined;
  const frontMatterEnd = lines[0] === '---' ? lines.findIndex((line, index) => index > 0 && line.trim() === '---') : -1;
  if (lines[0] === '---' && frontMatterEnd < 0) throw new Error(`${path}: question front matter is missing its closing delimiter`);
  for (const [index, line] of lines.entries()) {
    if (frontMatterEnd > 0 && index <= frontMatterEnd) continue;
    if (line.trim() === '') continue;
    if (!structural(line)) continue;
    first = line;
    break;
  }
  if (first === undefined) return undefined;
  const separator = form.titleSeparator;
  const escapedSeparator = separator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedPrefix = form.identityPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const identity = first.match(new RegExp(`^# (${escapedPrefix}-\\d{3,})\\s*${escapedSeparator}\\s*(.+)$`));
  if (identity === null) return undefined;

  const fields = new Map<string, string>();
  const bodies = new Map<string, string[]>();
  let section: string | undefined;
  for (const line of lines) {
    // A line inside a code fence belongs to the open section's body, the way
    // the set's gate reads one; the fence's own first line is a structural
    // heading only after the fence closed.
    if (!structural(line)) {
      if (section !== undefined) bodies.set(section, [...(bodies.get(section) ?? []), line]);
      continue;
    }
    const heading = line.match(/^ {0,3}## (.+)$/);
    if (heading !== null) {
      const nextSection = heading[1]!.trim();
      // Markdown answers may contain their own headings. Only the configured
      // prompt and answer headings delimit the question record's sections.
      if (section === form.answerSection && nextSection !== form.promptSection && nextSection !== form.answerSection) {
        bodies.set(section, [...(bodies.get(section) ?? []), line]);
        continue;
      }
      section = nextSection;
      if (!bodies.has(section)) bodies.set(section, []);
      continue;
    }
    if (section === undefined) {
      const field = line.match(/^([A-Za-z][A-Za-z -]*): (.*)$/);
      if (field !== null) fields.set(field[1]!, field[2]!.trim());
      continue;
    }
    bodies.set(section, [...(bodies.get(section) ?? []), line]);
  }
  const question = (bodies.get(form.promptSection) ?? []).join('\n').trim();
  const answer = (bodies.get(form.answerSection) ?? []).join('\n').trim();
  const metadata = questionMetadata(markdown, fields);
  const questionType = metadata.type;
  const typeAliases: Record<string, QuestionType> = { 'access-needed': 'access-or-document-needed', 'document-needed': 'access-or-document-needed' };
  const type = QUESTION_TYPES.includes(questionType as QuestionType) ? questionType as QuestionType : typeAliases[questionType ?? ''];
  const missing = metadata.missing;
  const dependsOn = [...new Set(metadata.dependsOn)];
  const rank = dependsOn.filter((dependency) => !dependency.startsWith('claim-') && !dependency.startsWith('clm-')).length;
  const evidence = metadata.evidence ?? (answer === '' ? undefined : answer);
  // The question section is the document's substance: without it the file is
  // not a question the set's form holds (the set's gate refuses it), so the
  // wiki lists nothing.
  if (question === '') return undefined;
  if (questionType === undefined) throw new Error(`${path}: question type is missing`);
  if (type === undefined) throw new Error(`${path}: unsupported question type ${JSON.stringify(questionType)}`);
  const resolvedType = type;
  if (!Number.isSafeInteger(rank) || rank < 0) throw new Error(`${path}: Rank must be a non-negative integer`);
  if (resolvedType === 'access-or-document-needed' && missing !== 'access' && missing !== 'document') throw new Error(`${path}: Missing must be access or document for access-or-document-needed questions`);
  const state: QuestionState = answer === ''
    ? 'open'
    : (form.notApplicablePrefix !== undefined && answer.startsWith(form.notApplicablePrefix))
      ? 'not-applicable'
      : 'answered';
  const answerText = state === 'open' ? undefined : answer;
  return {
    path,
    id: identity![1]!,
    title: identity![2]!.trim(),
    type: resolvedType,
    ...(resolvedType === 'access-or-document-needed' ? { missing: missing as 'access' | 'document' } : {}),
    prompt: question,
    dependsOn,
    rank,
    ...(evidence === undefined ? {} : { evidence }),
    question,
    who: form.answererField === undefined ? '' : fields.get(form.answererField) ?? '',
    concerns: form.concernsField === undefined ? [] : (fields.get(form.concernsField) ?? '').split(',').map((each) => each.trim()).filter((each) => each !== ''),
    state,
    ...(answerText === undefined ? {} : { answer: answerText }),
  };
}

/** Read question metadata from generic YAML front matter or the compatible flat Markdown fields. */
function questionMetadata(markdown: string, fields: ReadonlyMap<string, string>): { type?: string; missing?: string; dependsOn: string[]; evidence?: string } {
  const lines = markdown.split(/\r?\n/);
  let type = fields.get('Type') ?? fields.get('type');
  let missing = fields.get('Missing') ?? fields.get('missing');
  let depends = fields.get('depends-on') ?? fields.get('Depends on');
  let evidence = fields.get('Evidence') ?? fields.get('evidence');
  if (lines[0] === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (end > 0) {
      try {
        const document = parseDocument(lines.slice(1, end).join('\n'));
        if (document.errors.length > 0) throw document.errors[0];
        const parsed = document.toJS() as unknown;
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('front matter must be a YAML mapping');
        const metadata = parsed as Record<string, unknown>;
        if ('type' in metadata) { if (typeof metadata.type !== 'string') throw new Error('type must be a string'); type = metadata.type; }
        if ('missing' in metadata) { if (typeof metadata.missing !== 'string') throw new Error('missing must be a string'); missing = metadata.missing; }
        if ('depends-on' in metadata) {
          const value = metadata['depends-on'];
          if (typeof value === 'string') depends = value;
          else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) depends = value.join(', ');
          else throw new Error('depends-on must be a string or a list of strings');
        }
        if ('evidence' in metadata) { if (typeof metadata.evidence !== 'string') throw new Error('evidence must be a string'); evidence = metadata.evidence; }
      } catch (error) {
        throw new Error(`question front matter could not be read: ${(error as Error).message}`);
      }
    }
  }
  return { ...(type === undefined ? {} : { type }), ...(missing === undefined ? {} : { missing }), dependsOn: (depends ?? '').split(',').map((item) => item.trim()).filter(Boolean), ...(evidence === undefined ? {} : { evidence }) };
}

/** A configured section's first paragraph, as one line. */
export function audienceOf(markdown: string, sectionName: string): string | undefined {
  const lines = markdown.split('\n');
  let fence: { marker: string; length: number } | undefined;
  let at: number | undefined;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.replace(/^[ \t]+|[ \t]+$/g, '');
    const open = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
    if (open !== null) {
      const row = trimmed.match(/^(`{3,}|~{3,})$/);
      const marker = open[1]![0]!;
      if (fence === undefined) fence = { marker, length: open[1]!.length };
      else if (row !== null && marker === fence.marker && row[0]!.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    if (new RegExp(`^ {0,3}#{1,6}\\s+${sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`).test(line)) {
      at = index + 1;
      break;
    }
  }
  if (at === undefined) return undefined;
  // The section's first paragraph: its non-blank lines joined, until the
  // paragraph ends or the next heading stands.
  const words: string[] = [];
  for (let index = at; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.trim() === '') {
      // A blank line ends the paragraph only once it has begun; the blank
      // lines right after the heading itself are not its body.
      if (words.length > 0) break;
      continue;
    }
    if (/^ {0,3}#{1,6}(\s|$)/.test(line)) break;
    words.push(line.trim());
  }
  return words.length === 0 ? undefined : words.join(' ');
}

/** Deterministic ranking: dependency count descending, then stable document id in code-point order. */
export function rankQuestions<T extends { id: string; dependsOn: readonly string[] }>(questions: readonly T[]): Array<T & { rank: number }> {
  return questions.map((question) => ({ ...question, rank: new Set(question.dependsOn.filter((dependency) => !dependency.startsWith('claim-') && !dependency.startsWith('clm-'))).size }))
    .sort((a, b) => b.rank - a.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** A question file's modification time, as the page's own metadata carries it. */
export function changedAtOf(pathIn: string, productFolder: string): string | undefined {
  const full = joinPath(productFolder, ...pathIn.split('/'));
  try {
    return statSync(full).mtime.toISOString();
  } catch {
    return undefined; // The count stands without the change time; read on.
  }
}
