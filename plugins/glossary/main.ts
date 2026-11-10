/**
 * The glossary plugin (decision 0035, items 3 and 8): it reads a glossary
 * document and answers the terms it states, in either of the two shapes a
 * glossary is written in — a list item that opens with a bold term, or a
 * paragraph that opens with one followed by a colon — with the definition under
 * it, its synonyms and its code names, and the lines the term stands on.
 *
 * The documents are the graph's file vertices and their content, which the host answers: the plugin reads no
 * repository and walks no folder (items 9 and 15). The structure is read by Bun's Markdown parser; the
 * lines are counted by the scan that finds the blocks, because a renderer gives
 * no positions. Nothing is guessed: a block that does not open with a bold term
 * is no term, and a term whose definition is empty is answered as it stands.
 */
import { definePlugin, type ExtractContext, type Unit, type UnitResult, type VertexResult } from 'madarch-plugin-sdk';

/** The kind the plugin fills. */
const TERM_KIND = 'doc.term';

/** The marker the parser's `strong` callback wraps a bold run in, so the first one is the term. */
const OPEN = '\u0001madarch-term\u0001';
const CLOSE = '\u0002';

/** One term a document states. */
interface Term {
  readonly name: string;
  readonly definition: string;
  readonly synonyms: readonly string[];
  readonly code: readonly string[];
  readonly lineStart: number;
  readonly lineEnd: number;
}

/** One block of a document: a list item or a paragraph, with the lines it stands on. */
interface Block {
  readonly form: 'item' | 'paragraph';
  readonly text: string;
  readonly lineStart: number;
  readonly lineEnd: number;
}

/** Whether a line opens or closes a fenced code block. */
function fenceOf(line: string): string | null {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('```')) return '```';
  if (trimmed.startsWith('~~~')) return '~~~';
  return null;
}

/** The text after a top-level item's bullet, or null when the line opens no such item. */
function itemStart(line: string): string | null {
  if (line.startsWith('  ') || line.startsWith('\t')) return null;
  for (const bullet of ['- ', '* ', '+ ']) if (line.startsWith(bullet)) return line.slice(bullet.length);
  return null;
}

/**
 * The blocks of a Markdown document, with their lines: a top-level list item and its continuation, or a paragraph
 * and its lines. A fenced block never opens one, a heading closes the block before it, and a blank line ends a
 * paragraph.
 */
function blocksOf(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let fence: string | null = null;
  let held: { form: 'item' | 'paragraph'; lines: string[]; lineStart: number } | null = null;
  const close = (): void => {
    if (held === null) return;
    const body = held.lines.join('\n').replace(/\s+$/u, '');
    if (body.trim() !== '') blocks.push({ form: held.form, text: body, lineStart: held.lineStart, lineEnd: held.lineStart + held.lines.length - 1 });
    held = null;
  };
  for (const [index, line] of lines.entries()) {
    const lineNo = index + 1;
    const opened = fenceOf(line);
    if (fence !== null) {
      if (opened === fence) fence = null;
      if (held !== null) held.lines.push(line);
      continue;
    }
    if (opened !== null) {
      fence = opened;
      if (held !== null) held.lines.push(line);
      continue;
    }
    if (line.startsWith('#')) {
      close();
      continue;
    }
    const start = itemStart(line);
    if (start !== null) {
      close();
      held = { form: 'item', lines: [start], lineStart: lineNo };
      continue;
    }
    if (line.trim() === '') {
      // A blank line ends a paragraph and is kept inside an item, whose continuation may follow it.
      if (held !== null && held.form === 'paragraph') close();
      else if (held !== null) held.lines.push('');
      continue;
    }
    if (held === null) {
      held = { form: 'paragraph', lines: [line], lineStart: lineNo };
      continue;
    }
    held.lines.push(held.form === 'item' && line.startsWith('  ') ? line.trim() : line);
  }
  close();
  return blocks;
}

/** The text of a block as Markdown renders it, with its first bold run marked so the term can be taken. */
function rendered(text: string): string {
  return Bun.markdown.render(text, {
    strong: (children: string) => `${OPEN}${children}${CLOSE}`,
  });
}

/** The text after a term and the mark that follows it: a dash in a list item, a colon in a paragraph. */
function stripMark(text: string, marks: readonly string[]): string {
  let rest = text.replace(/^\s+/u, '');
  for (const mark of marks) {
    if (rest.startsWith(mark)) {
      rest = rest.slice(mark.length).replace(/^\s+/u, '');
      break;
    }
  }
  return rest.trim();
}

/** The synonyms and the code names a definition states, and the definition without them. */
function partsOf(text: string): { definition: string; synonyms: string[]; code: string[] } {
  const synonyms: string[] = [];
  const code: string[] = [];
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const cut = trimmed.indexOf(':');
    const label = (cut < 0 ? trimmed : trimmed.slice(0, cut)).toLowerCase();
    const rest = cut < 0 ? '' : trimmed.slice(cut + 1).trim();
    if (label === 'also called' || label === 'synonyms') {
      synonyms.push(...rest.split(',').map((one) => one.trim()).filter((one) => one !== ''));
      continue;
    }
    if (label === 'in code' || label === 'code') {
      code.push(...rest.split(',').map((one) => one.trim()).filter((one) => one !== ''));
      continue;
    }
    kept.push(line);
  }
  return { definition: kept.join('\n').trim(), synonyms, code };
}

/** The term one block states, or undefined when the block does not open with a bold term. */
function termOf(block: Block): Term | undefined {
  const marked = rendered(block.text);
  const open = marked.indexOf(OPEN);
  const closeAt = marked.indexOf(CLOSE, open + OPEN.length);
  if (open < 0 || closeAt < 0) return undefined;
  // The bold run must open the block: a term is the word the block states first, never one it mentions later.
  if (marked.slice(0, open).trim() !== '') return undefined;
  const name = marked.slice(open + OPEN.length, closeAt).replace(/[*_`]/gu, '').trim();
  if (name === '') return undefined;
  let rest = marked.slice(closeAt + CLOSE.length);
  // A list item separates its term with a dash, a paragraph with a colon; a bold run followed by neither is text.
  // A paragraph's label may carry a place after the term — `**Wiki** (`src/product-wiki/`):` — so the colon that
  // ends the label is looked for, and a label long enough to be a sentence is no term.
  if (block.form === 'paragraph') {
    const colon = rest.indexOf(':');
    if (colon < 0 || colon > 80 || rest.slice(0, colon).includes('\n')) return undefined;
    rest = rest.slice(colon + 1);
  }
  const parts = partsOf(stripMark(rest, block.form === 'item' ? ['\u2014', '\u2013', ':', '-'] : []));
  return { name, definition: parts.definition, synonyms: parts.synonyms, code: parts.code, lineStart: block.lineStart, lineEnd: block.lineEnd };
}

/** The terms one glossary document states. */
function termsOf(text: string): Term[] {
  const terms: Term[] = [];
  for (const block of blocksOf(text)) {
    const term = termOf(block);
    if (term !== undefined) terms.push(term);
  }
  return terms;
}

/** The unit's inputs: the pattern the host names for the kind's documents. */
interface GlossaryInputs {
  readonly pattern?: unknown;
}

/** The pattern the plugin reads when the host names none: a glossary document in any folder. */
const DEFAULT_PATTERN = '**/glossary*.md';

/**
 * The unit's answer: every term of every document the pattern names. The documents are the graph's file vertices and
 * their content is what the files producer stored by blob — the plugin asks the host and never opens a folder.
 */
async function extract(unit: Unit, context: ExtractContext): Promise<UnitResult> {
  const inputs = (unit.inputs ?? {}) as GlossaryInputs;
  const pattern = typeof inputs.pattern === 'string' ? inputs.pattern : DEFAULT_PATTERN;
  const files = await context.graph.files(pattern);
  const vertices: VertexResult[] = [];
  for (const file of files) {
    const repository = String(file.key['repository'] ?? '');
    const path = String(file.key['path'] ?? '');
    const text = await context.graph.value<string | null>(file.kind, file.key, 'content');
    if (typeof text !== 'string' || text === '') continue;
    for (const term of termsOf(text)) {
      vertices.push({
        kind: TERM_KIND,
        key: { name: term.name },
        claims: [
          { field: 'definition', value: term.definition, evidence: { repository, path, lineStart: term.lineStart, lineEnd: term.lineEnd } },
          { field: 'synonyms', value: term.synonyms, evidence: { repository, path, lineStart: term.lineStart, lineEnd: term.lineEnd } },
          { field: 'code', value: term.code, evidence: { repository, path, lineStart: term.lineStart, lineEnd: term.lineEnd } },
        ],
      });
    }
  }
  return { vertices, end: { state: 'complete' } };
}

await definePlugin({
  name: 'glossary',
  version: '1.0.0',
  // The graph's file vertices and their content, and no repository: the files producer alone reads the source.
  graph: true,
  contract: {
    vertices: [
      {
        kind: TERM_KIND,
        key: ['name'],
        fields: [
          { name: 'name', claim: 'authoritative', type: 'text', meaning: 'The term itself, as the glossary writes it in bold.', example: 'Fill', required: true },
          { name: 'definition', claim: 'claimed', type: 'text', meaning: 'What the term means, as the glossary defines it.', example: 'The one run that reads a product and writes its graph.', required: true },
          { name: 'synonyms', claim: 'claimed', type: 'json', meaning: 'The other names the glossary gives the term.', example: ['run'], required: false },
          { name: 'code', claim: 'claimed', type: 'json', meaning: 'The names the code uses for the thing the term means.', example: ['fillRun'], required: false },
        ],
      },
    ],
    edges: [],
  },
  extract,
});
