/**
 * The person's word, kept as Markdown in the product's git (the self-filling
 * charter's outcome 5; decision 0026, "Pages": "a person's edits and answers are git as
 * well").
 *
 * The charter: «Открытые вопросы должны закрываться, если агент в процессе нашел
 * ответ. Человек отвечает на вопросы и принимает или отклоняет страницы в вики» — a
 * person answers a question and accepts or rejects a page's proposed content, and both
 * are records in the product's own repository, not rows a server holds alone. So the
 * wiki writes one small Markdown file per decision, and the graph reads it back
 * (`declared.ts`): the file is the record, the graph is the reading of it, and a
 * person's repository keeps the words they wrote.
 *
 * **Two documents, one shape.** An answer closes a question; an acceptance settles
 * what a page proposes. Both name the node they decide about by its fact id, say what
 * the decision is, when it was taken and by whom, and carry the person's words under
 * one heading. The shape is data — the field names below — so a reader and a writer
 * cannot disagree about it, and the body is the person's Markdown unchanged.
 *
 * **Nothing is guessed.** A file that does not read as one of the two is refused with
 * its own path, its 1-based line and what stands there, and a refusal never drops a
 * decision silently: the caller reports it and writes nothing.
 *
 * The files stand beside the product's `comments/` (the discussion writer's record) as
 * `answers/` and `acceptances/`, one file per decided node, named by the node's fact id
 * digest so a path is one machine-independent name and never a colon a filesystem
 * refuses.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The folder a person's answers stand in, under the product's own folder. */
export const ANSWERS_FOLDER = 'answers';

/** The folder a person's acceptances stand in, under the product's own folder. */
export const ACCEPTANCES_FOLDER = 'acceptances';

/** The product's own word for a decision it accepted a page with. */
export const ACCEPTED = 'accepted';

/** The product's own word for a decision it rejected a page with. */
export const REJECTED = 'rejected';

/** What a person decided about a page: they accepted it, or rejected it. */
export const VERDICTS = [ACCEPTED, REJECTED] as const;
export type Verdict = (typeof VERDICTS)[number];

/** The answer a person wrote to a question, as the product's git holds it. */
export interface AnswerRecord {
  readonly kind: 'answer';
  /** The question's fact id: the node the answer closes. */
  readonly subject: string;
  /** The person's answer, Markdown, as written. */
  readonly text: string;
  /** Who answered, as the wiki records them. */
  readonly by: string;
  /** When it was answered, as the writer wrote it (ISO 8601, seconds). */
  readonly at: string;
  /** The file that holds it, relative to the product's folder (`answers/<digest>.md`). */
  readonly file: string;
}

/** The acceptance or rejection a person recorded about a page. */
export interface AcceptanceRecord {
  readonly kind: 'acceptance';
  /** The page's node, by fact id. */
  readonly subject: string;
  readonly verdict: Verdict;
  /** The person's note, Markdown, as written; empty when they wrote none. */
  readonly note: string;
  readonly by: string;
  readonly at: string;
  readonly file: string;
}

/** One decision the product's git holds. */
export type DecisionRecord = AnswerRecord | AcceptanceRecord;

/** One problem found in a decision document, named where it stands. */
export interface DecisionProblem {
  /** The full path of the file, as the reader was given it. */
  readonly file: string;
  /** The 1-based line the problem stands at. */
  readonly line: number;
  readonly message: string;
}

/** What reading the product's decision documents gave. */
export interface DecisionsRead {
  readonly records: readonly DecisionRecord[];
  readonly problems: readonly DecisionProblem[];
}

/** The heading an answer document opens with. */
export const ANSWER_HEADING = '# Answer';

/** The heading an acceptance document opens with. */
export const ACCEPTANCE_HEADING = '# Acceptance';

/** The fields an answer document names, in the order it writes them. */
export const ANSWER_FIELDS = ['Question', 'Decided', 'By'] as const;

/** The fields an acceptance document names, in the order it writes them. */
export const ACCEPTANCE_FIELDS = ['Page', 'Verdict', 'Decided', 'By'] as const;

/** The heading the question stands under in an answer, for a reader of the decision. */
const QUESTION_HEADING = '## Question';

/** The headings the person's words stand under, one per document. */
export const WORDS_HEADING = { answer: '## Answer', acceptance: '## Note' } as const;

/** The heading an acceptance's words stand under. */
const NOTE_HEADING = WORDS_HEADING.acceptance;

/** The fact id shape a document names (`src/fill/facts.ts`): the kind, a colon and 64 lower-case hexadecimal digits. */
const FACT_ID_SHAPE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*:[0-9a-f]{64}$/;

/** The moment a document names: ISO 8601 to the second, in UTC, as `toISOString` writes it without milliseconds. */
const MOMENT_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** The file one node's decision stands in, under its folder: the fact id's digest, so no colon and no machine path. */
export function decisionFile(folder: string, subject: string): string {
  if (FACT_ID_SHAPE.test(subject) === false) throw new Error(`src/fill/decisions.ts: the decision of ${JSON.stringify(subject)} has no file: a decision is about a node of the graph, named by its fact id`);
  return `${folder}/${subject.slice(subject.indexOf(':') + 1)}.md`;
}

/** One answer document's text, as the wiki writes it: the heading, the fields, the question echoed, and the answer. */
export function answerDocument(input: { readonly subject: string; readonly prompt: string; readonly text: string; readonly by: string; readonly at: string }): string {
  return [
    `${ANSWER_HEADING}: ${oneLine(input.prompt)}`,
    '',
    `Question: ${input.subject}`,
    `Decided: ${input.at}`,
    `By: ${oneLine(input.by)}`,
    '',
    QUESTION_HEADING,
    '',
    input.prompt.trim(),
    '',
    WORDS_HEADING.answer,
    '',
    input.text.trim(),
    '',
  ].join('\n');
}

/** One acceptance document's text: the heading, the fields, and the person's note. */
export function acceptanceDocument(input: { readonly subject: string; readonly label: string; readonly verdict: Verdict; readonly note: string; readonly by: string; readonly at: string }): string {
  return [
    `${ACCEPTANCE_HEADING}: ${oneLine(input.label)}`,
    '',
    `Page: ${input.subject}`,
    `Verdict: ${input.verdict}`,
    `Decided: ${input.at}`,
    `By: ${oneLine(input.by)}`,
    '',
    WORDS_HEADING.acceptance,
    '',
    input.note.trim(),
    '',
  ].join('\n');
}

/** A heading's title on one line: a label or a prompt is shown whole, and a line break inside it is a space. */
function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

/** One document read: the record it holds, or the problems that stop it being one. */
export type DecisionRead =
  | { readonly ok: true; readonly record: DecisionRecord }
  | { readonly ok: false; readonly problems: readonly DecisionProblem[] };

/**
 * One decision document, read as the record it holds. The first heading decides which
 * of the two documents it is (an answer names a `Question`, an acceptance a `Page` and
 * a `Verdict`), every field is read once and in its own name, and the words under the
 * words' heading are the person's Markdown unchanged — a section of the person's own
 * (`## Why` inside an answer) is their text and not the document's.
 */
export function parseDecisionDocument(file: string, text: string, relative: string): DecisionRead {
  const problems: DecisionProblem[] = [];
  const lines = text.split('\n');
  // The fields stand in the document's header, before the first section heading: a line of the person's own Markdown
  // that happens to start `Question:` or `Page:` is their text (a note reading "Page: 12" is an ordinary sentence),
  // and a heading of theirs inside their answer is their text as well.
  const headingAt = lines.findIndex((line) => /^##\s/.test(line.trim()));
  const header = headingAt < 0 ? lines : lines.slice(0, headingAt);
  const field = (name: string): { readonly value: string; readonly line: number } | undefined => {
    let found: { value: string; line: number } | undefined;
    for (const [index, line] of header.entries()) {
      const at = line.match(new RegExp(`^${name}:\\s?(.*)$`));
      if (at === null) continue;
      if (found !== undefined) {
        problems.push({ file, line: index + 1, message: `"${name}" is named twice: a decision document names each of its fields once` });
        continue;
      }
      found = { value: at[1]!.trim(), line: index + 1 };
    }
    return found;
  };
  const first = lines.findIndex((line) => line.trim() !== '');
  const heading = first < 0 ? '' : lines[first]!.trim();
  const isAnswer = heading.startsWith(ANSWER_HEADING);
  const isAcceptance = heading.startsWith(ACCEPTANCE_HEADING);
  if (isAnswer === false && isAcceptance === false) {
    return { ok: false, problems: [{ file, line: first < 0 ? 1 : first + 1, message: `a decision document opens with "${ANSWER_HEADING}: <the question>" or "${ACCEPTANCE_HEADING}: <the page>", not ${JSON.stringify(heading)}` }] };
  }
  if (isAnswer) {
    const question = field('Question');
    const decided = field('Decided');
    const by = field('By');
    if (question === undefined) problems.push({ file, line: first + 1, message: 'an answer names the question it closes, in a "Question: <fact id>" line' });
    else if (FACT_ID_SHAPE.test(question.value) === false) problems.push({ file, line: question.line, message: `"Question" names ${JSON.stringify(question.value)}, which is no fact id: a question is named by its own fact id, a kind, a colon and 64 lower-case hexadecimal digits` });
    if (decided === undefined) problems.push({ file, line: first + 1, message: 'an answer says when it was taken, in a "Decided: <ISO 8601 moment>" line' });
    else if (MOMENT_SHAPE.test(decided.value) === false) problems.push({ file, line: decided.line, message: `"Decided" names ${JSON.stringify(decided.value)}, which is no moment: a decision is dated as 2026-10-20T07:09:19Z` });
    if (by === undefined || by.value === '') problems.push({ file, line: first + 1, message: 'an answer says who wrote it, in a "By: <who>" line' });
    const words = section(lines, WORDS_HEADING.answer, [QUESTION_HEADING, WORDS_HEADING.answer]);
    if (words === undefined) problems.push({ file, line: first + 1, message: `an answer carries the person's words under "${WORDS_HEADING.answer}"` });
    else if (words.text.trim() === '') problems.push({ file, line: words.line, message: `the person's answer stands under "${WORDS_HEADING.answer}" and is empty: an empty answer closes nothing` });
    if (problems.length > 0) return { ok: false, problems };
    return { ok: true, record: { kind: 'answer', subject: question!.value, text: words!.text.trim(), by: by!.value, at: decided!.value, file: relative } };
  }
  const page = field('Page');
  const verdict = field('Verdict');
  const decided = field('Decided');
  const by = field('By');
  if (page === undefined) problems.push({ file, line: first + 1, message: 'an acceptance names the page it decides about, in a "Page: <fact id>" line' });
  else if (FACT_ID_SHAPE.test(page.value) === false) problems.push({ file, line: page.line, message: `"Page" names ${JSON.stringify(page.value)}, which is no fact id: a page is named by its node's own fact id` });
  if (verdict === undefined) problems.push({ file, line: first + 1, message: `an acceptance says what was decided, in a "Verdict: ${VERDICTS.join('|')}" line` });
  else if ((VERDICTS as readonly string[]).includes(verdict.value) === false) problems.push({ file, line: verdict.line, message: `"Verdict" is ${JSON.stringify(verdict.value)}: a person accepts a page or rejects it, so the verdict is one of ${VERDICTS.join(', ')}` });
  if (decided === undefined) problems.push({ file, line: first + 1, message: 'an acceptance says when it was taken, in a "Decided: <ISO 8601 moment>" line' });
  else if (MOMENT_SHAPE.test(decided.value) === false) problems.push({ file, line: decided.line, message: `"Decided" names ${JSON.stringify(decided.value)}, which is no moment: a decision is dated as 2026-10-20T07:09:19Z` });
  if (by === undefined || by.value === '') problems.push({ file, line: first + 1, message: 'an acceptance says who took it, in a "By: <who>" line' });
  const words = section(lines, WORDS_HEADING.acceptance, [NOTE_HEADING, WORDS_HEADING.acceptance]);
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, record: { kind: 'acceptance', subject: page!.value, verdict: verdict!.value as Verdict, note: words?.text.trim() ?? '', by: by!.value, at: decided!.value, file: relative } };
}

/**
 * The text under one of the document's own headings, to the next one of them.
 *
 * A person's answer is Markdown, and a heading of their own (`## Why`) is their text and
 * not the document's: only the headings this module declares delimit a section, and a
 * first-level heading ends the document. The rule is the set's own (`parseQuestion`,
 * `src/product-wiki/questions.ts`): "Markdown answers may contain their own headings; only
 * the configured headings delimit the record's sections."
 */
function section(lines: readonly string[], heading: string, declared: readonly string[]): { readonly text: string; readonly line: number } | undefined {
  const at = lines.findIndex((line) => line.trim() === heading);
  if (at < 0) return undefined;
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const trimmed = line.trim();
    if (/^#\s/.test(trimmed)) break;
    if (declared.some((other) => other !== heading && trimmed === other)) break;
    body.push(line);
  }
  return { text: body.join('\n').replace(/^\n+/, ''), line: at + 1 };
}

/**
 * Every decision the product's git holds: both folders, each file read as the record it
 * declares, in code point order of its path. A folder that does not exist holds none —
 * a product whose questions nobody answered yet. A file that is no decision document is
 * a problem with its own path and line and never a record: the caller reports it.
 */
export function readDecisions(productFolder: string): DecisionsRead {
  const root = resolve(productFolder);
  const records: DecisionRecord[] = [];
  const problems: DecisionProblem[] = [];
  for (const folder of [ANSWERS_FOLDER, ACCEPTANCES_FOLDER]) {
    const held = join(root, folder);
    if (existsSync(held) === false) continue;
    for (const name of readdirSync(held).sort()) {
      if (name.endsWith('.md') === false) {
        problems.push({ file: join(held, name), line: 1, message: `the ${folder} folder holds only decision documents, one "<the node's digest>.md" per decision: ${JSON.stringify(name)} is not one` });
        continue;
      }
      const file = join(held, name);
      const read = parseDecisionDocument(file, readFileSync(file, 'utf8'), `${folder}/${name}`);
      if (read.ok) records.push(read.record);
      else problems.push(...read.problems);
    }
  }
  return { records: [...records].sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0)), problems: [...problems].sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : left.line - right.line)) };
}

/**
 * One decision document written but not yet in place: the text stands in a temporary file
 * beside its path, and the decision stands — its earlier version included — exactly as it
 * was until `commitDecision` moves it over.
 *
 * The two steps are what keeps a decision in both places or in neither: a person's answer
 * is a record the product's git already holds, and a graph write that fails must not have
 * destroyed the earlier answer's document. The graph write runs between the two.
 */
export interface StagedDecision {
  /** The path the record names, relative to the product's folder (`answers/<digest>.md`). */
  readonly file: string;
  /** The temporary file the text stands in until the decision is committed. */
  readonly temporary: string;
}

/** Writes one decision document beside its path, ready to be committed: the text is whole on disk or not at all. */
export function stageDecision(productFolder: string, folder: string, subject: string, text: string): StagedDecision {
  const root = resolve(productFolder);
  const relative = decisionFile(folder, subject);
  const absolute = join(root, relative);
  mkdirSync(join(root, folder), { recursive: true });
  // The staged file's name is one decision's own: two decisions about one node staged in one process must never share
  // a temporary file, or the first commit would rename the second's words into place.
  const temporary = `${absolute}.${String(process.pid)}.${String(stageSequence()).padStart(6, '0')}.tmp`;
  writeFileSync(temporary, text, { flag: 'w', mode: 0o644 });
  return { file: relative, temporary };
}

/** Counts the staged decisions of this process, so no two of them share a temporary file. */
let stagedCount = 0;
function stageSequence(): number {
  stagedCount += 1;
  return stagedCount;
}

/** Puts one staged decision in its place: the earlier document at that path is replaced whole, in one rename. */
export function commitDecision(productFolder: string, staged: StagedDecision): string {
  renameSync(staged.temporary, join(resolve(productFolder), staged.file));
  return staged.file;
}

/**
 * Drops one staged decision, leaving the document already at its path as it was: a graph
 * write that was refused or failed writes nothing into the product's git, and the decision
 * a person took earlier stands.
 */
export function discardDecision(staged: StagedDecision): void {
  if (existsSync(staged.temporary)) rmSync(staged.temporary);
}

/** Writes one decision document whole, in one step, for a caller that has nothing else to keep in step with it. */
export function writeDecision(productFolder: string, folder: string, subject: string, text: string): string {
  return commitDecision(productFolder, stageDecision(productFolder, folder, subject, text));
}
