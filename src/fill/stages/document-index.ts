/**
 * Stage 6 of the fill (decision 0026): the document index. It writes what the
 * Markdown documents of the pinned repositories hold — one `document` node per
 * document (its media type, its title where it carries one, the bytes it spans
 * and the blob its bytes stand under), one `section` node per heading (its
 * anchor, its heading, its depth, the lines it covers and the bytes it spans),
 * one `document-link` edge per link end a section names (to another document, to
 * a code path, to an address outside the repositories, or unresolved with the
 * place the link stands at), one `task-key` edge per task key a document names,
 * and one `coverage` node saying what the read could not read.
 *
 * **The bytes come through the snapshot reader** (stage 0, madarch-tzte.21.1):
 * a unit opens its repository's reader and reads its own document's bytes there,
 * so every fact names the pinned commit and none names a checkout. Nothing here
 * runs git, touches a working tree or knows a machine path.
 *
 * **A unit is one document**, named `document:<repository>:<path>` over the
 * scope `<repository>:<path>` — the inventory's own shape. That is the
 * granularity incrementality needs: a commit that changes one document's bytes
 * moves that document's unit and no other, and a document it did not change is
 * not re-planned (0026). The plan makes one tracked read per repository — a JSON
 * document naming the read and the repository (`publishedDocumentsRead`) — and
 * the graph answers the `document` facts it already holds for it: a document
 * whose blob moved or that is new is planned, and a published path the pinned
 * commit no longer holds (or no longer holds as Markdown) is planned to publish
 * nothing, which is how a rename or a deletion is retracted. A graph that
 * answers nothing plans every document, which is what a first run is.
 *
 * **What a document is.** A Markdown document is a file the tree holds at the
 * pinned commit whose name ends in `.md`, `.markdown` or `.mdx` (`text/markdown`
 * and `text/mdx`: the stage reads the two as the same Markdown and writes the
 * media type the name names). A symbolic link whose name looks like one is not
 * read as a document: its bytes are the path it points at, which is no document,
 * and the inventory's `file` fact is where the graph holds it. No other document
 * form is this stage's: the DONE WHEN names the Markdown documents, and a
 * `.txt`, a `.rst` or a `LICENSE` is stage 1's file with the `document` role.
 *
 * **What a reader of the page sees.** A line inside a fenced code block or
 * inside an HTML comment is an example, not content, and neither opens a section
 * nor holds a link or a task key. An inline code span's content is not read
 * either: the spans' backticks are masked before a line's links and task keys
 * are read, so a link written inside one is no link of the document. The marking
 * is the wiki's own (`src/product-wiki/documents.ts` reads a product page's body
 * the same way), and a link's target is resolved by the wiki's own resolver: a
 * relative path is read from the document's folder (`.` kept, `..` popping,
 * climbing out refused), a target with a scheme is an address outside the
 * repositories, a fragment names a section of the document the link stands in,
 * and a path the pinned commit does not hold is written unresolved with the
 * place the link stands at, never dropped. What the resolver refuses — an
 * absolute target, a scheme-relative one, a folder, where the graph holds no
 * file at that path — is written unresolved as well, with its place.
 *
 * **A document's id is its repository and its path**, so a link to another
 * document names the node that document's own unit writes: a Markdown target is
 * the `document` node, any other file the `file` node stage 1 published, and a
 * fragment of the linking document a `section` node this unit writes itself. An
 * edge is folded by what its own identity names — the node it stands in and the
 * end (a link) or the key (a task key) — so the same end named twice under one
 * section is one edge, written at the first place, and the same end named under
 * two sections is two edges, each at its place.
 *
 * **A heading's anchor** is the one a reader's link names: the heading's words as
 * a reader sees them (an inline link's label, a code span's content), lower
 * cased, every character that is not a letter, a digit, a space, `-` or `_`
 * dropped, each run of whitespace one `-`, and — where a document repeats one —
 * `-1`, `-2`, … appended, so every section of a document has its own anchor,
 * which is what the section's identity needs. A heading whose words hold no
 * letter or digit names no anchor a link could name; it is not written as a
 * section and the unit's coverage names its place, so a shorter heading tree is
 * never silent.
 *
 * **Every error names what it is about**: a plan's refusal names the read, the
 * row's place and the field; a refusal of this module names what it was given —
 * the scope, and the repository name or the path that does not read — and a
 * draft's refusal names the write's place in the draft, what it cites and the
 * fact's own path and place.
 */
import { Type } from 'typebox';
import { byCodePoint } from '../../model/order.js';
import { ID_PATTERN } from '../../model/schema.js';
import { resolveBodyLink } from '../../product-wiki/documents.js';
import {
  type CoverageGap, type CoverageValue, FACT_KINDS, type Fact, type FactPlace, type FactRange,
  type FactTerm, factId, isRepositoryPath, makeEdgeFact, makeNodeFact, repositoryPath, type RepositoryPath,
} from '../facts.js';
import type { SnapshotEntry, SnapshotReader, SnapshotSource } from '../snapshot.js';
import {
  DEFAULT_STAGE_DEFAULTS, type FillStage, type StageContext, type StageDraftSet, type StageDraftWrite,
  type StageExecutionResult, type StageGraphReader, type StagePlan, type StageUnit, type StageValidation,
} from '../stage.js';
import { checkFactDraft, evidenceAt, provenanceOf } from './draft.js';
import { wholeFileRange } from './inventory.js';

/** The stage's id, as it is registered; decision 0026's stage 6, named by what it reads. */
export const DOCUMENT_INDEX_STAGE_ID = 'document-index';

/** The stage's own version, bumped when what it writes or plans changes. */
export const DOCUMENT_INDEX_STAGE_VERSION = 1;

/**
 * The fact kinds the stage produces, in code point order: what the read could
 * not read, the documents, the links they hold, their sections and the task keys
 * they name. `coverage` is the kind every stage of the fill reports in.
 */
export const DOCUMENT_INDEX_STAGE_KINDS: readonly string[] = ['coverage', 'document', 'document-link', 'section', 'task-key'];

/** The read the plan makes; the wiring answers it from the product graph. */
export const PUBLISHED_DOCUMENTS_READ = 'stage-6-published-documents';

/**
 * The one tracked read the plan makes: the `document` facts the graph already
 * holds for one repository's stage-6 index, with the blob each document's bytes
 * stand under. The text is a JSON document, so a wiring reads it as data and not
 * as prose: `{"read": "stage-6-published-documents", "repository": "<name>"}`.
 */
export function publishedDocumentsRead(repository: string): string {
  return JSON.stringify({ read: PUBLISHED_DOCUMENTS_READ, repository });
}

/** One row of that read: a `document` fact, as the graph holds it. */
export interface PublishedDocumentRow {
  readonly kind: 'document';
  readonly repository: string;
  readonly path: string;
  /** The blob the document's bytes stood under; absent where the fact was written before the field existed. */
  readonly blob?: string;
}

/** The keys a row of the read holds, and no others. */
const ROW_FIELDS: readonly string[] = ['blob', 'kind', 'path', 'repository'];

/** What the read answered, as the plan compares against it: each published document's blob. */
type PublishedDocuments = ReadonlyMap<string, string | undefined>;

/** The media type of each Markdown name the stage reads, by the name's extension. */
const MARKDOWN_MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.markdown': 'text/markdown',
  '.md': 'text/markdown',
  '.mdx': 'text/mdx',
};

/**
 * The media type of a document's name (`text/markdown`), or `undefined` where
 * the name is no Markdown. A name whose whole text is an extension (`.md`) is a
 * hidden file and no document, which is the inventory's own reading of a name's
 * extension (`extensionOf`: a dot at the name's first character starts no
 * extension).
 */
export function markdownMediaType(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const at = name.lastIndexOf('.');
  return at <= 0 ? undefined : MARKDOWN_MEDIA_TYPES[name.slice(at).toLowerCase()];
}

/** The unit id of one document: stable across runs, and never a run's own id. */
export function documentUnitId(repository: string, path: string): string {
  return `document:${repositoryName(repository)}:${repositoryPathValue(path, `the repository ${repository}`)}`;
}

/** The scope a document unit covers, as the run's wiring sees it: the repository and the path. */
export function documentScope(repository: string, path: string): string {
  return `${repositoryName(repository)}:${repositoryPathValue(path, `the repository ${repository}`)}`;
}

/** The scope one unit covers, read back: the repository a document stands in and the path it stands at. */
export interface DocumentPlace {
  readonly repository: string;
  readonly path: RepositoryPath;
}

/**
 * The repository and the path one unit's scope names, refused by name where it
 * is not that form: a unit this stage never plans is refused here rather than
 * read as a document of some other place.
 */
export function parseDocumentScope(scope: string): DocumentPlace {
  const at = typeof scope === 'string' ? scope.indexOf(':') : -1;
  const repository = at < 0 ? '' : scope.slice(0, at);
  const path = at < 0 ? '' : scope.slice(at + 1);
  const form = 'a document scope is "<repository>:<path>", naming the product\'s own name for the repository and a path from the repository\'s root';
  if (repository === '' || path === '') {
    throw new Error(`document-index: the scope ${JSON.stringify(scope)} names no repository and path: ${form}`);
  }
  return { repository: repositoryName(repository), path: repositoryPathValue(path, `the repository ${repository}`) };
}

/** The repository a fact may name: the product's own name for it, never a path, a URL or a branch. */
function repositoryName(repository: string): string {
  if (typeof repository !== 'string' || !ID_PATTERN.test(repository)) {
    throw new Error(`document-index: ${JSON.stringify(repository)} is no repository name: the product's own name for a repository, like "orders-api", never a path, a URL or a branch`);
  }
  return repository;
}

/** A repository path a fact may name, refused with what the path was read for. */
function repositoryPathValue(path: string, what: string): RepositoryPath {
  if (typeof path !== 'string' || !isRepositoryPath(path)) {
    throw new Error(`document-index: ${what} names the path ${JSON.stringify(path)}, which is no repository path: a path from the repository's root, "/"-separated, with no "." or ".." leg`);
  }
  return repositoryPath(path);
}

/** One documented line of a document: where its bytes stand and what a reader reads there. */
export interface DocumentLine {
  /** The 1-based line, as a reader counts lines. */
  readonly line: number;
  /** The offset of the line's first byte in the document's bytes. */
  readonly startByte: number;
  /** The offset just past the line's last byte: its newline, and a carriage return before one, are not part of it. */
  readonly endByte: number;
  /** The line's text, decoded as the snapshot reader's own `readText` decodes a file's bytes. */
  readonly text: string;
  /** False where the line is an example: inside a fence or an HTML comment, so no content of the document. */
  readonly content: boolean;
}

/**
 * The lines of a document's bytes, in order, each with the bytes it covers. The
 * bytes are split on the newline, and a carriage return before one is not part
 * of a line's text: a document written with CRLF reads as the same lines as one
 * written with LF, which is what a reader sees, and what the wiki's own reader
 * folds. The decoding is the reader's own — UTF-8, the byte order mark kept, as
 * `readText` reads a file's bytes — so this stage's reading of a document and a
 * stage 1 file's text do not disagree by a code unit.
 */
export function linesOfBytes(bytes: Uint8Array): DocumentLine[] {
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const lines: DocumentLine[] = [];
  let start = 0;
  let line = 1;
  for (let at = 0; at <= bytes.length; at += 1) {
    if (at < bytes.length && bytes[at] !== 0x0a) continue;
    // A carriage return is not part of a line's text only where a newline
    // follows it: that is the pair a CRLF document writes, and a lone carriage
    // return at the end of the buffer is a character of the last line.
    const end = at < bytes.length && at > start && bytes[at - 1] === 0x0d ? at - 1 : at;
    lines.push({ line, startByte: start, endByte: end, text: decoder.decode(bytes.subarray(start, end)), content: true });
    start = at + 1;
    line += 1;
  }
  return lines;
}

/** The lines' text, joined with the newline: the body a reader of the document reads. */
export function textOf(lines: readonly DocumentLine[]): string {
  return lines.map((line) => line.text).join('\n');
}

/** A fence's opening marker: the run of backticks or tildes that opens it, and what follows them. */
const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/u;

/**
 * The same lines with the examples marked: a line inside a fenced code block or
 * inside an HTML comment is no content of the document, and neither is the
 * fence's own opening or closing line. The marking is the wiki's own rule, so a
 * document reads the same whether the wiki shows it or the fill indexes it. One
 * thing it does not mark is an indented code block: a heading cannot hide in one
 * (its `#` stands within three spaces of the margin, which is what makes it a
 * heading at all), and the wiki reads a link written in one as a link too.
 */
export function markExamples(lines: readonly DocumentLine[]): DocumentLine[] {
  const marked: DocumentLine[] = [];
  let fence: { readonly character: string; readonly length: number } | undefined;
  let comment = false;
  for (const line of lines) {
    const mark = FENCE.exec(line.text);
    if (fence !== undefined) {
      marked.push({ ...line, content: false });
      const ticks = mark?.[1] ?? '';
      if (mark !== null && ticks[0] === fence.character && ticks.length >= fence.length && (mark[2] ?? '').trim() === '') fence = undefined;
      continue;
    }
    if (mark !== null) {
      marked.push({ ...line, content: false });
      fence = { character: (mark[1] ?? '`')[0] ?? '`', length: (mark[1] ?? '').length };
      continue;
    }
    if (comment || line.text.trimStart().startsWith('<!--')) {
      marked.push({ ...line, content: false });
      comment = !line.text.includes('-->');
      continue;
    }
    marked.push(line);
  }
  return marked;
}

/** One heading a document holds: the words a reader sees, its depth, and the line it stands on. */
export interface DocumentHeading {
  readonly line: number;
  /** The heading's depth, 1 for `#`. */
  readonly level: number;
  /** The heading's words as a reader sees them: its markers, an inline link's target and a code span's backticks are out. */
  readonly heading: string;
}

/** An ATX heading: one to six `#` at the margin (within three spaces), then its words. */
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/u;

/** The closing sequence a heading may carry: whitespace, then one or more `#` and nothing else. */
const HEADING_CLOSING = /[ \t]+#+$/u;

/**
 * One line's headings: an ATX heading whose `#` stand within three spaces of the
 * margin (four make a code block, which is no heading), with the closing
 * sequence of `#`s a writer may add removed. A `#` with no space after it is no
 * heading either (`#tag` is a word), which is the rule a reader's renderer
 * follows.
 */
export function headingsOf(lines: readonly DocumentLine[]): DocumentHeading[] {
  const headings: DocumentHeading[] = [];
  for (const line of lines) {
    if (!line.content) continue;
    const match = HEADING.exec(line.text);
    if (match === null) continue;
    const level = (match[1] ?? '').length;
    const written = (match[2] ?? '').replace(HEADING_CLOSING, '').trim();
    headings.push({ line: line.line, level, heading: visibleText(written) });
  }
  return headings;
}

/** An inline link or image, the wiki's own shape: a label, then the target in parentheses. */
const INLINE_LINK = /\[[^\]\n]*\]\(([^)\n]+)\)/gu;

/** An inline code span: a run of backticks, what it holds, and the run that closes it. */
const CODE_SPAN = /`+[^`]*`+/gu;

/** What a heading and a link's label read as a reader sees them: a code span's content, a link's label, no markers. */
export function visibleText(text: string): string {
  return text
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/gu, '$1')
    .replace(/`+([^`]*)`+/gu, '$1')
    .trim();
}

/** One link a line holds: the target exactly as the document wrote it, and the columns it covers. */
export interface LineLink {
  readonly target: string;
  readonly startColumn: number;
  readonly endColumn: number;
}

/**
 * The links one line holds: the wiki's own inline shape, read with the line's
 * code spans masked, so a link written inside one is no link — a link a reader
 * sees, and nothing else. The label's own target may reach over a line's end in
 * Markdown; this reads a line at a time, as the wiki's reader does, so such a
 * link reaches no reader here either.
 */
export function linksOf(line: DocumentLine): LineLink[] {
  if (!line.content) return [];
  const masked = line.text.replace(CODE_SPAN, (span) => ' '.repeat(span.length));
  const links: LineLink[] = [];
  for (const match of masked.matchAll(INLINE_LINK)) {
    const at = match.index ?? 0;
    links.push({ target: (match[1] ?? '').trim(), startColumn: at, endColumn: at + match[0].length });
  }
  return links;
}

/** One task key a line names: the key as written, and the columns it covers. */
export interface LineTaskKey {
  readonly key: string;
  readonly startColumn: number;
  readonly endColumn: number;
}

/** The marker a document writes a task key after: the tracker's own `Task:`, and the header's `Tasks:`. */
const TASK_KEY_MARKER = /\btasks?:/giu;

/** One token of a key list: the run of characters between the commas and the whitespace a reader splits on. */
const KEY_TOKEN = /[^\s,]+/gu;

/** What surrounds a key and is not part of it: a bracket, a quote, a sentence's full stop or comma. */
const SURROUNDING_PUNCTUATION = /^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/gu;

/**
 * The shape a tracker's id has, whole: a letter first (so a date, a version or a
 * number is no key), then one or more `-`- or `.`-separated parts of letters and
 * digits (`madarch-tzte.21.4`, `madarch-1xq`), and nothing else.
 */
const TRACKER_KEY = /^[A-Za-z][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)+$/u;

/**
 * The task keys one line names: after a `Task:` or `Tasks:` marker
 * (case-insensitive — the tracker's own rule for a commit message is `Task:`, and
 * the project's change records write the header `Tasks:`), the run of tokens
 * that read as a tracker's id, ending at the first token that does not. The
 * tracker's own reader splits a key list on commas and whitespace, so a key is a
 * whole token; a key a document writes in a sentence carries a full stop, a
 * comma or a bracket around it, which is not part of the key, and the run ends
 * at the first word of the sentence, which is what keeps a document's prose and
 * the file names further along the line out of the graph. A token is a key when
 * what remains of it is shaped as a tracker's id: a letter first, then one or
 * more `-`- or `.`-separated parts of letters and digits, and nothing else — so a
 * date, a time and a bare number are no keys. A token that opens a bracket ends
 * the run with them, since a bracket opens the sentence's own aside. The shape is
 * all the rule has: a hyphenated word inside the run reads as a key, since
 * nothing tells `release-notes` from `madarch-1xq`. Each key is written once per
 * line, at the columns it stands at.
 */
export function taskKeysOf(line: DocumentLine): LineTaskKey[] {
  if (!line.content) return [];
  const masked = line.text.replace(CODE_SPAN, (span) => ' '.repeat(span.length));
  const keys: LineTaskKey[] = [];
  const seen = new Set<string>();
  for (const marker of masked.matchAll(TASK_KEY_MARKER)) {
    const after = (marker.index ?? 0) + marker[0].length;
    const rest = masked.slice(after);
    for (const token of rest.matchAll(KEY_TOKEN)) {
      const raw = token[0];
      // The list ends at the first token that opens a bracket or is no key: a
      // key list is a run, and what follows it is the sentence the marker
      // stands in — a bracket opens that sentence's aside, and a word with no
      // separator is its prose.
      if (raw.startsWith('(') || raw.startsWith('[')) break;
      const bare = raw.replace(SURROUNDING_PUNCTUATION, '');
      if (!TRACKER_KEY.test(bare)) break;
      if (seen.has(bare)) continue;
      seen.add(bare);
      const start = after + (token.index ?? 0) + (raw.length - raw.replace(/^[^A-Za-z0-9]+/u, '').length);
      keys.push({ key: bare, startColumn: start, endColumn: start + bare.length });
    }
  }
  return keys.sort((left, right) => left.startColumn - right.startColumn);
}

/** The anchor one heading's words name: lower case, punctuation dropped, each run of whitespace one `-`. */
export function anchorOf(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/gu, '-')
    .replace(/^[-\s]+|[-\s]+$/gu, '');
}

// ---- planning ------------------------------------------------------------

/**
 * The units one run of the document index fills: a unit per Markdown document
 * whose blob moved at the pinned commit (or that is new), and a unit for a
 * published path the commit no longer holds as a Markdown document, which
 * publishes nothing and so retracts what an earlier run wrote there. The units
 * are in code point order of their ids, so two runs of one commit plan the same
 * units in the same order.
 */
async function planDocuments(sources: SnapshotSource, graph: StageGraphReader): Promise<StagePlan> {
  const pins = await sources.pins();
  const units: { id: string; scope: string }[] = [];
  let anyDocument = false;
  for (const pin of pins) {
    const reader = await sources.open(pin.id);
    const read = publishedDocumentsRead(pin.id);
    const published = publishedDocuments(await graph.query(read), pin.id, read);
    const standing = markdownEntriesOf(reader);
    // A tree whose every entry is unfiled held entries too: it is not a
    // repository that found nothing, and stage 0's coverage names the gap.
    anyDocument = anyDocument || standing.length > 0 || reader.unfiled().length > 0;
    const held = new Set(standing.map((entry) => String(entry.path)));
    for (const entry of standing) {
      if (published.get(entry.path) === entry.id) continue;
      units.push({ id: documentUnitId(pin.id, entry.path), scope: documentScope(pin.id, entry.path) });
    }
    for (const path of published.keys()) {
      if (held.has(path)) continue;
      units.push({ id: documentUnitId(pin.id, path), scope: documentScope(pin.id, path) });
    }
  }
  units.sort((left, right) => byCodePoint(left.id, right.id));
  return { units, coverage: anyDocument ? 'planned' : 'nothing-found' };
}

/**
 * The Markdown documents of one repository's pinned tree, in code point order of
 * their paths: the tree's entries whose bytes this repository holds and whose
 * name ends in a Markdown extension. A submodule's commit holds no bytes of this
 * repository and a symbolic link's bytes are the path it points at, so neither
 * is a document here.
 */
export function markdownEntriesOf(reader: SnapshotReader): SnapshotEntry[] {
  return reader.entries().filter((entry) => entry.form === 'blob' && markdownMediaType(String(entry.path)) !== undefined);
}

/**
 * The paths one reader's tree holds, and the Markdown documents among them,
 * worked out once per reader: the tree of a commit never changes, so a unit's
 * link lookup costs one map read instead of one walk of the whole tree, and a
 * repository of any size costs what it holds and not its square (0026 asks the
 * fill to be complete on any size). The reader is held by the source across a
 * run's units, so this is one walk and not one per document.
 */
export function treePathsOf(reader: SnapshotReader): { readonly held: ReadonlySet<string>; readonly markdown: ReadonlySet<string> } {
  const known = TREE_PATHS.get(reader);
  if (known !== undefined) return known;
  const paths = {
    held: new Set(reader.entries().map((entry) => String(entry.path))),
    markdown: new Set(markdownEntriesOf(reader).map((entry) => String(entry.path))),
  };
  TREE_PATHS.set(reader, paths);
  return paths;
}

/** One reader's own paths, as `treePathsOf` memoises them. */
const TREE_PATHS = new WeakMap<SnapshotReader, { readonly held: ReadonlySet<string>; readonly markdown: ReadonlySet<string> }>();

/**
 * The read's rows, read: each row names the repository it was read for, the
 * `document` kind and the path a document stands at, with the blob its bytes
 * stood under. A row that names another repository, another kind, a path that is
 * no repository path or a blob that is no blob id is refused, naming the read,
 * the row and what was wrong with it — a row read past would plan a wrong unit
 * in silence, and a row dropped would leave a stale fact behind.
 */
export function publishedDocuments(rows: readonly unknown[], repository: string, read: string): PublishedDocuments {
  const documents = new Map<string, string | undefined>();
  rows.forEach((row, index) => {
    const refuse = (detail: string): Error => new Error(`the read ${read} answered row ${index + 1} for the repository ${JSON.stringify(repository)}, and ${detail}`);
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw refuse(`${JSON.stringify(row)} is no row: a row is an object naming its kind, its repository, its path and the blob the document stood under`);
    }
    const held = row as Record<string, unknown>;
    if (held['kind'] !== 'document') {
      throw refuse(`its kind is ${JSON.stringify(held['kind'])}, and this stage holds "document"`);
    }
    if (held['repository'] !== repository) {
      throw refuse(`its repository is ${JSON.stringify(held['repository'])}, and the read was for ${JSON.stringify(repository)}: one read is one repository`);
    }
    const unknown = Object.keys(held).filter((key) => !ROW_FIELDS.includes(key)).sort(byCodePoint);
    if (unknown.length > 0) {
      throw refuse(`it holds ${unknown.map((key) => JSON.stringify(key)).join(', ')}, and a row holds ${ROW_FIELDS.join(', ')}: a run, a unit, an attempt or a session is none of them`);
    }
    const rawPath = held['path'];
    if (typeof rawPath !== 'string' || !isRepositoryPath(rawPath)) {
      throw refuse(`its path ${JSON.stringify(rawPath)} is no repository path: a path from the repository's root, "/"-separated, with no "." or ".." leg`);
    }
    const path = repositoryPath(rawPath);
    if (documents.has(path)) {
      throw refuse(`its path ${JSON.stringify(path)} stands in an earlier row of this answer: one read answers one row per path`);
    }
    const blob = held['blob'];
    if (blob !== undefined && (typeof blob !== 'string' || !/^[0-9a-f]{40}$/u.test(blob))) {
      throw refuse(`its blob ${JSON.stringify(blob)} is no blob id: 40 lower-case hexadecimal digits, or no blob at all`);
    }
    documents.set(path, typeof blob === 'string' ? blob : undefined);
  });
  return documents;
}

// ---- the facts one document's unit writes ---------------------------------

/** What one document's reading wrote: the facts, the sections it opened, and what it could not read. */
export interface DocumentReading {
  /** The facts, in the order the unit writes them: the document, its sections, its links, its task keys. */
  readonly facts: readonly Fact[];
  /** What the reading could not read, each with its reason, in code point order of what it names. */
  readonly gaps: readonly CoverageGap[];
  /** The document's own line span: what its unit's `coverage` fact stands at. */
  readonly range: FactRange;
  /** How many sections the document opened. */
  readonly sections: number;
  /** How many links the document holds: one edge per end and section, however many times it names it. */
  readonly links: number;
  /** How many task keys the document names. */
  readonly keys: number;
}

/** One section of a document, as the reading found it: what it is, where its lines stand and its node's fact id. */
interface ReadingSection {
  readonly anchor: string;
  /** The section fact's id: a link's fragment names the section it stands in by it. */
  readonly id: string;
  readonly range: FactRange;
}

/** The place one fact of a document stands at: the document's path, and the lines inside it. */
function placeAt(path: RepositoryPath, range: FactRange): FactPlace {
  return { file: path, range };
}

/**
 * What one document's bytes hold, read as its unit's facts: the document node
 * (its media type, its title where it has one, the bytes it spans and the blob
 * its bytes stand under), one section node per heading a reader sees, one
 * `document-link` edge per end a section names, and one `task-key` edge per key
 * it names. The order is the order above: the document, its sections as a reader
 * meets them, then the links and the keys in the order they stand. An edge is
 * folded by its identity (the section it stands in and the end), so one end named
 * twice under one section is one edge, at the first place.
 *
 * The anchors are the ones a reader's link names, each distinct within the
 * document. A heading whose words hold no anchor, and a link whose target names
 * a path the pinned commit does not hold (or one the fill reads as no path at
 * all), are not facts of a smaller reading: the heading is named in the gaps,
 * and the link is written unresolved with its place.
 */
export function readDocument(reader: SnapshotReader, path: RepositoryPath, bytes: Uint8Array): DocumentReading {
  const repository = reader.repository;
  const provenance = provenanceOf(reader);
  const lines = markExamples(linesOfBytes(bytes));
  const text = textOf(lines);
  const headings = headingsOf(lines);
  const sections: ReadingSection[] = [];
  const gaps: CoverageGap[] = [];
  const taken = new Set<string>();
  const facts: Fact[] = [];

  const title = titleOf(headings);
  const documentRange = wholeFileRange(text);
  const document = makeNodeFact({
    kind: 'document',
    value: {
      repository,
      path,
      mediaType: markdownMediaType(path) ?? 'text/markdown',
      bytes: bytes.length,
      blob: String(reader.requireEntry(path).id),
      ...(title === undefined ? {} : { title }),
    },
    provenance: { ...provenance, place: placeAt(path, documentRange) },
    layer: 'extracted',
  });
  facts.push(document);

  // The sections: the heading tree, in the order a reader meets the headings.
  // A section's lines run from its heading to the line before the next heading
  // at any depth, its trailing blank lines out; its bytes are those lines'.
  headings.forEach((heading, index) => {
    const anchor = anchorOf(heading.heading);
    if (anchor === '') {
      // A heading whose words hold no letter or digit names no anchor a link
      // could name: it opens no section, and the gap says where it stands.
      gaps.push({ what: `${path}:${heading.line}`, reason: 'unsupported' });
      return;
    }
    let unique = anchor;
    let suffix = 0;
    while (taken.has(unique)) {
      suffix += 1;
      unique = `${anchor}-${suffix}`;
    }
    taken.add(unique);
    const start = heading.line - 1;
    const bound = headings[index + 1] === undefined ? lines.length - 1 : (headings[index + 1] as DocumentHeading).line - 2;
    let end = start;
    for (let at = bound; at > start; at -= 1) {
      if ((lines[at] as DocumentLine).text.trim() !== '') {
        end = at;
        break;
      }
    }
    const first = lines[start] as DocumentLine;
    const last = lines[end] as DocumentLine;
    const range: FactRange = { startLine: heading.line, startColumn: 0, endLine: end + 1, endColumn: last.text.length };
    const section = makeNodeFact({
      kind: 'section',
      value: {
        repository,
        document: path,
        anchor: unique,
        heading: heading.heading,
        level: heading.level,
        startByte: first.startByte,
        endByte: last.endByte,
      },
      provenance: { ...provenance, place: placeAt(path, range) },
      layer: 'extracted',
    });
    sections.push({ anchor: unique, id: section.id, range });
    facts.push(section);
  });

  // The links: one edge per end and section, at the first place the document
  // names it, from the section the link stands in where a section holds its line.
  const { held, markdown } = treePathsOf(reader);
  // A link's identity is the node it stands in and the end it names: the same
  // end named twice in one section is one edge, and the same end named in two
  // sections is two — each at its own place.
  const linkEnds = new Set<string>();
  let links = 0;
  for (const line of lines) {
    for (const link of linksOf(line)) {
      const end = linkTerm(reader, path, link.target, held, markdown, sections);
      const from = sectionAt(sections, line.line) ?? document.id;
      const key = `${from}\u0000${JSON.stringify(end)}`;
      if (linkEnds.has(key)) continue;
      linkEnds.add(key);
      links += 1;
      facts.push(makeEdgeFact({
        kind: 'document-link',
        value: { from, to: end },
        provenance: { ...provenance, place: placeAt(path, { startLine: line.line, startColumn: link.startColumn, endLine: line.line, endColumn: link.endColumn }) },
        layer: 'extracted',
      }));
    }
  }

  // A task key's identity is the node it stands in and the key: the same key
  // named twice in one section is one edge, and in two sections two of them.
  const keyEnds = new Set<string>();
  let keys = 0;
  for (const line of lines) {
    for (const named of taskKeysOf(line)) {
      const from = sectionAt(sections, line.line) ?? document.id;
      const namedKey = `${from}\u0000${named.key}`;
      if (keyEnds.has(namedKey)) continue;
      keyEnds.add(namedKey);
      keys += 1;
      facts.push(makeEdgeFact({
        kind: 'task-key',
        value: { from, key: named.key },
        provenance: { ...provenance, place: placeAt(path, { startLine: line.line, startColumn: named.startColumn, endLine: line.line, endColumn: named.endColumn }) },
        layer: 'extracted',
      }));
    }
  }

  return { facts, gaps: documentGaps(gaps, repository, path), range: documentRange, sections: sections.length, links, keys };
}

/**
 * The document's title: the words of its first first-depth heading, where it has
 * one — the title a reader of the page sees. A document whose headings hold no
 * first-depth one carries no title, which is no loss of the document: its
 * sections say what it holds.
 */
function titleOf(headings: readonly DocumentHeading[]): string | undefined {
  const first = headings.find((heading) => heading.level === 1);
  return first === undefined || first.heading === '' ? undefined : first.heading;
}

/**
 * The node a link's end names, the address it writes, or the literal an
 * unresolved target is written as. A fragment names a section of the document
 * the link stands in (the section's own node); a target with a scheme is an
 * address outside the repositories, read as written; a target the wiki's own
 * resolver ties to a path the pinned commit holds names that path's node — the
 * `document` node where the path is a Markdown document, the `file` node stage 1
 * published for it otherwise. Everything else — a path the commit does not hold,
 * a folder, an absolute or scheme-relative target — is the target as the
 * document wrote it, which is how an unresolved link keeps its place instead of
 * being dropped.
 */
function linkTerm(
  reader: SnapshotReader,
  path: RepositoryPath,
  written: string,
  held: ReadonlySet<string>,
  markdown: ReadonlySet<string>,
  sections: readonly ReadingSection[],
): FactTerm {
  const literal = (): FactTerm => ({ form: 'literal', text: written });
  if (written === '') return literal();
  if (written.startsWith('#')) {
    // A reader's link names the anchor exactly as the page holds it: a fragment
    // is compared as written, so `#Requirement` reaches no section this stage
    // writes as `requirement` (a browser's own lookup of an `id` is exact too).
    const named = sections.find((section) => section.anchor === written.slice(1));
    return named === undefined ? literal() : { form: 'node', id: named.id };
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(written)) return { form: 'external', url: written };
  const resolved = resolveBodyLink(path, written, held);
  if (resolved === undefined) return literal();
  const entry = reader.entry(resolved);
  if (entry === undefined || entry.form === 'commit') return literal();
  return { form: 'node', id: pathNodeId(reader, markdown.has(resolved) ? 'document' : 'file', repositoryPath(resolved)) };
}

/**
 * The id of the node the graph holds for one path: stage 1's `file` node, or
 * this stage's `document` node. Its identity digests the repository and the path
 * and nothing else, so the id is the one the owning stage publishes — this unit
 * names it without writing it.
 */
export function pathNodeId(reader: SnapshotReader, kind: 'document' | 'file', path: RepositoryPath): string {
  const provenance = provenanceOf(reader);
  const repository = reader.repository;
  if (kind === 'document') return factId({ kind, value: { repository, path, mediaType: markdownMediaType(path) ?? 'text/markdown' }, provenance });
  // Only the identity's parts are read for the id (the repository and the path),
  // so the rest of the value is the smallest one the kind's own shape holds.
  return factId({ kind, value: { repository, path, roles: [] }, provenance });
}

/**
 * The section a line stands in: the one whose own lines hold it, where a section
 * does. `undefined` where none does (a line before the first heading, or a line
 * of the document's title block), and the caller then names the document.
 */
function sectionAt(sections: readonly ReadingSection[], line: number): string | undefined {
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const section = sections[index] as ReadingSection;
    if (line >= section.range.startLine && line <= section.range.endLine) return section.id;
  }
  return undefined;
}

/**
 * The gaps of one document's reading, in code point order of what they name,
 * each pair of a `what` and a reason once. The schema refuses a coverage that
 * names one `what` twice, so a second cause naming a `what` an earlier one named
 * is refused here, naming the document and both reasons — a unit that failed
 * inside `makeNodeFact` would lose its facts to a refusal about a list, where
 * this says what the reading could not say once.
 */
function documentGaps(gaps: readonly CoverageGap[], repository: string, path: RepositoryPath): CoverageGap[] {
  // Today every gap is one heading, and one line holds one heading, so a `what`
  // repeats only as an exact pair, which the fold below drops; the refusal is the
  // guard a second kind of gap will need, and it mirrors the history stage's.
  const seen = new Set<string>();
  const unique: CoverageGap[] = [];
  for (const gap of [...gaps].sort((left, right) => byCodePoint(left.what, right.what) || byCodePoint(left.reason, right.reason))) {
    const key = `${gap.what}\u0000${gap.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const named = unique.find((one) => one.what === gap.what);
    if (named !== undefined) {
      throw new Error(`document-index: the coverage of ${repository} at ${path} would name ${JSON.stringify(gap.what)} twice, as ${named.reason} and as ${gap.reason}: a coverage names each thing it could not read once`);
    }
    unique.push(gap);
  }
  return unique;
}

/**
 * What one unit's read answers, as the coverage's own words, in code point
 * order. The words name the read this stage makes and no more: the inline links
 * a line holds (a reference-style link, an autolink and a label that reaches over
 * a line's end are not among them), the sections its headings open and the task
 * keys its text names.
 */
const DOCUMENT_READ: readonly string[] = ['the inline links a line holds', 'the sections the headings open', 'the task keys the text names'];

// ---- one unit's work ------------------------------------------------------

/**
 * The `coverage` fact of one document's unit: what the read answered and every
 * heading it could not anchor. Its place is the document's own span, so a
 * publication that attributes a unit's facts by their place can retract this one
 * with them (madarch-tzte.20.2 and 21.8).
 */
function coverageFact(reader: SnapshotReader, path: RepositoryPath, range: FactRange, gaps: readonly CoverageGap[]): Fact {
  const value: CoverageValue = {
    repository: reader.repository,
    scope: documentScope(reader.repository, path),
    complete: gaps.length === 0,
    read: [...DOCUMENT_READ],
    unread: [...gaps],
  };
  return makeNodeFact({ kind: 'coverage', value, provenance: { ...provenanceOf(reader), place: placeAt(path, range) }, layer: 'extracted' });
}

/**
 * One unit's work: read the pinned commit's bytes of the unit's own document
 * through the repository's reader, and draft what they hold — the document, its
 * sections, its links, the task keys it names, and the coverage of the read. A
 * path the pinned commit does not hold, holds a submodule or a link at, or does
 * not hold as a Markdown document writes nothing, and a unit that writes nothing
 * is how this stage asks for a retraction: the publication that replaces a
 * unit's facts with an empty set is what removes what an earlier run wrote for
 * it (madarch-tzte.20.2's publication semantics; this change states the request,
 * not the mechanism).
 */
async function executeUnit(sources: SnapshotSource, unit: StageUnit, context: StageContext): Promise<StageExecutionResult> {
  refuseWhenCancelled(unit, context);
  const place = parseDocumentScope(unit.scope);
  const reader = await sources.open(place.repository);
  refuseWhenCancelled(unit, context);
  const entry = reader.entry(place.path);
  if (entry === undefined || entry.form !== 'blob' || markdownMediaType(place.path) === undefined) {
    context.progress(`the path ${place.path} holds no Markdown document of ${place.repository} at ${reader.commit}: this unit publishes nothing, and what an earlier run wrote there is retracted`, 1);
    return { outcome: 'draft' };
  }
  const bytes = await reader.read(place.path);
  const reading = readDocument(reader, place.path, bytes);
  const evidence = evidenceAt(reader, place.path);
  for (const fact of [...reading.facts, coverageFact(reader, place.path, reading.range, reading.gaps)]) {
    context.draft.write({ kind: 'fact', evidence, value: fact });
  }
  const gapNote = reading.gaps.length === 0 ? '' : `, and could not anchor ${reading.gaps.length} ${reading.gaps.length === 1 ? 'heading' : 'headings'}`;
  context.progress(`read ${place.path} of ${place.repository} at ${reader.commit}: ${reading.sections} ${reading.sections === 1 ? 'section' : 'sections'}, ${reading.links} ${reading.links === 1 ? 'link' : 'links'}, ${reading.keys} task ${reading.keys === 1 ? 'key' : 'keys'}${gapNote}`, 1);
  return { outcome: 'draft' };
}

/**
 * A cancelled unit stops where it stands, and a unit that has read nothing is no
 * draft: the publication of an empty fact set retracts what an earlier run wrote
 * for the unit, which a cancellation must never do in silence.
 */
function refuseWhenCancelled(unit: StageUnit, context: StageContext): void {
  if (context.signal.aborted) {
    throw new Error(`the unit "${unit.id}" was cancelled before it read the pinned document: a cancelled unit publishes nothing`);
  }
}

// ---- what a draft is judged by --------------------------------------------

/**
 * Judges one unit's draft before publication: every write is a fact the schema
 * reads (through `checkFactDraft`, whose refusals name the write and the fact's
 * own path and place), of a kind this stage produces, a section stands in a
 * document the same draft writes, an edge's `from` names a document or a section
 * this draft writes, and an edge whose end is a section names a section of this
 * document. A node end of another stage's kind — the `file` or the `document`
 * node of another unit's path — is that stage's or that unit's to prove, and it
 * is not refused here. An empty draft is a draft whole: that is the retraction a
 * vanished document asks for.
 */
export function validateDraft(draft: StageDraftSet): StageValidation {
  const checked = checkFactDraft(DOCUMENT_INDEX_STAGE_ID, DOCUMENT_INDEX_STAGE_KINDS, draft);
  const errors: string[] = checked.ok ? [] : [...checked.errors];
  const documents = new Set<string>();
  const nodes = new Set<string>();
  const sections = new Set<string>();
  const edges: { readonly index: number; readonly evidence: string; readonly value: Record<string, unknown> }[] = [];
  draft.writes.forEach((write: StageDraftWrite, index: number) => {
    if (write.kind !== 'fact') return;
    const fact = write.value;
    if (typeof fact !== 'object' || fact === null || Array.isArray(fact)) return;
    const held = fact as { readonly kind?: unknown; readonly id?: unknown; readonly value?: unknown };
    const value = typeof held.value === 'object' && held.value !== null && !Array.isArray(held.value) ? held.value as Record<string, unknown> : undefined;
    if (typeof held.kind !== 'string' || value === undefined) return;
    if (held.kind === 'document' && typeof held.id === 'string') {
      documents.add(String(value['repository']) + '\u0000' + String(value['path']));
      nodes.add(held.id);
      if (typeof value['mediaType'] !== 'string' || typeof value['bytes'] !== 'number' || typeof value['blob'] !== 'string') {
        errors.push(`write ${index + 1} (${write.evidence}) is a document fact that names no media type, no byte span or no blob: a document fact carries the bytes the document spans at its commit`);
      }
      return;
    }
    if (held.kind === 'section' && typeof held.id === 'string') {
      sections.add(held.id);
      nodes.add(held.id);
      return;
    }
    if (held.kind === 'document-link' || held.kind === 'task-key') {
      edges.push({ index, evidence: write.evidence, value });
      return;
    }
  });
  draft.writes.forEach((write: StageDraftWrite, index: number) => {
    if (write.kind !== 'fact') return;
    const fact = write.value as { readonly kind?: unknown; readonly value?: unknown };
    // A write the schema already refused (no value at all, a value that is no
    // object) is named by `checkFactDraft`; any check here would read the value
    // it did not read.
    if (typeof fact !== 'object' || fact === null || Array.isArray(fact)) return;
    if (fact.kind !== 'section') return;
    const value = typeof fact.value === 'object' && fact.value !== null && !Array.isArray(fact.value) ? fact.value as Record<string, unknown> : undefined;
    if (value === undefined) return;
    const where = `${String(value['repository'])}\u0000${String(value['document'])}`;
    if (!documents.has(where)) {
      errors.push(`write ${index + 1} (${write.evidence}) is a section of ${JSON.stringify(String(value['document']))}: a section stands in a document, and this draft writes no document fact of that path`);
    }
  });
  for (const edge of edges) {
    const from = edge.value['from'];
    if (typeof from !== 'string' || !nodes.has(from)) {
      errors.push(`write ${edge.index + 1} (${edge.evidence}) is an edge of ${JSON.stringify(from)}: an edge names a node that exists, and this draft writes no document or section fact of that id`);
    }
    const to = edge.value['to'];
    if (typeof to === 'object' && to !== null && !Array.isArray(to) && (to as { form?: unknown }).form === 'node') {
      const id = (to as { id?: unknown }).id;
      if (typeof id === 'string' && id.startsWith('section:') && !sections.has(id)) {
        errors.push(`write ${edge.index + 1} (${edge.evidence}) names the section ${JSON.stringify(id)}, which this draft writes no section fact for: a fragment names a section of the document the link stands in`);
      }
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// ---- the stage ------------------------------------------------------------

/**
 * The document index stage, over the source that holds the run's pins: the
 * stage's declaration (0027), its plan (one unit per changed Markdown document,
 * per pinned repository) and its execute (one document's facts). The stage
 * consumes the pinned snapshot and the inventory's `file` facts, since a link to
 * a path names the node stage 1 published for it, and its own `document`
 * capability, since its plan reads what its earlier run published — which is
 * what makes a document whose blob did not move no unit of a later run.
 */
export function createDocumentIndexStage(sources: SnapshotSource): FillStage {
  return {
    id: DOCUMENT_INDEX_STAGE_ID,
    version: DOCUMENT_INDEX_STAGE_VERSION,
    consumes: {
      required: [
        { capability: 'document', scope: 'file', freshness: 'current' },
        { capability: 'file', scope: 'file', freshness: 'current' },
        { capability: 'snapshot', scope: 'repository', freshness: 'current' },
      ],
      optional: [],
    },
    produces: DOCUMENT_INDEX_STAGE_KINDS.map((kind) => ({ kind, schemaVersion: FACT_KINDS[kind as 'document'].version, scope: 'file' as const })),
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: (graph) => planDocuments(sources, graph),
    execute: (unit, context) => executeUnit(sources, unit, context),
    validate: (draft) => validateDraft(draft),
  };
}
