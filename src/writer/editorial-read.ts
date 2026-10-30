/**
 * The structured reading of a page for the editorial pass (madarch-ztyq.9, review 199).
 *
 * The deterministic checks and the revision validation read the Markdown tree, never its characters:
 * a paragraph is a `paragraph` node, a footnote definition is a `footnoteDefinition`, and a sentence
 * is the run of inline nodes that ends at a run of `footnoteReference` nodes. Code, headings and
 * comments are nodes of their own, so a label or a number inside them is not prose.
 *
 * `revisionScopeProblems` compares the blocks of the page before and after a revision. Only a block
 * that carries a named passage may change; a change elsewhere, including a pure insertion, is refused
 * with the file, the line and the full path of the page.
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { splitFrontMatter } from '../knowledge/markdown.js';
import { sha256Hex } from '../graph/digest.js';
import type { PageStatement } from './sentences.js';

interface Position {
  readonly start: { readonly line: number; readonly column: number; readonly offset: number };
  readonly end: { readonly line: number; readonly column: number; readonly offset: number };
}

interface Node {
  readonly type: string;
  readonly value?: string;
  readonly url?: string;
  readonly label?: string;
  readonly identifier?: string;
  readonly alt?: string | null;
  readonly position?: Position;
  readonly children?: readonly Node[];
}

const processor = unified().use(remarkParse).use(remarkGfm);

const parseTree = (markdown: string): Node => processor.parse(markdown) as unknown as Node;

/** Whitespace runs become one space without a regular expression over the document's text. */
export function collapseSpace(text: string): string {
  let out = '';
  let space = false;
  for (const character of text) {
    if (character === ' ' || character === '\t' || character === '\n' || character === '\r' || character === '\f') {
      space = out !== '';
      continue;
    }
    if (space) { out += ' '; space = false; }
    out += character;
  }
  return out;
}

const slice = (markdown: string, node: Node): string => {
  const position = node.position;
  if (position === undefined) return '';
  return markdown.slice(position.start.offset, position.end.offset);
};

const lineOf = (node: Node, bodyLine: number): number => bodyLine + (node.position?.start.line ?? 1) - 1;

/** The visible text of inline nodes; footnote references are boundaries, not words. */
function inlineText(nodes: readonly Node[], definitions: ReadonlyMap<string, string>, labels: string[], links: string[], references: string[]): string {
  let text = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
      case 'inlineCode':
      case 'inlineMath':
        text += node.value ?? '';
        break;
      case 'break':
        text += ' ';
        break;
      case 'footnoteReference':
        labels.push(node.label ?? node.identifier ?? '');
        break;
      case 'link':
        if ((node.url ?? '').startsWith('madarch:question:')) break;
        if ((node.url ?? '').startsWith('madarch:')) links.push(node.url!.slice('madarch:'.length));
        text += inlineText(node.children ?? [], definitions, labels, links, references);
        break;
      case 'linkReference': {
        const label = node.label ?? node.identifier ?? '';
        const target = definitions.get(label) ?? '';
        if (target.startsWith('madarch:question:')) break;
        references.push(label);
        if (target.startsWith('madarch:')) links.push(target.slice('madarch:'.length));
        text += inlineText(node.children ?? [], definitions, labels, links, references);
        break;
      }
      case 'image':
      case 'imageReference':
      case 'html':
        break;
      default:
        if (node.children !== undefined) text += inlineText(node.children, definitions, labels, links, references);
        break;
    }
  }
  return text;
}

const plain = (text: string): string => collapseSpace(text).trim();

/** The `madarch:` link targets of a definition's inline nodes, recursively. */
function linksOf(nodes: readonly Node[], definitions: ReadonlyMap<string, string>, out: string[]): void {
  for (const node of nodes) {
    if (node.type === 'link' && (node.url ?? '').startsWith('madarch:')) out.push(node.url!.slice('madarch:'.length));
    else if (node.type === 'linkReference') {
      const target = definitions.get(node.label ?? node.identifier ?? '') ?? '';
      if (target.startsWith('madarch:')) out.push(target.slice('madarch:'.length));
    }
    if (node.children !== undefined) linksOf(node.children, definitions, out);
  }
}

/** One inline run of a paragraph: the sentence up to a footnote-reference run, with its source span. */
export interface MarkdownSegment {
  /** The first footnote's name, suffixed `~2` from the second use, or null for prose with no reference. */
  readonly id: string | null;
  readonly labels: readonly string[];
  readonly text: string;
  readonly raw: string;
  readonly digest: string;
  readonly line: number;
  readonly mentions: readonly string[];
  readonly grounds: readonly string[];
  /** The labels of the reference-style links the passage stands on, so a named passage may change their targets. */
  readonly references: readonly string[];
}

/** One block the revision check compares: prose is read as segments; every other block must not change. */
export interface MarkdownBlock {
  readonly kind: 'paragraph' | 'other';
  readonly raw: string;
  readonly line: number;
  readonly segments: readonly MarkdownSegment[];
  readonly key: string;
}

export interface MarkdownReading {
  readonly blocks: readonly MarkdownBlock[];
  readonly statements: readonly PageStatement[];
}

/** The footnote definitions of a body, by label: each definition's `madarch:` links in order. */
function definitionsOf(root: Node): Map<string, string[]> {
  const definitions = new Map<string, string[]>();
  const targets = new Map<string, string>();
  const walk = (node: Node): void => {
    if (node.type === 'definition') targets.set(node.label ?? node.identifier ?? '', node.url ?? '');
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  for (const node of root.children ?? []) {
    if (node.type !== 'footnoteDefinition') continue;
    const label = node.label ?? node.identifier ?? '';
    if (definitions.has(label)) continue;
    const links: string[] = [];
    linksOf(node.children ?? [], targets, links);
    definitions.set(label, links);
  }
  return definitions;
}

/** Splits a paragraph's inline children after each footnote-reference run, preserving source slices. */
function segmentsOf(paragraph: Node, markdown: string, bodyLine: number, definitions: ReadonlyMap<string, string[]>, counts: Map<string, number>): MarkdownSegment[] {
  const children = paragraph.children ?? [];
  const out: MarkdownSegment[] = [];
  let run: Node[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const labels: string[] = [];
    const links: string[] = [];
    const references: string[] = [];
    const text = inlineText(run, new Map(), labels, links, references);
    const raw = collapseSpace(run.map((node) => slice(markdown, node)).join('')).trim();
    if (labels.length === 0 && plain(text) === '') { run = []; return; }
    const own = [...new Set(labels.flatMap((label) => definitions.get(label) ?? []))];
    const first = labels[0];
    let id: string | null = null;
    if (first !== undefined && first !== '') {
      const count = (counts.get(first) ?? 0) + 1;
      counts.set(first, count);
      id = count === 1 ? first : `${first}~${count}`;
    }
    const readerText = plain(text);
    out.push({
      id, labels, text: readerText, raw, digest: sha256Hex(new TextEncoder().encode(readerText)),
      line: lineOf(run[0]!, bodyLine), mentions: [...new Set(links)], grounds: own,
      references: [...new Set(references)],
    });
    run = [];
  };
  for (const [index, child] of children.entries()) {
    run.push(child);
    if (child.type !== 'footnoteReference') continue;
    const next = children[index + 1];
    if (next !== undefined && next.type === 'footnoteReference') continue;
    flush();
  }
  flush();
  return out;
}

/** The blocks of one body, in document order, each with its segments. */
function blocksOfBody(body: string, bodyLine: number, definitions: ReadonlyMap<string, string[]>): MarkdownBlock[] {
  const root = parseTree(body);
  const counts = new Map<string, number>();
  const blocks: MarkdownBlock[] = [];
  const walk = (nodes: readonly Node[]): void => {
    for (const node of nodes) {
      if (node.type === 'paragraph') {
        const segments = segmentsOf(node, body, bodyLine, definitions, counts);
        const raw = slice(body, node);
        blocks.push({ kind: 'paragraph', raw, line: lineOf(node, bodyLine), segments, key: `p\u0000${collapseSpace(raw)}` });
      } else if (node.type === 'list' || node.type === 'listItem' || node.type === 'blockquote') {
        walk(node.children ?? []);
      } else if (node.type === 'footnoteDefinition' || node.type === 'definition') {
        // Definitions are compared separately, by label, so a changed ground is judged against the passage that uses it.
      } else {
        const raw = slice(body, node);
        blocks.push({ kind: 'other', raw, line: lineOf(node, bodyLine), segments: [], key: `${node.type}\u0000${collapseSpace(raw)}` });
      }
    }
  };
  walk(root.children ?? []);
  return blocks;
}

/** A definition block by label, with the raw text and line that changed. */
interface DefinitionBlock {
  readonly kind: 'footnote' | 'link';
  readonly label: string;
  readonly raw: string;
  readonly line: number;
  /** The `madarch:` targets a footnote gives, or the URL of a reference definition, in order. */
  readonly targets: readonly string[];
}

function definitionsBlocks(body: string, bodyLine: number): DefinitionBlock[] {
  const root = parseTree(body);
  const targets = definitionsOf(root);
  const out: DefinitionBlock[] = [];
  const walk = (node: Node): void => {
    if (node.type === 'footnoteDefinition') {
      const label = node.label ?? node.identifier ?? '';
      out.push({ kind: 'footnote', label, raw: slice(body, node), line: lineOf(node, bodyLine), targets: targets.get(label) ?? [] });
      return;
    }
    if (node.type === 'definition') {
      const label = node.label ?? node.identifier ?? '';
      const url = node.url ?? '';
      out.push({ kind: 'link', label, raw: slice(body, node), line: lineOf(node, bodyLine), targets: url === '' ? [] : [url] });
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return out;
}

interface Reading {
  readonly blocks: readonly MarkdownBlock[];
  readonly definitions: readonly DefinitionBlock[];
}

function read(markdown: string): Reading {
  const split = splitFrontMatter(markdown.split('\r\n').join('\n'));
  const root = parseTree(split.body);
  const definitions = definitionsOf(root);
  return { blocks: blocksOfBody(split.body, split.bodyLine, definitions), definitions: definitionsBlocks(split.body, split.bodyLine) };
}

/** The blocks of a page as the revision check sees them. */
export function blocksOf(markdown: string): readonly MarkdownBlock[] {
  return read(markdown).blocks;
}

/** The grounded statements of a page, read from the parsed tree, in document order. */
export function statementsOfMarkdown(markdown: string, bodyLine = 1): PageStatement[] {
  const split = splitFrontMatter(markdown.split('\r\n').join('\n'));
  const body = split.body;
  const start = split.bodyLine === 1 ? bodyLine : split.bodyLine;
  const root = parseTree(body);
  const definitions = definitionsOf(root);
  const counts = new Map<string, number>();
  const out: PageStatement[] = [];
  const walk = (nodes: readonly Node[]): void => {
    for (const node of nodes) {
      if (node.type === 'paragraph') {
        for (const segment of segmentsOf(node, body, start, definitions, counts)) {
          if (segment.id === null) continue;
          out.push({ id: segment.id, labels: segment.labels, text: segment.text, digest: segment.digest, line: segment.line, mentions: segment.mentions, grounds: segment.grounds });
        }
      } else if (node.type === 'list' || node.type === 'listItem' || node.type === 'blockquote') walk(node.children ?? []);
    }
  };
  walk(root.children ?? []);
  return out;
}

// A segment is matched by its source shape, so emphasis, a link target or any other Markdown a reader sees is part of
// the passage. The footnote reference itself is outside the segment, so the name the core gives it never enters the
// signature, and a rename is not a change (madarch-ztyq.9, review 199).
const signature = (segment: MarkdownSegment): string => collapseSpace(segment.raw);

/** Which items of two sequences are equal, as an LCS; false means the old item changed or went and the new one came. */
function lcs(left: readonly string[], right: readonly string[]): { left: boolean[]; right: boolean[] } {
  const rows = left.length + 1;
  const columns = right.length + 1;
  const table: number[] = new Array(rows * columns).fill(0);
  const at = (row: number, column: number): number => table[row * columns + column]!;
  for (let row = left.length - 1; row >= 0; row -= 1) {
    for (let column = right.length - 1; column >= 0; column -= 1) {
      table[row * columns + column] = left[row] === right[column] ? at(row + 1, column + 1) + 1 : Math.max(at(row + 1, column), at(row, column + 1));
    }
  }
  const matchedLeft = new Array<boolean>(left.length).fill(false);
  const matchedRight = new Array<boolean>(right.length).fill(false);
  let row = 0;
  let column = 0;
  while (row < left.length && column < right.length) {
    if (left[row] === right[column]) { matchedLeft[row] = true; matchedRight[column] = true; row += 1; column += 1; }
    else if (at(row + 1, column) >= at(row, column + 1)) row += 1;
    else column += 1;
  }
  return { left: matchedLeft, right: matchedRight };
}

/**
 * What a revision changed that it was not asked to change, each with the page's file, line and full path.
 * A named passage is a statement id the editorial pass showed; front matter is not compared.
 */
export function revisionScopeProblems(file: string, fullPath: string, before: string, after: string, passages: readonly string[]): string[] {
  const old = read(before);
  const next = read(after);
  const problems: string[] = [];
  const allowed = new Set(passages);
  const where = (line: number): string => `${fullPath}:${line}: ${file}`;
  // A definition may change only when a passage that stands on it was named: its ground is part of that passage.
  // Both the footnote labels and the reference-link labels a named segment stands on count, because the core may
  // rename a footnote after the sentence it grounds without changing the evidence (madarch-ztyq.9, review 199).
  const namedFootnotes = new Set<string>();
  const namedLinks = new Set<string>();
  for (const block of [...old.blocks, ...next.blocks]) {
    for (const segment of block.segments) {
      if (segment.id === null || !allowed.has(segment.id)) continue;
      for (const label of segment.labels) namedFootnotes.add(label);
      for (const label of segment.references) namedLinks.add(label);
    }
  }
  const allowedDefinition = (definition: DefinitionBlock): boolean => (definition.kind === 'footnote' ? namedFootnotes : namedLinks).has(definition.label);
  const keyOf = (definition: DefinitionBlock): string => `${definition.kind}\u0000${definition.label}`;
  const oldDefinitions = new Map(old.definitions.map((definition) => [keyOf(definition), definition]));
  const newDefinitions = new Map(next.definitions.map((definition) => [keyOf(definition), definition]));
  const oldOnly = [...oldDefinitions.values()].filter((definition) => !newDefinitions.has(keyOf(definition)));
  const newOnly = [...newDefinitions.values()].filter((definition) => !oldDefinitions.has(keyOf(definition)));
  const sameTargets = (left: DefinitionBlock, right: DefinitionBlock): boolean => left.kind === right.kind && left.targets.length === right.targets.length && left.targets.every((target, index) => target === right.targets[index]);
  // The core names a footnote after the sentence it grounds, so a renamed definition with the same targets is the
  // same evidence. Pair those first; only a label whose ground also changed needs a named passage's room.
  const paired = new Set<string>();
  const remainingOld: DefinitionBlock[] = [];
  for (const was of oldOnly) {
    // Only the core renames a footnote, after the sentence it grounds; a reference label is the agent's own and a
    // rename of one is a change, even when its URL stayed the same (madarch-ztyq.9, review 199).
    const match = was.kind === 'footnote' ? newOnly.find((is) => is.kind === 'footnote' && !paired.has(keyOf(is)) && sameTargets(was, is)) : undefined;
    if (match === undefined) remainingOld.push(was);
    else paired.add(keyOf(match));
  }
  // A named passage may have its definition renamed by the core, so one allowed old label makes room for one new
  // label. An unrelated removed or added definition has no room and is a change the pass did not ask for.
  let renamed = remainingOld.filter(allowedDefinition).length;
  const definitionProblem = (definition: DefinitionBlock, action: string): string => {
    const line = definition.line;
    const shown = definition.kind === 'footnote' ? `[^${definition.label}]` : `[${definition.label}]`;
    const what = definition.kind === 'footnote' ? 'footnote definition' : 'reference definition';
    return `${where(line)}: the revision ${action} the ${what} ${shown}, but no named passage stands on it; a revision may change only the passages it was asked about (${[...allowed].join(', ') || 'none'})`;
  };
  for (const was of remainingOld) {
    if (allowedDefinition(was)) continue;
    problems.push(definitionProblem(was, 'removes'));
  }
  for (const is of newOnly) {
    if (paired.has(keyOf(is))) continue;
    if (renamed > 0) { renamed -= 1; continue; }
    problems.push(definitionProblem(is, 'adds'));
  }
  for (const [key, was] of oldDefinitions) {
    const is = newDefinitions.get(key);
    if (is === undefined) continue;
    if (sameTargets(was, is)) continue;
    if (allowedDefinition(was)) continue;
    problems.push(definitionProblem(is, 'changes'));
  }
  const oldBlocks = old.blocks;
  const newBlocks = next.blocks;
  const matched = lcs(oldBlocks.map((block) => block.key), newBlocks.map((block) => block.key));
  const runs: { old: MarkdownBlock[]; next: MarkdownBlock[] }[] = [];
  let run: { old: MarkdownBlock[]; next: MarkdownBlock[] } = { old: [], next: [] };
  const flush = (): void => { if (run.old.length > 0 || run.next.length > 0) runs.push(run); run = { old: [], next: [] }; };
  let oldAt = 0;
  let newAt = 0;
  while (oldAt < oldBlocks.length || newAt < newBlocks.length) {
    if (oldAt < oldBlocks.length && !matched.left[oldAt]) { run.old.push(oldBlocks[oldAt]!); oldAt += 1; continue; }
    if (newAt < newBlocks.length && !matched.right[newAt]) { run.next.push(newBlocks[newAt]!); newAt += 1; continue; }
    flush();
    if (oldAt < oldBlocks.length) oldAt += 1;
    if (newAt < newBlocks.length) newAt += 1;
  }
  flush();
  for (const held of runs) {
    const firstLine = held.old[0]?.line ?? held.next[0]?.line ?? 1;
    const structure = held.old.some((block) => block.kind !== 'paragraph') || held.next.some((block) => block.kind !== 'paragraph');
    if (structure) {
      problems.push(`${where(firstLine)}: the revision changes headings, code or another non-prose block; a revision may change only the passages it was asked about (${[...allowed].join(', ') || 'none'})`);
      continue;
    }
    // The changed paragraphs pair one for one: a revision may rewrite a named passage, but it may not add a
    // paragraph beside it or drop one, because that is prose the editorial pass did not ask about.
    if (held.old.length !== held.next.length) {
      const line = held.next[held.old.length]?.line ?? held.old[held.next.length]?.line ?? firstLine;
      const what = held.next.length > held.old.length ? 'adds a paragraph' : 'removes a paragraph';
      problems.push(`${where(line)}: the revision ${what} beside the named passages; a revision may change only the passages it was asked about (${[...allowed].join(', ') || 'none'})`);
      continue;
    }
    const unnamedBlock = held.old.find((block) => !block.segments.some((segment) => segment.id !== null && allowed.has(segment.id)));
    if (unnamedBlock !== undefined) {
      problems.push(`${where(unnamedBlock.line)}: the revision changes ${JSON.stringify(unnamedBlock.segments[0]?.text ?? collapseSpace(unnamedBlock.raw))}, which is not a named passage; a revision may change only the passages it was asked about (${[...allowed].join(', ') || 'none'})`);
      continue;
    }
    const oldSegments = held.old.flatMap((block) => block.segments);
    const newSegments = held.next.flatMap((block) => block.segments);
    const segmentMatch = lcs(oldSegments.map(signature), newSegments.map(signature));
    const removed = oldSegments.filter((_segment, index) => !segmentMatch.left[index]);
    const added = newSegments.filter((_segment, index) => !segmentMatch.right[index]);
    const outside = removed.filter((segment) => segment.id === null || !allowed.has(segment.id));
    if (outside.length > 0) {
      problems.push(`${where(outside[0]!.line)}: the revision changes ${JSON.stringify(outside[0]!.text)} or removes it, which is not a named passage; a revision may change only the passages it was asked about (${[...allowed].join(', ') || 'none'})`);
      continue;
    }
    if (removed.length === 0 && added.length > 0) {
      problems.push(`${where(added[0]!.line)}: the revision inserts ${JSON.stringify(added[0]!.text)} without changing a named passage; a revision may not add prose of its own`);
      continue;
    }
    if (removed.length > 0 && added.length === 0) {
      problems.push(`${where(removed[0]!.line)}: the revision removes ${JSON.stringify(removed[0]!.text)}; a revision may rewrite a named passage but may not delete it`);
      continue;
    }
    if (removed.length !== added.length) {
      problems.push(`${where(removed[0]!.line)}: the revision turns ${removed.length} named passage${removed.length === 1 ? '' : 's'} into ${added.length} passage${added.length === 1 ? '' : 's'}; a revision may rewrite a named passage but may not add or delete prose`);
    }
  }
  return problems;
}
