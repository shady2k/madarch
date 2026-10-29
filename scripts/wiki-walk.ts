/**
 * wiki-walk — the walk over every page of a product's wiki, through its JSON
 * (madarch-j6ho.1).
 *
 * The walk reads a running product's wiki the way a reader reaches it: the
 * status, every kind's catalogue, every entity page (in each interface
 * language the manifest declares) and every document page. It judges the JSON
 * the server answers — never the Markdown of a kind's template, never the
 * source of the app — and reports, for each page, the section and the value
 * that breaks a class of the milestone `docs/milestones/wiki-for-people.md`:
 *
 *   empty-section         a titled block the app draws with nothing in it: an
 *                         empty list of references, an empty list of related
 *                         entities, a neighbourhood of the page alone, a
 *                         treemap of no files, a history of no sections, an
 *                         empty source view, an empty definition, a diagram
 *                         view of no elements. `properties` is not one: the
 *                         app draws it only when it has rows. A `body`,
 *                         `markdown` or `guide` block draws no heading of its
 *                         own, so its emptiness is not this class.
 *   raw-key               a word the reader sees that is still an extractor
 *                         name: a property row without `nameKey`, a shown
 *                         relation (`related`, the graph's edges) whose word,
 *                         after the same `code.` / `engine:` prefix strip the
 *                         app makes, still holds `.`, `_` or `:`, or is
 *                         camelCase; a property value that is serialized JSON
 *                         (`{...}`, `[...]`, a JSON scalar).
 *   foreign-language      text in another language than the one the wiki
 *                         declares for it. The product's own text (a
 *                         Markdown body, a term's definition, a generated
 *                         summary) is judged against `status.language`; the
 *                         text the engine words (block titles, a reference's
 *                         note, a treemap's notes, a diagram's notes and its
 *                         "nothing to draw" line, a page's notes) is judged
 *                         against the interface language the page was asked
 *                         in, because the app draws those as they come. A
 *                         sentence is judged span by span — a Russian
 *                         sentence beside an English one is two spans — and a
 *                         heading is judged as a title. The judgment uses
 *                         `tinyld` (a language-detection library): the script
 *                         is decisive when a span is in the other script, and
 *                         inside one script the detector must name another
 *                         language with a word count and a confidence that
 *                         make the call. A span of one word is a name or an
 *                         identifier, not prose, and is never called a
 *                         language; a synonym is a name by its provenance and
 *                         is only read for ids. Quotations (a `localized`
 *                         original, source text, commit messages, a contract's
 *                         text, a document's text) are never judged.
 *   raw-id                a reader-facing string that is an entity id: a
 *                         token whose namespace is one the product itself
 *                         declares (a kind of the manifest, `question`, the
 *                         `madarch:` link scheme) and that carries a
 *                         remainder, or a value equal to an id of the
 *                         product's own index. Markdown is parsed with
 *                         remark, so a code span or a link's address is not
 *                         text, in a body, a term's definition, a guide and a
 *                         document alike. A label with no declared namespace
 *                         is the entity's own name — a file named
 *                         `src/main.ts` draws its path — so only text that is
 *                         not a label is also matched against the id index.
 *   node-without-evidence a node drawn as a fact with no way to its
 *                         evidence: a neighbourhood's node without an `href`,
 *                         a diagram's element that is neither dashed (the page
 *                         says it is an assumption) nor linked, placed in
 *                         code, or openable by a drill-down.
 *
 * The walk fails loudly: a page, a catalogue or a document it cannot read is
 * an error that names the address, never a page silently left out, and a
 * document listing that says it is `truncated` is an error too, because no
 * route answers the rest. The exit code is 1 when a finding exists, 2 on an
 * unreadable product, 0 only when every page of every kind and every document
 * was read and nothing was found.
 *
 * `--baseline <file>` runs the walk as a ratchet: the counts in that file are
 * the most a class may have, a class the file does not name may not appear,
 * and a class below its count is printed so the file can be lowered.
 *
 * What the walk does not judge: the app's rendering (a block is judged by the
 * JSON it draws, not by its HTML), an image or a link's destination, the text
 * of a quotation, and a name of one word — a synonym, a view's label, a
 * file's path — which is read for ids only. A block the app does not draw is
 * not judged for emptiness, so `properties` with no rows and a page with no
 * `views` pass.
 *
 * `bun scripts/wiki-walk.ts --url http://127.0.0.1:4291 --product shop`
 */
import { performance } from 'node:perf_hooks';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { detectAll } from 'tinyld';
import type { Block, DocumentListing, DocumentPage, EntityListing, EntityRef, PageModel, PropertyRow, WikiStatus } from '../src/knowledge/model.js';

export const FINDING_CLASSES = ['empty-section', 'raw-key', 'foreign-language', 'raw-id', 'node-without-evidence'] as const;
export type FindingClass = (typeof FINDING_CLASSES)[number];

/** One violation, with everything a reader needs to find it again. */
export interface WalkFinding {
  class: FindingClass;
  product: string;
  /** The page's id (`code.symbol:...`), `kind:<kind>` for a catalogue, or `document:<path>` for a document. */
  page: string;
  kind: string;
  /** The interface language the page was answered in. */
  language: string;
  /** The block's title as the reader sees it, or `page`, `catalogue`, `document`. */
  section: string;
  /** The JSON path of the offending value inside the page; a Markdown line adds `:<line>`. */
  field: string;
  value: string;
  message: string;
}

export interface WalkCounts {
  /** Entity pages rendered (one per page and interface language). */
  pagesRead: number;
  /** Entity pages the product holds (the ids), each read in every language. */
  pages: number;
  documentsRead: number;
  kindLists: number;
  rowsRead: number;
}

export interface WalkResult extends WalkCounts {
  product: string;
  /** The product's own language (`status.language`). */
  language: string;
  languages: readonly string[];
  durationMs: number;
  findings: WalkFinding[];
  byClass: Record<FindingClass, number>;
  questionsRead: number;
}

/** The committed counts the walk is held to: a class may not grow, and a class the file does not name may not appear. */
export interface WalkBaseline {
  counts: Partial<Record<FindingClass, number>>;
}

export interface BaselineCheck {
  /** Classes above their baseline, or absent from it and non-zero. */
  regressions: { class: FindingClass; baseline: number; count: number }[];
  /** Classes below their baseline: the file may be lowered to these. */
  drops: { class: FindingClass; baseline: number; count: number }[];
}

export interface WalkOptions {
  /** The product's API root, ending in `/products/<slug>` (no trailing slash). */
  endpoint: string;
  product: string;
  /** Interface languages; by default the ones the manifest's labels and descriptions declare. */
  languages?: readonly string[];
  fetcher?: (url: string) => Promise<Response>;
  concurrency?: number;
}

export interface InspectOptions {
  product: string;
  /** The wiki's own language: what its written text must be in. */
  language: string;
  /** The interface language this page was asked in: what the engine's words must be in. */
  userLanguage: string;
  /** The ids of the product's index, for a value that is an id. */
  ids: ReadonlySet<string>;
  /** The id namespaces the product itself declares (`code.symbol`, `question`, `madarch`, ...). */
  namespaces: ReadonlySet<string>;
}

// ---- text, scripts and the language judgment -----------------------------------------------

/** The scripts the wiki's two languages are written in; a code point outside them is no letter for this judge. */
function scriptOf(code: number): 'latin' | 'cyrillic' | null {
  if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) return 'latin';
  if (code >= 0x00c0 && code <= 0x024f) return 'latin';
  if (code >= 0x1e00 && code <= 0x1eff) return 'latin';
  if (code >= 0x0400 && code <= 0x052f) return 'cyrillic';
  return null;
}

function scriptCounts(text: string): { latin: number; cyrillic: number; letters: number } {
  let latin = 0;
  let cyrillic = 0;
  for (const character of text) {
    const script = scriptOf(character.codePointAt(0)!);
    if (script === 'latin') latin += 1;
    else if (script === 'cyrillic') cyrillic += 1;
  }
  return { latin, cyrillic, letters: latin + cyrillic };
}

const SEGMENTER = new Intl.Segmenter('und', { granularity: 'word' });

function wordCount(text: string): number {
  let words = 0;
  for (const part of SEGMENTER.segment(text)) if (part.isWordLike === true) words += 1;
  return words;
}

/** The lowest letter count a prose span needs before it is judged: a shorter span is a name, not a sentence. */
const PROSE_LETTERS = 10;
const LABEL_LETTERS = 4;
/** A span must be at least this much of one script before it is read as that language. */
const PROSE_SHARE = 0.8;
const LABEL_SHARE = 0.9;
/** The detector must be this sure of another language, and see this many words, before a same-script span is called. */
const DETECT_ACCURACY = 0.25;
const DETECT_WORDS = 8;

export interface ForeignText {
  detected: string;
  reason: string;
}

/** One span of a text written in one script, with the words it holds. */
interface ScriptSpan {
  text: string;
  script: 'latin' | 'cyrillic';
  letters: number;
  words: number;
  /** The share of the span's letters in its dominant script. */
  share: number;
}

/**
 * The spans of one script a text holds, in the order a reader meets them: a
 * sentence that changes script is two spans. A foreign word or phrase inside a
 * sentence keeps a span of its own, so the sentence's dominant script cannot
 * hide it.
 */
function scriptSpans(text: string): ScriptSpan[] {
  const spans: { text: string; script: 'latin' | 'cyrillic'; latin: number; cyrillic: number }[] = [];
  let buffer = '';
  let script: 'latin' | 'cyrillic' | null = null;
  const flush = (): void => {
    if (script === null) return;
    const counts = scriptCounts(buffer);
    if (counts.letters > 0) spans.push({ text: buffer, script, latin: counts.latin, cyrillic: counts.cyrillic });
    buffer = '';
  };
  for (const character of text) {
    const next = scriptOf(character.codePointAt(0)!);
    if (next !== null && script !== null && next !== script) flush();
    if (next !== null) script = next;
    buffer += character;
  }
  flush();
  return spans.map((span) => {
    const letters = span.latin + span.cyrillic;
    return { text: span.text, script: span.script, letters, words: wordCount(span.text), share: Math.max(span.latin, span.cyrillic) / letters };
  });
}

/** One span against the wiki's language: its script is decisive, and inside one script the detector's verdict. */
function judgeSpan(span: ScriptSpan, expected: string, expectedScript: 'latin' | 'cyrillic', mode: 'prose' | 'label'): ForeignText | null {
  if (span.script !== expectedScript) {
    if (span.share < (mode === 'label' ? LABEL_SHARE : PROSE_SHARE)) return null;
    return { detected: span.script, reason: `it is written in ${span.script} script, and the wiki speaks ${expected}` };
  }
  if (mode === 'label') return null;
  const [top] = detectAll(span.text);
  if (top === undefined || top.lang === expected || top.lang === 'und') return null;
  if (span.words < DETECT_WORDS || top.accuracy < DETECT_ACCURACY) return null;
  return { detected: top.lang, reason: `the language detector reads ${top.lang} (${top.accuracy.toFixed(2)}), and the wiki speaks ${expected}` };
}

/**
 * The text in another language, or null. `mode` is `prose` for a sentence and
 * `label` for a title or a heading: a title is short, so it is judged whole by
 * its script, while a sentence is judged span by span — a Russian sentence and
 * an English sentence in one paragraph are two spans, and neither hides the
 * other. A span of one word is a name or an identifier (a synonym, a product
 * name, a path), not prose, and is never called a language.
 */
export function foreignText(text: string, expected: string, mode: 'prose' | 'label'): ForeignText | null {
  const expectedScript = expected === 'ru' ? 'cyrillic' : expected === 'en' ? 'latin' : null;
  if (expectedScript === null) return null;
  if (mode === 'label') {
    // The whole title as one label: a title part Cyrillic, part Latin is
    // uncertain, and uncertainty is not a violation.
    const { latin, cyrillic, letters } = scriptCounts(text);
    if (letters < LABEL_LETTERS) return null;
    const span: ScriptSpan = { text, script: latin >= cyrillic ? 'latin' : 'cyrillic', letters, words: wordCount(text), share: Math.max(latin, cyrillic) / letters };
    return judgeSpan(span, expected, expectedScript, 'label');
  }
  for (const span of scriptSpans(text)) {
    // A sentence has words separated by spaces: a span with no space is a
    // path, an address or an identifier, whatever the word segmenter says.
    if (span.letters < PROSE_LETTERS || span.words < 2 || !span.text.includes(' ')) continue;
    const found = judgeSpan(span, expected, expectedScript, 'prose');
    if (found !== null) return found;
  }
  return null;
}

// ---- ids in text ---------------------------------------------------------------------------

/**
 * Characters an id may hold: a letter in any script, a digit, and the
 * separators ids are written with. Anything else — a space, a dash, a quote, a
 * bracket, a full stop in a sentence — ends the token, so a token behind an em
 * dash is still a token.
 */
function idCharacter(character: string): boolean {
  const lower = character.toLowerCase();
  if (lower !== character.toUpperCase()) return true;
  if (character >= '0' && character <= '9') return true;
  return '._-/:+#@~$%'.includes(character);
}

const TRAILING = new Set(['.', ',', ';', ':', ')', ']', '}', '"', "'", '»', '…']);

/**
 * The id-shaped tokens of a text: a declared namespace, a colon, and a
 * remainder. The token must start at a boundary, so a word that merely ends
 * in a namespace is not one.
 */
export function idTokens(text: string, namespaces: ReadonlySet<string>): string[] {
  const found: { at: number; token: string }[] = [];
  const ordered = [...namespaces].sort((a, b) => b.length - a.length);
  for (const namespace of ordered) {
    const needle = `${namespace}:`;
    let at = text.indexOf(needle);
    while (at >= 0) {
      const before = at === 0 ? '' : text[at - 1]!;
      if (before === '' || !idCharacter(before)) {
        let end = at + needle.length;
        while (end < text.length && idCharacter(text[end]!)) end += 1;
        let token = text.slice(at, end);
        while (token.length > 0 && TRAILING.has(token[token.length - 1]!)) token = token.slice(0, -1);
        if (token.length > needle.length) found.push({ at, token });
      }
      at = text.indexOf(needle, at + 1);
    }
  }
  // In the order the reader meets them, and once each: a namespace that is a
  // prefix of another (`code` and `code.service`) can name one token twice.
  const seen = new Set<string>();
  return found
    .sort((left, right) => left.at - right.at || right.token.length - left.token.length)
    .filter(({ at, token }) => {
      const key = `${at}:${token}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ token }) => token);
}

// ---- Markdown as passages ------------------------------------------------------------------

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  position?: { start: { line: number; column: number; offset?: number } };
}

/** One block of text as the reader sees it, with the line it starts at. */
export interface Passage {
  text: string;
  line?: number;
  /** A heading: structure, judged like a title rather than like a sentence. */
  heading?: boolean;
}

const MARKDOWN = unified().use(remarkParse).use(remarkGfm);

/**
 * The passages of a Markdown text: a paragraph, a heading, a table cell and a
 * list item's own text. A code span, a code fence and an HTML block are not
 * passages — a reader does not read them as the page's prose — and a link's
 * address is not its text.
 */
/** The spaces of a passage as one: a code span taken out leaves a gap, and a gap is not a word. */
function collapsed(text: string): string {
  const out: string[] = [];
  let space = false;
  for (const character of text) {
    // A code point whose `trim` is empty is whitespace: no regex, and nothing
    // outside the Unicode whitespace set is swallowed.
    if (character.trim() === '') {
      space = out.length > 0;
      continue;
    }
    if (space) {
      out.push(' ');
      space = false;
    }
    out.push(character);
  }
  return out.join('');
}

/** A text as one line: every run of whitespace becomes one space. */
function oneLine(text: string): string {
  return collapsed(text).trim();
}

export function passagesOf(markdown: string): Passage[] {
  const tree = MARKDOWN.parse(markdown) as unknown as MdNode;
  const passages: Passage[] = [];
  const inline = (node: MdNode): string => {
    if (node.type === 'inlineCode' || node.type === 'html' || node.type === 'code') return '';
    if (node.type === 'text') return node.value ?? '';
    return (node.children ?? []).map(inline).join('');
  };
  const visit = (node: MdNode): void => {
    if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'tableCell') {
      const text = collapsed(inline(node)).trim();
      if (text !== '') passages.push({ text, line: node.position?.start.line, ...(node.type === 'heading' ? { heading: true } : {}) });
      return;
    }
    if (node.type === 'code' || node.type === 'html' || node.type === 'thematicBreak') return;
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return passages;
}

// ---- one page -------------------------------------------------------------------------------

/** Whether a shown relation word is still a key: the app's own prefix strip, then structural characters. */
export function relationIsKey(relation: string, stripEngine = true): boolean {
  const stripped = relation.startsWith('code.') ? relation.slice('code.'.length)
    : stripEngine && relation.startsWith('engine:') ? relation.slice('engine:'.length)
      : relation;
  return keyish(stripped);
}

function keyish(word: string): boolean {
  if (word.includes('.') || word.includes('_') || word.includes(':')) return true;
  for (let at = 1; at < word.length; at += 1) {
    const character = word[at]!;
    const before = word[at - 1]!;
    if (character >= 'A' && character <= 'Z' && before >= 'a' && before <= 'z') return true;
  }
  return false;
}

/** A value the extractor serialized instead of wording: JSON's own shapes. */
export function jsonValue(value: string): boolean {
  const text = value.trim();
  if (text.startsWith('{') && text.endsWith('}')) return true;
  if (text.startsWith('[') && text.endsWith(']')) return true;
  if (text === 'true' || text === 'false' || text === 'null') return true;
  if (text.length > 1 && text.startsWith('"') && text.endsWith('"')) return true;
  return false;
}

const MAX_VALUE = 400;

function short(value: string): string {
  const line = oneLine(value);
  return line.length <= MAX_VALUE ? line : `${line.slice(0, MAX_VALUE)}…`;
}

/**
 * Every violation a page holds. The page is judged once per interface
 * language: the text the product wrote is judged against the product's
 * language, the text the engine words against the interface language this
 * page was asked in.
 */
export function inspectPage(page: PageModel, options: InspectOptions): WalkFinding[] {
  const findings: WalkFinding[] = [];
  const seen = new Set<string>();
  const put = (finding: Omit<WalkFinding, 'product' | 'page' | 'kind' | 'language'>): void => {
    const key = `${finding.class}\u0000${finding.section}\u0000${finding.field}\u0000${finding.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ ...finding, product: options.product, page: page.id, kind: page.kind, language: options.userLanguage });
  };
  const label = (value: string, section: string, field: string): void => {
    for (const token of idTokens(value, options.namespaces)) {
      put({ class: 'raw-id', section, field, value: token, message: `the reader sees the raw id ${short(token)} instead of a name or a link` });
    }
  };
  const ids = (value: string, section: string, field: string): void => {
    label(value, section, field);
    // A label of an entity is the entity's own name: a file named
    // `src/main.ts` draws its path, and that is not the raw id fallback. Text
    // that is exactly an indexed id is a different matter: a note or a value
    // that is nothing but an id is the extractor's id, not a name.
    const exact = value.trim();
    if (exact !== '' && options.ids.has(exact)) {
      put({ class: 'raw-id', section, field, value: exact, message: `the reader sees the raw id ${short(exact)} instead of a name or a link` });
    }
  };
  const words = (value: string, section: string, field: string, expected: string, mode: 'prose' | 'label' = 'prose'): void => {
    ids(value, section, field);
    if (value.trim() === '') return;
    const foreign = foreignText(value, expected, mode);
    if (foreign === null) return;
    put({ class: 'foreign-language', section, field, value: short(value), message: `${foreign.reason}` });
  };
  const passage = (text: string, line: number | undefined, section: string, field: string, expected: string, mode: 'prose' | 'label' = 'prose'): void => {
    words(text, section, line === undefined ? field : `${field}:${line}`, expected, mode);
  };
  const empty = (section: string, field: string, value: string, what: string): void => {
    put({ class: 'empty-section', section, field, value, message: `the section is drawn with nothing in it: ${what}` });
  };

  // The page's own lines: the title is a name, the notes are the engine's words.
  label(page.title, 'page', 'title');
  page.trail.forEach((step, at) => label(step.label, 'page', `trail[${at}].label`));
  page.notes.forEach((note, at) => words(note, 'page', `notes[${at}]`, options.userLanguage));

  page.blocks.forEach((block, at) => {
    const field = (rest: string): string => `blocks[${at}].${rest}`;
    const titled = 'title' in block && typeof block.title === 'string' ? block.title : block.type;
    const section = titled === '' ? block.type : titled;
    if ('title' in block && typeof block.title === 'string' && block.title !== '') {
      words(block.title, section, field('title'), options.userLanguage, 'label');
    }
    inspectBlock(block, { section, product: page.kind.startsWith('code.') ? options.userLanguage : options.language, user: options.userLanguage, field, ids, label, words, passage, empty, put });
  });

  return findings;
}

interface BlockTools {
  section: string;
  /** The page's own language: the product's. */
  product: string;
  /** The engine's language: the interface language this page was asked in. */
  user: string;
  field: (rest: string) => string;
  /** The text for ids, and for a value that is exactly an indexed id. */
  ids: (value: string, section: string, field: string) => void;
  /** A label of an entity: the entity's own name, scanned for ids only. */
  label: (value: string, section: string, field: string) => void;
  words: (value: string, section: string, field: string, expected: string, mode?: 'prose' | 'label') => void;
  passage: (text: string, line: number | undefined, section: string, field: string, expected: string, mode?: 'prose' | 'label') => void;
  empty: (section: string, field: string, value: string, what: string) => void;
  put: (finding: Omit<WalkFinding, 'product' | 'page' | 'kind' | 'language'>) => void;
}

function markdownPassages(tools: BlockTools, markdown: string, field: string, expected: string): void {
  // A paragraph is a sentence, a heading is a title: a short heading is judged
  // by its script, where a sentence needs a phrase to be called a language.
  for (const passage of passagesOf(markdown)) tools.passage(passage.text, passage.line, tools.section, field, expected, passage.heading === true ? 'label' : 'prose');
}

function inspectBlock(block: Block, tools: BlockTools): void {
  const { section, field, ids, label, words, empty, put } = tools;
  switch (block.type) {
    case 'body':
      if (block.localized === undefined) markdownPassages(tools, block.markdown, field('body.markdown'), tools.product);
      else markdownPassages(tools, block.localized.statement, field('body.localized.statement'), tools.product);
      return;
    case 'markdown':
      markdownPassages(tools, block.markdown, field('markdown'), tools.product);
      return;
    case 'term': {
      if (block.definition.trim() === '') empty(section, field('definition'), '', 'the term has no definition');
      // A definition is Markdown the app renders: an identifier in a code span
      // is shown as code on purpose, and is not a raw id a reader has to read.
      markdownPassages(tools, block.definition, field('definition'), tools.product);
      // A synonym is a name — a product, a tool, a person — not a sentence to
      // translate: only an id drawn as one is a violation.
      block.synonyms.forEach((synonym, at) => label(synonym, section, field(`synonyms[${at}]`)));
      return;
    }
    case 'source':
      if (block.text.trim() === '') empty(section, field('text'), '', 'an empty source view');
      return;
    case 'properties':
      block.rows.forEach((row, at) => inspectProperty(row, at, tools));
      return;
    case 'members': {
      if (block.rows.length === 0) empty(section, field('rows'), `total: ${block.total}`, 'no member is drawn');
      block.rows.forEach((row, at) => {
        label(row.entity.label, section, field(`rows[${at}].entity.label`));
        row.values.forEach((value, valueAt) => inspectProperty(value, valueAt, { ...tools, field: (rest) => field(`rows[${at}].values[${valueAt}].${rest}`) }));
        row.readers.forEach((entity, readerAt) => label(entity.label, section, field(`rows[${at}].readers[${readerAt}].label`)));
        row.writers.forEach((entity, writerAt) => label(entity.label, section, field(`rows[${at}].writers[${writerAt}].label`)));
      });
      return;
    }
    case 'related': {
      if (block.groups.length === 0) empty(section, field('groups'), 'groups: 0', 'no related entity is drawn');
      block.groups.forEach((group, at) => {
        if (relationIsKey(group.relation, false)) {
          put({ class: 'raw-key', section, field: field(`groups[${at}].relation`), value: group.relation, message: `the relation is drawn as the key ${short(group.relation)}` });
        }
        if (group.rows.length === 0) {
          empty(section, field(`groups[${at}]`), `relation: ${group.relation}`, `the group ${short(group.relation)} holds no entity`);
          return;
        }
        group.rows.forEach((row, rowAt) => label(row.entity.label, section, field(`groups[${at}].rows[${rowAt}].entity.label`)));
      });
      return;
    }
    case 'callers':
    case 'callees':
      if (block.rows.length === 0 && (block.emptyNote === undefined || block.emptyNote.trim() === '')) empty(section, field('rows'), `total: ${block.total}`, 'no call is drawn');
      if (block.emptyNote !== undefined) words(block.emptyNote, section, field('emptyNote'), tools.user, 'prose');
      block.rows.forEach((row, at) => label(row.entity.label, section, field(`rows[${at}].entity.label`)));
      return;
    case 'refs':
      if (block.rows.length === 0 && (block.emptyNote === undefined || block.emptyNote.trim() === '')) empty(section, field('rows'), `total: ${block.total}`, 'no reference is drawn');
      if (block.emptyNote !== undefined) words(block.emptyNote, section, field('emptyNote'), tools.user, 'prose');
      block.rows.forEach((row, at) => {
        label(row.entity.label, section, field(`rows[${at}].entity.label`));
        if (row.note !== undefined && row.noteKey === undefined && row.quoted !== true) words(row.note, section, field(`rows[${at}].note`), tools.user, 'prose');
      });
      return;
    case 'graph': {
      const hood = block.neighborhood;
      // One node is the page alone only when no edge holds it to itself: a
      // self-loop is a fact the reader came for.
      if (hood.nodes.length <= 1 && hood.edges.length === 0 && hood.more.length === 0) {
        empty(section, field('neighborhood.nodes'), `nodes: ${hood.nodes.length}`, 'the neighbourhood holds only the page itself');
      }
      hood.nodes.forEach((node, at) => {
        label(node.label, section, field(`neighborhood.nodes[${at}].label`));
        if (node.href === null) {
          put({ class: 'node-without-evidence', section, field: field(`neighborhood.nodes[${at}]`), value: node.id, message: `the node ${short(node.label)} is drawn as a fact with no page, source location or drill-down` });
        }
      });
      hood.edges.forEach((edge, at) => {
        if (relationIsKey(edge.relation)) put({ class: 'raw-key', section, field: field(`neighborhood.edges[${at}].relation`), value: edge.relation, message: `the relation is drawn as the key ${short(edge.relation)}` });
      });
      hood.relations.forEach((relation, at) => {
        if (relationIsKey(relation.relation)) put({ class: 'raw-key', section, field: field(`neighborhood.relations[${at}].relation`), value: relation.relation, message: `the relation is drawn as the key ${short(relation.relation)}` });
      });
      return;
    }
    case 'treemap': {
      if (!block.files.some((file) => file.lines > 0)) empty(section, field('files'), `files: ${block.files.length}`, 'no file is drawn');
      block.notes.forEach((note, at) => words(note, section, field(`notes[${at}]`), tools.user, 'prose'));
      return;
    }
    case 'history': {
      if (block.sections.length === 0) empty(section, field('sections'), 'sections: 0', 'no history is drawn');
      block.sections.forEach((list, at) => {
        if (list.rows.length === 0) empty(section, field(`sections[${at}]`), `role: ${list.role}`, `the ${list.role} list holds no row`);
        else list.rows.forEach((row, rowAt) => { if (row.entity !== undefined) label(row.entity.label, section, field(`sections[${at}].rows[${rowAt}].entity.label`)); });
      });
      return;
    }
    case 'definition': {
      const emptySpec = block.spec.text.trim() === '';
      if (block.members.length === 0 && emptySpec && block.document === undefined && (block.descriptions ?? []).length === 0) {
        empty(section, field('members'), 'members: 0', 'no member, contract text or document is drawn');
      }
      block.members.forEach((member, at) => label(member.label, section, field(`members[${at}].label`)));
      return;
    }
    case 'diagrams': {
      block.views.forEach((view, at) => {
        // Emptiness is a fact of the view the reader selected: one populated
        // view does not fill the next one, and a view drawn as a Mermaid
        // source of its own has content without elements.
        if (view.elements.length === 0 && view.mermaidSource === '') {
          empty(section, field(`views[${at}]`), `title: ${short(view.title)}`, 'the view is drawn with no element');
        }
        words(view.title, section, field(`views[${at}].title`), tools.user, 'label');
        // The label names the view's subject — a route, a container, a folder —
        // so it is a name, read for ids and not for a language.
        label(view.label, section, field(`views[${at}].label`));
        view.notes.forEach((note, noteAt) => words(note, section, field(`views[${at}].notes[${noteAt}]`), tools.user, 'prose'));
        if (view.empty !== null) words(view.empty, section, field(`views[${at}].empty`), tools.user, 'prose');
        if (view.marker !== null) words(view.marker, section, field(`views[${at}].marker`), tools.user, 'label');
        view.elements.forEach((element, elementAt) => {
          label(element.label, section, field(`views[${at}].elements[${elementAt}].label`));
          // The line under an element's name is the repository's value — a stack,
          // an image and its ports — so it is read for ids, not as a sentence
          // the app words.
          if (element.detail !== undefined) label(element.detail, section, field(`views[${at}].elements[${elementAt}].detail`));
          if (!element.dashed && element.href === null && element.location === undefined && element.drill === undefined) {
            put({ class: 'node-without-evidence', section, field: field(`views[${at}].elements[${elementAt}]`), value: element.id, message: `the node ${short(element.label)} is drawn as a fact with no page, source location or drill-down` });
          }
        });
        // An edge's label is drawn on the arrow, and its `why` and `note` are
        // drawn beside it: each is read like the element's own text.
        view.edges.forEach((edge, edgeAt) => {
          label(edge.label, section, field(`views[${at}].edges[${edgeAt}].label`));
          if (edge.why !== undefined) words(edge.why, section, field(`views[${at}].edges[${edgeAt}].why`), tools.user, 'prose');
          if (edge.note !== undefined && edge.technical !== true) words(edge.note, section, field(`views[${at}].edges[${edgeAt}].note`), tools.user, 'prose');
        });
      });
      return;
    }
    case 'guide':
      // A guide is Markdown the app renders, localized to the language the page
      // was asked in: it is read like a body block, in the interface language.
      markdownPassages(tools, block.data.markdown, field('data.markdown'), tools.user);
      return;
    case 'stated': case 'deferred': case 'problem':
      // A stated place, a deferred block and a problem card are diagnostics,
      // not a drawn section of a page kind; the language and id classes cover
      // their visible text where the model exposes it.
      return;
  }
}

function inspectProperty(row: PropertyRow, at: number, tools: BlockTools): void {
  const { section, field, ids, put, words, user } = tools;
  if (row.label !== undefined && row.label.trim() !== '') words(row.label, section, field(`rows[${at}].label`), user, 'label');
  else if (row.nameKey === undefined) {
    put({ class: 'raw-key', section, field: field(`rows[${at}].name`), value: row.name, message: `the property name ${short(row.name)} has no name key, so the reader sees the extractor's word` });
  }
  if (row.valueKind !== 'code' && jsonValue(row.value)) {
    put({ class: 'raw-key', section, field: field(`rows[${at}].value`), value: short(row.value), message: 'the property value is serialized JSON, not words' });
  }
  ids(row.value, section, field(`rows[${at}].value`));
}

// ---- one catalogue and one document ---------------------------------------------------------

/**
 * Every row of a kind's catalogue, following the server's own `next` until it
 * holds none. A row the listing promises and does not answer is an error: the
 * walk never reports fewer rows than the product holds.
 */
async function readCatalogue(fetcher: (url: string) => Promise<Response>, endpoint: string, kind: string): Promise<EntityRef[]> {
  const rows: EntityRef[] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  let total: number | null = null;
  for (;;) {
    const url = new URL(`${endpoint}/api/k/entities`);
    url.searchParams.set('kind', kind);
    url.searchParams.set('limit', '200');
    if (after !== null) url.searchParams.set('after', after);
    const listing = await getJson<EntityListing>(fetcher, url.href);
    if (total === null) total = listing.total;
    else if (total !== listing.total) throw new Error(`${url.href}: the catalogue's total changed from ${total} to ${listing.total} while it was read`);
    for (const row of listing.rows) {
      if (seen.has(row.id)) throw new Error(`${url.href}: the catalogue holds ${row.id} twice`);
      seen.add(row.id);
      rows.push(row);
    }
    if (listing.next === null) {
      if (listing.rows.length === 0 && rows.length < listing.total) throw new Error(`${url.href}: the catalogue holds ${listing.total} rows but answered none at the last page`);
      break;
    }
    if (after !== null && listing.next === after) throw new Error(`${url.href}: the catalogue's next page is the page just read (${listing.next})`);
    after = listing.next;
  }
  if (rows.length !== total) throw new Error(`${endpoint}/api/k/entities?kind=${encodeURIComponent(kind)}: the catalogue names ${total} rows and answered ${rows.length}`);
  return rows;
}

/** The rows a kind's catalogue page draws, judged for raw ids. */
export function inspectCatalogue(kind: string, rows: readonly EntityRef[], options: InspectOptions): WalkFinding[] {
  const findings: WalkFinding[] = [];
  rows.forEach((row, at) => {
    // A catalogue shows each entity's own name: a file's path is its name, and
    // only a token that carries a namespace the product declares is raw.
    for (const token of idTokens(row.label, options.namespaces)) {
      findings.push({
        class: 'raw-id', product: options.product, page: `kind:${kind}`, kind, language: options.userLanguage,
        section: 'catalogue', field: `rows[${at}].label`, value: token,
        message: `the catalogue shows the raw id ${short(token)} instead of a name`,
      });
    }
  });
  return findings;
}

/** A document page: its text is a quotation, so only an id the reader would see is judged. */
export function inspectDocument(document: DocumentPage, options: InspectOptions): WalkFinding[] {
  const findings: WalkFinding[] = [];
  const page = `document:${document.repo === null ? '' : `${document.repo}/`}${document.path}`;
  const put = (field: string, token: string): void => {
    findings.push({
      class: 'raw-id', product: options.product, page, kind: 'document', language: options.userLanguage,
      section: 'document', field, value: token,
      message: `the document shows the raw id ${short(token)} instead of a link`,
    });
  };
  for (const token of idTokens(document.title, options.namespaces)) put('title', token);
  for (const passage of passagesOf(document.markdown)) {
    for (const token of idTokens(passage.text, options.namespaces)) put(`markdown:${passage.line ?? 0}`, token);
  }
  return findings;
}

/** A baseline file as read: the JSON it holds, checked against the classes this walk judges. */
export function parseBaseline(text: string, file: string): WalkBaseline {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: the baseline is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${file}: the baseline is not a JSON object`);
  const counts = (parsed as { counts?: unknown }).counts;
  if (typeof counts !== 'object' || counts === null || Array.isArray(counts)) throw new Error(`${file}: the baseline has no "counts" object`);
  const known: ReadonlySet<string> = new Set(FINDING_CLASSES);
  const checked: Partial<Record<FindingClass, number>> = {};
  for (const [name, value] of Object.entries(counts)) {
    if (!known.has(name)) throw new Error(`${file}: the baseline names the class ${JSON.stringify(name)}, which this walk does not judge`);
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`${file}: counts[${JSON.stringify(name)}] is ${JSON.stringify(value)}; it must be a count`);
    checked[name as FindingClass] = value;
  }
  return { counts: checked };
}

/** The walk against its baseline: every class above it is a regression, every class below it a baseline to lower. */
export function compareToBaseline(result: WalkResult, baseline: WalkBaseline): BaselineCheck {
  const regressions: BaselineCheck['regressions'] = [];
  const drops: BaselineCheck['drops'] = [];
  for (const name of FINDING_CLASSES) {
    const allowed = baseline.counts[name] ?? 0;
    const count = result.byClass[name];
    if (count > allowed) regressions.push({ class: name, baseline: allowed, count });
    else if (count < allowed) drops.push({ class: name, baseline: allowed, count });
  }
  return { regressions, drops };
}

/** The ratchet as a person reads it: what grew, what fell, and which way the walk exits. */
export function formatBaseline(check: BaselineCheck): string {
  const lines: string[] = [];
  for (const regression of check.regressions) lines.push(`ratchet: ${regression.class} ${regression.baseline} → ${regression.count} (+${regression.count - regression.baseline}) — above the baseline, so the walk fails`);
  for (const drop of check.drops) lines.push(`ratchet: ${drop.class} ${drop.baseline} → ${drop.count} (−${drop.baseline - drop.count}) — below the baseline, which may be lowered`);
  if (lines.length === 0) lines.push('ratchet: every class is at its baseline');
  return lines.join('\n');
}

// ---- talking to a running server ------------------------------------------------------------

async function getJson<T>(fetcher: (url: string) => Promise<Response>, url: string): Promise<T> {
  const response = await fetcher(url);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${url}: HTTP ${response.status}${body === '' ? '' : `: ${oneLine(body).slice(0, 300)}`}`);
  }
  try {
    return await response.json() as T;
  } catch (error) {
    throw new Error(`${url}: the answer is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The interface languages the product's own manifest declares. */
export function declaredLanguages(status: WikiStatus): string[] {
  const languages = new Set<string>();
  for (const kind of status.kinds) {
    for (const language of Object.keys(kind.labels ?? {})) languages.add(language);
    for (const language of Object.keys(kind.descriptions ?? {})) languages.add(language);
  }
  for (const group of status.groups) for (const language of Object.keys(group.labels)) languages.add(language);
  if (languages.size === 0) languages.add(status.language);
  return [...languages].sort();
}

async function pool<T>(items: readonly T[], concurrency: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      if (failure !== undefined) return;
      const at = next;
      next += 1;
      if (at >= items.length) return;
      try {
        await run(items[at]!);
      } catch (error) {
        failure ??= error;
        return;
      }
    }
  });
  await Promise.all(workers);
  if (failure !== undefined) throw failure;
}

/** An address without the slashes a person may leave at its end. */
function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end -= 1;
  return url.slice(0, end);
}

/** The product's API root, from the server's origin and the product's name. */
export function productEndpoint(url: string, product: string): string {
  const trimmed = withoutTrailingSlashes(url);
  const marker = `/products/${encodeURIComponent(product)}`;
  return trimmed.endsWith(marker) ? trimmed : `${trimmed}${marker}`;
}

/**
 * The walk: status, every kind's catalogue, every page in every interface
 * language, and every document. One unreadable answer fails the walk with the
 * address it came from.
 */
export async function walkWiki(options: WalkOptions): Promise<WalkResult> {
  const started = performance.now();
  const fetcher = options.fetcher ?? ((url: string) => fetch(url));
  const endpoint = withoutTrailingSlashes(options.endpoint);
  const status = await getJson<WikiStatus>(fetcher, `${endpoint}/api/k/status`);
  if (status.manifest !== 'ok') {
    throw new Error(`${endpoint}/api/k/status: the product has no kinds manifest (${status.manifestFile}), so it has no pages to walk`);
  }
  const languages = [...(options.languages ?? declaredLanguages(status))];
  if (languages.length === 0) throw new Error(`${endpoint}/api/k/status: the product declares no interface language`);
  for (const language of languages) {
    if (language !== 'en' && language !== 'ru') throw new Error(`${endpoint}: the interface language ${JSON.stringify(language)} is not one this walk judges; the wiki speaks en and ru`);
  }
  const questions = await getJson<{ rows: { id: string }[] }>(fetcher, `${endpoint}/api/k/questions`);
  const ids = new Set<string>();
  const namespaces = new Set<string>(['madarch']);
  for (const kind of status.kinds) namespaces.add(kind.kind);
  for (const question of questions.rows) {
    ids.add(question.id);
    const colon = question.id.indexOf(':');
    if (colon > 0) namespaces.add(question.id.slice(0, colon));
  }

  const catalogues: { kind: string; rows: EntityRef[] }[] = [];
  for (const summary of status.kinds) {
    const rows = await readCatalogue(fetcher, endpoint, summary.kind);
    catalogues.push({ kind: summary.kind, rows });
    for (const row of rows) ids.add(row.id);
  }
  const rowsRead = catalogues.reduce((sum, catalogue) => sum + catalogue.rows.length, 0);

  const findings: WalkFinding[] = [];
  for (const catalogue of catalogues) {
    findings.push(...inspectCatalogue(catalogue.kind, catalogue.rows, {
      product: options.product, language: status.language, userLanguage: status.language, ids, namespaces,
    }));
  }

  const work: { kind: string; id: string; language: string }[] = [];
  for (const catalogue of catalogues) {
    for (const row of catalogue.rows) for (const language of languages) work.push({ kind: catalogue.kind, id: row.id, language });
  }
  await pool(work, options.concurrency ?? 4, async (item) => {
    const url = new URL(`${endpoint}/api/k/page`);
    url.searchParams.set('id', item.id);
    url.searchParams.set('lang', item.language);
    url.searchParams.set('full', '1');
    const page = await getJson<PageModel>(fetcher, url.href);
    if (page.id !== item.id) throw new Error(`${url.href}: the server answered the page ${page.id}`);
    findings.push(...inspectPage(page, {
      product: options.product, language: status.language, userLanguage: item.language, ids, namespaces,
    }));
  });

  const listing = await getJson<DocumentListing>(fetcher, `${endpoint}/api/k/documents`);
  // A truncated listing names documents it does not send, and no route pages
  // through the rest: reading the listing's part would report fewer documents
  // than the product holds, so the walk stops and names what is missing.
  if (listing.truncated.length > 0) {
    const first = listing.truncated[0]!;
    throw new Error(`${endpoint}/api/k/documents: the listing omits documents of ${first.repo === null ? 'the product repository' : JSON.stringify(first.repo)} (${first.shown} of ${first.total} listed), so it cannot be read whole`);
  }
  let documentsRead = 0;
  for (const document of listing.documents) {
    const url = new URL(`${endpoint}/api/k/document`);
    url.searchParams.set('path', document.path);
    if (document.repo !== null) url.searchParams.set('repo', document.repo);
    const page = await getJson<DocumentPage>(fetcher, url.href);
    findings.push(...inspectDocument(page, { product: options.product, language: status.language, userLanguage: status.language, ids, namespaces }));
    documentsRead += 1;
  }

  // Pages were read at once, so they finish out of order: the report reads the
  // same whichever way the pool happened to run.
  const rank = new Map<string, number>(FINDING_CLASSES.map((name, index) => [name, index]));
  findings.sort((left, right) =>
    (rank.get(left.class) ?? 0) - (rank.get(right.class) ?? 0)
    || left.page.localeCompare(right.page)
    || left.section.localeCompare(right.section)
    || left.field.localeCompare(right.field)
    || left.value.localeCompare(right.value));

  const byClass = Object.fromEntries(FINDING_CLASSES.map((name) => [name, 0])) as Record<FindingClass, number>;
  for (const finding of findings) byClass[finding.class] += 1;
  return {
    product: options.product,
    language: status.language,
    languages,
    pagesRead: work.length,
    pages: work.length / languages.length,
    documentsRead,
    kindLists: catalogues.length,
    rowsRead,
    durationMs: performance.now() - started,
    questionsRead: questions.rows.length,
    findings,
    byClass,
  };
}

// ---- the command ----------------------------------------------------------------------------

export interface CliOptions {
  endpoint: string;
  product: string;
  languages?: string[];
  json?: string;
  /** A committed baseline of per-class counts: the walk then ratchets instead of failing on any finding. */
  baseline?: string;
  concurrency: number;
  maxFindings: number;
}

const USAGE = `wiki-walk — walk every page of a product's wiki through its JSON.

  bun scripts/wiki-walk.ts --url <origin> --product <folder> [options]

  --url <origin>        the server's address, e.g. http://127.0.0.1:4291
  --product <folder>    the product's folder name under /products/
  --lang <list>         interface languages to read, comma separated (default: the manifest's)
  --json <file>         write every finding and the counts to a file
  --baseline <file>     hold the counts to a committed baseline: a class above
                        it (or a class it does not name) fails, a class below it
                        is reported so the baseline can be lowered
  --concurrency <n>     pages read at once (default 4)
  --max-findings <n>    findings printed (default 50; the rest are counted, and --json holds all)
  --help                this text

Exit codes: 0 when nothing was found (or, with --baseline, nothing grew), 1
when a finding was (or a class grew), 2 when the product or the baseline could
not be read.`;

export function parseArguments(argv: readonly string[]): CliOptions | { help: true } {
  const values = new Map<string, string>();
  for (let at = 0; at < argv.length; at += 1) {
    const argument = argv[at]!;
    if (argument === '--help' || argument === '-h') return { help: true };
    if (!argument.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(argument)}`);
    const equals = argument.indexOf('=');
    if (equals > 0) {
      values.set(argument.slice(2, equals), argument.slice(equals + 1));
      continue;
    }
    const value = argv[at + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${argument.slice(2)} needs a value`);
    values.set(argument.slice(2), value);
    at += 1;
  }
  const url = values.get('url');
  const product = values.get('product');
  if (url === undefined) throw new Error('--url is required');
  if (product === undefined) throw new Error('--product is required');
  for (const key of values.keys()) {
    if (!['url', 'product', 'lang', 'json', 'baseline', 'concurrency', 'max-findings'].includes(key)) throw new Error(`unknown option --${key}`);
  }
  const integer = (key: string, fallback: number, min: number): number => {
    const raw = values.get(key);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < min) throw new Error(`--${key} is ${JSON.stringify(raw)}; it must be an integer of at least ${min}`);
    return parsed;
  };
  const languages = values.get('lang')?.split(',').map((language) => language.trim()).filter((language) => language !== '');
  return {
    endpoint: productEndpoint(url, product),
    product,
    ...(languages === undefined || languages.length === 0 ? {} : { languages }),
    ...(values.get('json') === undefined ? {} : { json: values.get('json')! }),
    ...(values.get('baseline') === undefined ? {} : { baseline: values.get('baseline')! }),
    concurrency: integer('concurrency', 4, 1),
    maxFindings: integer('max-findings', 50, 0),
  };
}

/** The report a person reads on the terminal. */
export function formatReport(result: WalkResult, maxFindings: number): string {
  const seconds = (result.durationMs / 1000).toFixed(1);
  const lines: string[] = [];
  lines.push(`wiki-walk: ${result.product} — the wiki is ${result.language}; read in ${result.languages.join(', ')}`);
  lines.push(`read ${result.pages} entity pages (${result.pagesRead} renders), ${result.documentsRead} documents, ${result.kindLists} kind catalogues and ${result.rowsRead} catalogue rows, and ${result.questionsRead} questions, in ${seconds} s`);
  const total = result.findings.length;
  lines.push(`findings: ${total}`);
  for (const name of FINDING_CLASSES) {
    const count = result.byClass[name];
    if (count > 0 || total === 0) lines.push(`  ${name.padEnd(22)} ${count}`);
  }
  if (total > 0 && result.findings.length > maxFindings) lines.push(`  (the first ${maxFindings} are printed; --json <file> writes all ${total})`);
  for (const finding of result.findings.slice(0, maxFindings)) {
    lines.push(`[${finding.class}] ${finding.page} — ${finding.section} (${finding.field}) ${JSON.stringify(finding.value)}: ${finding.message}`);
  }
  return lines.join('\n');
}

export async function main(argv: readonly string[]): Promise<number> {
  const options = parseArguments(argv);
  if ('help' in options) {
    console.log(USAGE);
    return 0;
  }
  try {
    const result = await walkWiki({
      endpoint: options.endpoint,
      product: options.product,
      ...(options.languages === undefined ? {} : { languages: options.languages }),
      concurrency: options.concurrency,
    });
    console.log(formatReport(result, options.maxFindings));
    if (options.json !== undefined) await Bun.write(options.json, `${JSON.stringify(result, null, 2)}\n`);
    if (options.baseline === undefined) return result.findings.length === 0 ? 0 : 1;
    const baseline = parseBaseline(await Bun.file(options.baseline).text(), options.baseline);
    const check = compareToBaseline(result, baseline);
    console.log(formatBaseline(check));
    return check.regressions.length === 0 ? 0 : 1;
  } catch (error) {
    console.error(`wiki-walk: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
