/**
 * A Markdown document as a tree, with the exact place of every node
 * (madarch-ztyq.3, decision 0032 section 4). A real parser reads the document —
 * unified with remark-parse and GFM — so a section is a heading and the blocks
 * under it, not an expression over lines; every node carries the lines, the
 * character offsets and the UTF-8 byte offsets of its own source, and a node
 * the parser gives no place to is a finding, never a silently smaller result.
 *
 * The tree is what the passes of `doc-entities.ts` read: heading ancestry and
 * list nesting are its structure, a block is a list item or a paragraph with the
 * source it holds, and every section keeps the document's own text, so a meaning
 * read in it never rewrites what the person wrote.
 */
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { parse as parseYaml } from 'yaml';
import type { Finding } from './kinds.js';
import { splitFrontMatter } from './markdown.js';

/** A Markdown document as read: where it is and its text. */
export interface DocumentSource {
  /** The code repository's name; null for the product repository. */
  repo: string | null;
  path: string;
  text: string;
}

/** The block kinds a section is made of; anything else is `other`. */
export type DocNodeType = 'heading' | 'paragraph' | 'list' | 'listItem' | 'code' | 'blockquote' | 'table' | 'html' | 'thematicBreak' | 'definition'
  | 'strong' | 'emphasis' | 'text' | 'inlineCode' | 'other';

/** One node of a document's tree. */
export interface DocNode {
  type: DocNodeType;
  /** The heading's level, for a heading (1 to 6). */
  level?: number;
  /** The node's source, as the document writes it. */
  raw: string;
  /** The node's text with the Markdown marks removed, its lines kept. */
  plain: string;
  /** The 1-based line the node starts at, and the last line it covers. */
  line: number;
  endLine: number;
  /** The node's source range: character offsets into the document's text, and the same as UTF-8 byte offsets. */
  startOffset: number;
  endOffset: number;
  startByte: number;
  endByte: number;
  children: DocNode[];
}

/** A heading's section: the heading, the blocks it holds, and the sections it opens. */
export interface DocSection {
  /** The heading that names the section; null for the part before the document's first heading. */
  heading: DocNode | null;
  /** The heading's level; 0 for the part before the first heading. */
  level: number;
  /** The heading texts that enclose the section, from the document's first heading down to it. */
  headingPath: string[];
  /** The section's own blocks, in document order; a sub-section's blocks are in the sub-section. */
  nodes: DocNode[];
  /** The 1-based line the section starts at, and the last line of everything it covers. */
  line: number;
  endLine: number;
  /** The section's text without the line that names it. */
  text: string;
}

export interface DocTree {
  repo: string | null;
  path: string;
  text: string;
  /** The front matter as written, or null when the document has none. */
  front: string | null;
  /** The front matter read as YAML, when it reads as a mapping. */
  meta: Record<string, unknown> | null;
  nodes: DocNode[];
  sections: DocSection[];
  findings: Finding[];
}

const PARSER = unified().use(remarkParse).use(remarkGfm);

const TYPES = new Map<string, DocNodeType>(Object.entries({
  heading: 'heading' as const, paragraph: 'paragraph' as const, list: 'list' as const, listItem: 'listItem' as const,
  code: 'code' as const, blockquote: 'blockquote' as const, table: 'table' as const, html: 'html' as const,
  thematicBreak: 'thematicBreak' as const, definition: 'definition' as const,
  strong: 'strong' as const, emphasis: 'emphasis' as const, text: 'text' as const, inlineCode: 'inlineCode' as const,
}));

interface RawNode {
  type: string;
  depth?: number;
  value?: string;
  children?: RawNode[];
  position?: { start: { line: number; column: number; offset?: number }; end: { line: number; column: number; offset?: number } };
}

/** The text of a node with its marks removed: the values of its leaves, in order. */
function plainOf(node: RawNode): string {
  if (node.children !== undefined && node.children.length > 0) return node.children.map(plainOf).join('');
  return node.value ?? '';
}

/** The document with its front matter blanked, so every other line keeps its number and its offset. */
function maskFrontMatter(text: string, bodyLine: number): string {
  const lines = text.split('\n');
  for (let index = 0; index < Math.min(bodyLine - 1, lines.length); index += 1) lines[index] = ' '.repeat(lines[index]!.length);
  return lines.join('\n');
}

/** The UTF-8 byte offset of every line start, and the code points of the text counted once. */
function lineBytes(text: string): { starts: number[]; bytes: number[] } {
  const starts = [0];
  const bytes = [0];
  let count = 0;
  for (let at = 0; at < text.length;) {
    const code = text.codePointAt(at)!;
    count += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    at += code > 0xffff ? 2 : 1;
    if (text[at - 1] === '\n') { starts.push(at); bytes.push(count); }
  }
  return { starts, bytes };
}

/** Reads one document into a tree of nodes and sections; everything that cannot be read is a finding with its line. */
export function readDocTree(source: DocumentSource): DocTree {
  const findings: Finding[] = [];
  const where = source.repo === null ? source.path : `repos/${source.repo}/${source.path}`;
  const { front, bodyLine } = splitFrontMatter(source.text);
  let meta: Record<string, unknown> | null = null;
  if (front !== null) {
    try {
      const value: unknown = parseYaml(front);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) meta = value as Record<string, unknown>;
      else findings.push({ file: where, line: 2, message: 'the front matter is a mapping of fields, and it is read as none' });
    } catch (error) {
      const at = /at line (\d+)/.exec((error as Error).message);
      findings.push({ file: where, line: at === null ? 2 : 1 + Number(at[1]), message: `the front matter is not valid YAML and is read as none: ${(error as Error).message.split('\n')[0]}` });
    }
  }
  const text = front === null ? source.text : maskFrontMatter(source.text, bodyLine);
  let parsed: RawNode;
  try {
    parsed = PARSER.parse(text) as unknown as RawNode;
  } catch (error) {
    findings.push({ file: where, line: 1, message: `the document cannot be parsed, so no section of it is read: ${(error as Error).message}` });
    return { repo: source.repo, path: source.path, text: source.text, front, meta, nodes: [], sections: [], findings };
  }
  const { starts, bytes } = lineBytes(text);
  const byteAt = (offset: number): number => {
    let low = 0;
    let high = starts.length - 1;
    let line = 0;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (starts[middle]! <= offset) { line = middle; low = middle + 1; } else high = middle - 1;
    }
    return bytes[line]! + Buffer.byteLength(text.slice(starts[line]!, Math.max(offset, starts[line]!)), 'utf8');
  };
  const nodeOf = (raw: RawNode): DocNode => {
    const position = raw.position;
    const start = position?.start.offset ?? 0;
    const end = position?.end.offset ?? start;
    if (position?.start.offset === undefined || position?.end.offset === undefined) {
      findings.push({ file: where, line: position?.start.line ?? 1, message: `the parser gave the ${raw.type} no source range, so its text is read as no section` });
    }
    return {
      type: TYPES.get(raw.type) ?? 'other',
      ...(raw.depth === undefined ? {} : { level: raw.depth }),
      raw: text.slice(start, end),
      plain: plainOf(raw),
      line: position?.start.line ?? 1,
      endLine: position?.end.line ?? position?.start.line ?? 1,
      startOffset: start,
      endOffset: end,
      startByte: byteAt(start),
      endByte: byteAt(end),
      children: (raw.children ?? []).map(nodeOf),
    };
  };
  const nodes = (parsed.children ?? []).map(nodeOf);
  return { repo: source.repo, path: source.path, text: source.text, front, meta, nodes, sections: sectionsOf(nodes, text), findings };
}

/** The sections of a document's top-level nodes: a heading with its own blocks, and the sections it opens. */
export function sectionsOf(nodes: readonly DocNode[], text: string): DocSection[] {
  // starts[i] is the character offset of the (i + 1)th line, and the text's length past the last one.
  const starts = [0];
  for (let at = 0; at < text.length; at += 1) if (text[at] === '\n') starts.push(at + 1);
  const startOf = (line: number): number => (line <= 1 ? 0 : starts[Math.min(line - 1, starts.length - 1)] ?? text.length);
  const endOf = (line: number): number => (line + 1 <= starts.length ? starts[line]! : text.length);
  const sections: DocSection[] = [];
  const open: DocSection[] = [];
  const extend = (node: DocNode): void => { for (const section of open) if (node.endLine > section.endLine) section.endLine = node.endLine; };
  for (const node of nodes) {
    if (node.type === 'heading') {
      const level = node.level ?? 6;
      while (open.length > 0 && open[open.length - 1]!.level >= level) open.pop();
      const parent = open[open.length - 1];
      const section: DocSection = { heading: node, level, headingPath: [...(parent?.headingPath ?? []), node.plain], nodes: [], line: node.line, endLine: node.endLine, text: '' };
      open.push(section);
      sections.push(section);
      extend(node);
      continue;
    }
    const top = open[open.length - 1];
    if (top === undefined) {
      const held = sections.find((section) => section.heading === null);
      if (held === undefined) sections.push({ heading: null, level: 0, headingPath: [], nodes: [node], line: node.line, endLine: node.endLine, text: '' });
      else { held.nodes.push(node); held.endLine = Math.max(held.endLine, node.endLine); }
      continue;
    }
    top.nodes.push(node);
    extend(node);
  }
  for (const section of sections) {
    const from = section.heading === null ? startOf(section.line) : section.heading.endOffset;
    section.text = text.slice(from, endOf(section.endLine)).trim();
  }
  return sections;
}
