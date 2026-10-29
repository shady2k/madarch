/**
 * What a unit that edits a page is told (madarch-m38l.7): the page as it
 * stands and what changed since it was written. The refresh does not ask an
 * agent to write a page again from the graph; it asks it to edit the page it
 * wrote, keeping every sentence whose grounds did not change. This module
 * holds the shapes the planner fills and the text the prompt carries.
 */
import type { Side } from '../loop/entities.js';

export type ChangeNote =
  | {
      readonly kind: 'ground-changed' | 'ground-removed';
      /** The statement's name on the page and its sentence. */
      readonly statement: string;
      readonly sentence: string;
      readonly ground: string;
      /** The ground's text when the page was written and now: a section's text, or a diff of the file; null when there is none. */
      readonly before: string | null;
      readonly after: string | null;
    }
  | { readonly kind: 'answer'; readonly question: string; readonly title: string; readonly answer: string; readonly by: string; readonly at: string; readonly sides: readonly Side[] }
  | { readonly kind: 'correction'; readonly correction: string; readonly statement: string; readonly sentence: string; readonly reason: string; readonly by: string }
  /**
   * A person planned this change and confirmed the task it became (madarch-m38l.14): the grounds it stands on and the
   * sentences of this page that stand on them are exactly what the agent was told to change.
   */
  | { readonly kind: 'task'; readonly task: string; readonly title: string; readonly grounds: readonly string[]; readonly statements: readonly { readonly name: string; readonly sentence: string }[] }
  | { readonly kind: 'new-service'; readonly services: readonly string[] }
  | { readonly kind: 'language'; readonly from: string | null; readonly to: string }
  | { readonly kind: 'missing' };

export interface EditBrief {
  /** The page as it stands; null when there is none (the page is new). */
  readonly current: string | null;
  readonly notes: readonly ChangeNote[];
  /** Changes the brief does not carry because the bound was reached: told to the agent, never hidden. */
  readonly omitted: number;
}

/** The most characters of one ground's text, and of the whole list of changes, a prompt carries. */
export const NOTE_CHARACTERS = 3000;
export const NOTES_CHARACTERS = 30_000;

const cut = (text: string, most = NOTE_CHARACTERS): string => (text.length > most ? `${text.slice(0, most)}\n[cut at ${most} characters]` : text);
const fenced = (text: string): string => `~~~\n${cut(text).replace(/^~~~/gm, '~ ~~')}\n~~~`;

function noteText(note: ChangeNote): string[] {
  switch (note.kind) {
    case 'ground-changed':
      return [
        `- The ground ${note.ground} CHANGED. The statement [^${note.statement}] stands on it: "${note.sentence}"`,
        ...(note.before === null ? [] : ['  Before:', fenced(note.before)]),
        ...(note.after === null ? [] : ['  Now:', fenced(note.after)]),
      ];
    case 'ground-removed':
      return [`- The ground ${note.ground} is GONE from the code or the documents. The statement [^${note.statement}] stands on it: "${note.sentence}"`, ...(note.before === null ? [] : ['  It read:', fenced(note.before)])];
    case 'answer':
      return [
        `- A person ANSWERED your question "${note.title}" (madarch:question:${note.question}), ${note.by}, ${note.at}, local, not verified:`,
        fenced(note.answer),
        ...(note.sides.length === 0 ? [] : ['  The sides you recorded were:', ...note.sides.map((side) => `  - ${side.claim} (${side.grounds.join(', ')})`)]),
      ];
    case 'correction':
      return [`- A person CORRECTED the statement [^${note.statement}] (madarch:correction:${note.correction}), ${note.by}: "${note.sentence}" is wrong, because:`, fenced(note.reason)];
    case 'task':
      return [
        `- A person PLANNED this change and confirmed the task (madarch:task:${note.task}): "${note.title}".`,
        `  Its grounds: ${note.grounds.join(', ')}.`,
        ...(note.statements.length === 0
          ? ['  No sentence of this page stands on those grounds: check whether the page still says what they say.']
          : ['  The sentences of this page that stand on them, and that change because of this task:', ...note.statements.map((statement) => `  - [^${statement.name}]: "${statement.sentence}"`)]),
      ];
    case 'new-service':
      return [`- The graph has ${note.services.length === 1 ? 'a service' : 'services'} no page names yet: ${note.services.join(', ')}. Look at ${note.services.length === 1 ? 'it' : 'them'} and say what the page now lacks.`];
    case 'language':
      return [`- The pages are now written in ${note.to}${note.from === null ? '' : `, not ${note.from}`}: translate this page.`];
    case 'missing':
      return ['- This page does not exist yet.'];
  }
}

/** The notes a prompt carries within its budget, in order: what the agent is told is what may be marked as used. */
export function includedNotes(brief: EditBrief): ChangeNote[] {
  const out: ChangeNote[] = [];
  let used = 0;
  for (const note of brief.notes) {
    const length = noteText(note).join('\n').length;
    if (used + length > NOTES_CHARACTERS) continue;
    used += length;
    out.push(note);
  }
  return out;
}

/** The part of a unit's prompt that makes it an edit. Deterministic: the same brief is the same text. */
export function editPart(brief: EditBrief, languageName: string, writesFields = false): string[] {
  const translate = brief.notes.some((note) => note.kind === 'language');
  const lines: string[] = [];
  if (brief.current !== null) {
    lines.push(
      '## You are editing a page that exists',
      translate
        ? `The page below was written earlier in another language. Translate it into ${languageName}, sentence for sentence. Keep every footnote name, every footnote line (the grounds) and every link target exactly as they are: only the words change. Add nothing and drop nothing, except what a change below tells you.`
        : 'The page below was written earlier. Do not write it again from the graph: edit it.',
      '- Keep word for word every sentence, and its footnote name, whose grounds are not named in the changes below. Do not reword, reorder or improve them; a sentence you keep keeps its name.',
      '- A statement on a CHANGED ground: read the ground again (read_file, get_node) and make the sentence say what the ground says now. Keep its footnote name when it is still the same statement.',
      '- A statement on a ground that is GONE: re-ground it on something that still exists, or drop it. Never leave a ground that does not resolve.',
      '- A person\'s ANSWER settles your question: state the answer on the page as fact, in a sentence of its own, and ground it on `madarch:question:<slug>` together with the grounds the sources give. Do not ask that question again.',
      '- A person\'s CORRECTION says a statement is wrong: change or remove the sentence so the page no longer says what the person showed to be wrong, and ground the fix on `madarch:correction:<slug>` together with what supports it.',
      '- Add what is new, in the place a reader looks for it, with grounds.',
      // A unit whose page the core writes (a domain page, an enrichment with sections) answers with its fields:
      // there is no Markdown for it to write, and the sentences it keeps keep their words.
      writesFields ? '- Answer write_page with the fields of the page, changed where the changes below say: a sentence you keep keeps its words, and the core writes the page.' : '- Write the whole edited page with write_page.',
      '',
    );
  }
  if (brief.current === null && brief.notes.some((note) => note.kind === 'correction')) {
    lines.push('## Retained corrections for this new page',
      'The earlier page was removed, but these human corrections remain. Do not recreate the statements they corrected. Apply each correction and ground the corrected sentence on `madarch:correction:<slug>` together with its supporting sources.', '');
  }
  if (brief.notes.length > 0) {
    lines.push('## What changed since the page was written');
    const shown = includedNotes(brief);
    const omitted = brief.omitted + (brief.notes.length - shown.length);
    for (const note of shown) lines.push(noteText(note).join('\n'));
    if (omitted > 0) lines.push(`(${omitted} more change${omitted === 1 ? '' : 's'} not listed here, to keep this prompt bounded: check the page's other statements against the graph before you keep them.)`);
    lines.push('');
  }
  if (brief.current !== null) lines.push('## The page as it stands', '', brief.current.trimEnd(), '');
  return lines;
}
