/**
 * Parses product question documents from the form declared in the product
 * registry. Identity, field names and section names are supplied as data.
 */
import { readFileSync, statSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { readProductRegistry } from '../product/registry.js';
import type { QuestionForm } from '../product/schema.js';

/** The states a question stands in: the set's own three, nothing invented. */
export type QuestionState = 'open' | 'answered' | 'not-applicable';



/** One open question as the wiki's API carries it. */
export interface OpenQuestion {
  /** The path within the product of the question's document. */
  readonly path: string;
  /** The identity carried by the document. */
  readonly id: string;
  /** The identity line's title: the question in one line. */
  readonly title: string;
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
  for (const line of lines) {
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
      section = heading[1]!.trim();
      if (!bodies.has(section)) bodies.set(section, []);
      continue;
    }
    if (section === undefined) {
      const field = line.match(/^([A-Za-z][A-Za-z ]*): (.*)$/);
      if (field !== null) fields.set(field[1]!, field[2]!.trim());
      continue;
    }
    bodies.set(section, [...(bodies.get(section) ?? []), line]);
  }
  const question = (bodies.get(form.promptSection) ?? []).join('\n').trim();
  const answer = (bodies.get(form.answerSection) ?? []).join('\n').trim();
  // The question section is the document's substance: without it the file is
  // not a question the set's form holds (the set's gate refuses it), so the
  // wiki lists nothing.
  if (question === '') return undefined;
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
    question,
    who: form.answererField === undefined ? '' : fields.get(form.answererField) ?? '',
    concerns: form.concernsField === undefined ? [] : (fields.get(form.concernsField) ?? '').split(',').map((each) => each.trim()).filter((each) => each !== ''),
    state,
    ...(answerText === undefined ? {} : { answer: answerText }),
  };
}

/** Reads the configured audience source from the product registry. */
export function productAudience(productFolder: string): string | undefined {
  const registry = readProductRegistry(productFolder);
  if (!registry.present || 'refused' in registry || registry.overview?.audience === undefined) return undefined;
  const { document, section } = registry.overview.audience;
  if (!document.startsWith('docs/') || document.split('/').some((part) => part === '' || part === '..')) return undefined;
  try { return audienceOf(readFileSync(joinPath(productFolder, ...document.split('/')), 'utf8'), section); }
  catch { return undefined; }
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

/** A question file's modification time, as the page's own metadata carries it. */
export function changedAtOf(pathIn: string, productFolder: string): string | undefined {
  const full = joinPath(productFolder, ...pathIn.split('/'));
  try {
    return statSync(full).mtime.toISOString();
  } catch {
    return undefined; // The count stands without the change time; read on.
  }
}
