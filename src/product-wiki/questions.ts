/**
 * The product's open questions, read from the documents the skill set writes
 * for them (the set's form, references/product.md at the pinned release, and
 * the same check .shady2k/checks/check-product.mjs runs): a question is a
 * Markdown document under the product's `docs/` whose identity line is
 * `# Q-<NNN> — <title>`, with the fields `Concerns:` and `Who can answer:` and
 * the sections `## Question`, `## What settles it` and — optional, may be
 * empty — `## Answer`.
 *
 * Status is computed, never written: the set refuses a `Status:` field. From
 * the answer's own text the state follows in the set's words:
 *
 *   `open`           the `## Answer` section stands empty or is absent;
 *   `answered`       the answer holds text, written as the answer;
 *   `not-applicable` the answer begins `Not applicable: <reason>`.
 *
 * An answer closes a question, and so does not applicable; an empty answer
 * leaves it open. The question's asked time is honest about what it is: the
 * form holds no asked date, so the view names the file's real modification
 * time as a change, never as the day it was asked.
 */
import { readFileSync, statSync } from 'node:fs';
import { join as joinPath } from 'node:path';

/** The states a question stands in: the set's own three, nothing invented. */
export type QuestionState = 'open' | 'answered' | 'not-applicable';

/** The identity line the set writes: `# Q-<NNN> — <title>`. */
const IDENTITY = /^# (Q-\d{3,}) — (.+)$/;

/** Where the answer starts saying the question does not apply. */
const NOT_APPLICABLE = /^Not applicable:/;

/** One open question as the wiki's API carries it. */
export interface OpenQuestion {
  /** The path within the product of the question's document. */
  readonly path: string;
  /** The document's id, `Q-004` for example. */
  readonly id: string;
  /** The identity line's title: the question in one line. */
  readonly title: string;
  /** The `## Question` section: what is not known, in full. */
  readonly question: string;
  /** The `Who can answer:` field. */
  readonly who: string;
  /** The `Concerns:` field's ids, split and trimmed. */
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
export function parseQuestion(path: string, markdown: string): OpenQuestion | undefined {
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
  const identity = first.match(IDENTITY);
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
  const question = (bodies.get('Question') ?? []).join('\n').trim();
  const answer = (bodies.get('Answer') ?? []).join('\n').trim();
  // The question section is the document's substance: without it the file is
  // not a question the set's form holds (the set's gate refuses it), so the
  // wiki lists nothing.
  if (question === '') return undefined;
  const state: QuestionState = answer === ''
    ? 'open'
    : NOT_APPLICABLE.test(answer)
      ? 'not-applicable'
      : 'answered';
  const answerText = state === 'open' ? undefined : answer;
  return {
    path,
    id: identity![1]!,
    title: identity![2]!.trim(),
    question,
    who: fields.get('Who can answer') ?? '',
    concerns: (fields.get('Concerns') ?? '').split(',').map((each) => each.trim()).filter((each) => each !== ''),
    state,
    ...(answerText === undefined ? {} : { answer: answerText }),
  };
}

/**
 * The audience the vision names: the `## Vision` document's `## Audience`
 * section's first paragraph, read as one line. A product whose vision is not
 * written yet — the fresh draft `madarch new` leaves — carries none: the wiki
 * shows that state plainly, never a made-up placeholder.
 */
export function productAudience(productFolder: string): string | undefined {
  let markdown: string;
  try {
    markdown = readFileSync(joinPath(productFolder, 'docs', 'vision.md'), 'utf8');
  } catch {
    return undefined; // No vision yet: a draft's own state, answered by the UI.
  }
  return audienceOf(markdown);
}

/** The `## Audience` section's first paragraph of a vision document, as one line. */
export function audienceOf(markdown: string): string | undefined {
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
    if (/^ {0,3}#{1,6}\s+Audience\s*$/.test(line)) {
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
