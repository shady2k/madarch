/**
 * The narrative page's own text (decision 0026, "Pages"; madarch-tzte.25.1): the
 * deterministic form of the Markdown a page's narrative stands in, shared by the
 * one writer of it and every reader.
 *
 * 0026: "Narrative text is a second layer written by agent units in order of
 * importance, each sentence tied to fact or claim ids, stored as Markdown in the
 * product's git with status proposed." The fact of the kind `narrative`
 * (`src/fill/facts.ts`) carries the sentences and their ties; this module renders
 * them to the page's bytes — the front matter that says what the page is about and
 * that it is a proposal, and one line a sentence, each ending with the comment that
 * names the facts the sentence stands on. The file is the product's git's own copy
 * of the page; the fact is the graph's record of it, and a reader compares the two
 * by the bytes this module renders.
 *
 * Nothing here reads a clock, a file or a network: the bytes are a pure function of
 * the fact's value, so the same page renders the same on every machine.
 */
import { createHash } from 'node:crypto';
import { byCodePoint } from '../model/order.js';
import { FACT_ID_PATTERN, NARRATIVE_SENTENCE_BOUND, repositoryPath, type NarrativeSentence, type NarrativeValue, type RepositoryPath } from './facts.js';

/** The folder of the product repository a page's file stands under. */
export const NARRATIVE_PAGE_DIR = 'docs/graph';

/** The writer a page's front matter names: the fill's own agent, so a person's edit of the same file tells itself apart from one the fill wrote. */
export const NARRATIVE_PAGE_WRITER = 'madarch-fill-agent';

/** The status a page carries until a person accepts or rejects it (0005; self-filling's outcome 4). */
export const NARRATIVE_PAGE_STATUS = 'proposed';

/** How many code points one sentence may hold: the schema's own bound (`src/fill/facts.ts`). */
export const NARRATIVE_SENTENCE_CODE_POINTS = NARRATIVE_SENTENCE_BOUND;

/**
 * The path a page's file stands at in the product repository, from the node the
 * page is about: `docs/graph/<kind>-<digest>.md`. The node's id is `kind:digest`,
 * and a repository path carries no colon, so the leg joins them with a dash — one
 * deterministic path per node, the same on every machine, so a reader finds a
 * page's file without asking the graph where it stands.
 */
export function narrativePagePath(about: string): RepositoryPath {
  const at = about.indexOf(':');
  const kind = at < 0 ? '' : about.slice(0, at);
  const digest = at < 0 ? '' : about.slice(at + 1);
  if (kind === '' || digest === '' || !FACT_ID_PATTERN.test(about)) {
    raise(`"${about}" is no fact id: a narrative page's path is made from the id of the node the page is about`);
  }
  return repositoryPath(`${NARRATIVE_PAGE_DIR}/${kind}-${digest}.md`);
}

/** The words one sentence stands behind as the page's comment spells them: `<!-- facts: <id> <id> -->`. */
function factsComment(facts: readonly string[]): string {
  return `<!-- facts: ${[...facts].sort(byCodePoint).join(' ')} -->`;
}

/** The bytes one page's file holds: the front matter, then one sentence a paragraph, each with the facts it stands on. */
export function renderNarrativePage(value: NarrativeValue): string {
  const lines = [
    '---',
    `about: "${value.about}"`,
    `status: ${NARRATIVE_PAGE_STATUS}`,
    `writer: ${NARRATIVE_PAGE_WRITER}`,
    '---',
    '',
  ];
  for (const sentence of value.sentences) {
    lines.push(sentence.text, '', factsComment(sentence.facts), '');
  }
  return `${lines.join('\n')}\n`;
}

/** The digest of one page's bytes, as the fact's reader compares a file against the page it proposes: lower-case SHA-256. */
export function narrativeDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** What reading a page's file ended in: the page it holds, or why it is no page of the fill's. */
export type NarrativePageRead =
  | { readonly ok: true; readonly about: string; readonly status: string; readonly writer: string; readonly sentences: readonly NarrativeSentence[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Reads one page's file the way the materializer and a reader of the product's git
 * do: the front matter names what the page is about, its status and its writer, and
 * every comment line carries the sentence before it back to the facts it stands on.
 * A file a person wrote — no front matter, or another writer's name — reads as not
 * the fill's, which is what keeps the materializer from ever writing over it.
 */
export function parseNarrativePage(markdown: string): NarrativePageRead {
  const lines = markdown.split('\n');
  if (lines[0]?.trim() !== '---') return { ok: false, reason: 'the file holds no front matter: a page of the fill names what it is about, its status and its writer' };
  const end = lines.indexOf('---', 1);
  if (end < 0) return { ok: false, reason: 'the front matter is not closed: a page of the fill names what it is about, its status and its writer' };
  const front: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const at = line.indexOf(':');
    if (at <= 0) return { ok: false, reason: `the front matter line ${JSON.stringify(line)} names no field: a page's front matter is one field a line` };
    front[line.slice(0, at).trim()] = line.slice(at + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  const about = front['about'] ?? '';
  const status = front['status'] ?? '';
  const writer = front['writer'] ?? '';
  if (!FACT_ID_PATTERN.test(about)) return { ok: false, reason: `the front matter names ${JSON.stringify(about)} as the page's node, which is no fact id` };
  const sentences: NarrativeSentence[] = [];
  let text: string | undefined;
  for (const line of lines.slice(end + 1)) {
    const marker = line.match(/^<!-- facts: (.+) -->$/);
    if (marker === null) {
      if (line.trim() === '') continue;
      text = line;
      continue;
    }
    if (text === undefined) return { ok: false, reason: `a facts comment (${line.trim()}) stands under no sentence: a page's comment names the sentence before it` };
    const facts = marker[1]!.split(/\s+/).filter((id) => id !== '');
    for (const id of facts) {
      if (!FACT_ID_PATTERN.test(id)) return { ok: false, reason: `a sentence of the page names ${JSON.stringify(id)}, which is no fact id` };
    }
    sentences.push({ text, facts: [...new Set(facts)].sort(byCodePoint) });
    text = undefined;
  }
  if (sentences.length === 0) return { ok: false, reason: 'the file holds no sentence: a page of the fill carries at least one sentence tied to its facts' };
  return { ok: true, about, status, writer, sentences };
}

/** One refusal, with the words of the check that made it. */
function raise(message: string): never {
  throw new Error(`narrative-page: ${message}`);
}
