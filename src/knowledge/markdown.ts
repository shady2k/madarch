/**
 * The Markdown the product repository holds (decision 0029; the vertical's
 * shared formats, section 1): one file per entity, front matter with its
 * identity and what it relates to, a body whose statements end in footnotes
 * that list their grounds as `madarch:` links.
 *
 * This module reads the files and the body. It resolves nothing against the
 * graph; `grounds.ts` does that. It judges only what the file itself can show:
 * a footnote reference with no definition, a footnote that lists no ground, and
 * the statements that carry no footnote at all.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { LineCounter, parseDocument } from 'yaml';
import { byCodePoint } from '../model/order.js';
import type { Finding, KindDecl, KindsManifest } from './kinds.js';

/** The scheme of an entity link. */
export const SCHEME = 'madarch:';

export interface MarkdownEntity {
  /** `kind:slug`. */
  id: string;
  kind: string;
  title: string;
  /** The graph keys the page is about. */
  relates: string[];
  producer: string | null;
  sources: string[];
  /** The body, front matter removed. */
  body: string;
  /** The line the body starts at in the file. */
  bodyLine: number;
  /** Repository-relative path of the file. */
  file: string;
  /** The front matter as written, for attributes. */
  front: Record<string, unknown>;
}

/** The front matter and body of a Markdown file; the front matter is null when the file has none. */
export function splitFrontMatter(text: string): { front: string | null; body: string; bodyLine: number } {
  const normalized = text.startsWith('\uFEFF') ? text.slice(1) : text;
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) return { front: null, body: normalized, bodyLine: 1 };
  const lines = normalized.split('\n');
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if ((line.endsWith('\r') ? line.slice(0, -1) : line) === '---') {
      return { front: lines.slice(1, index).join('\n'), body: lines.slice(index + 1).join('\n'), bodyLine: index + 2 };
    }
  }
  return { front: null, body: normalized, bodyLine: 1 };
}

/** The Markdown files below a folder, `/`-separated and in code point order. */
export function markdownFilesBelow(root: string, folder: string): string[] {
  const out: string[] = [];
  const walk = (directory: string): void => {
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      return;
    }
    for (const name of names.sort(byCodePoint)) {
      const full = join(directory, name);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) walk(full);
      else if (stats.isFile() && name.endsWith('.md')) out.push(relative(root, full).split('\\').join('/'));
    }
  };
  walk(join(root, folder));
  return out;
}

/** Reads one Markdown file as an entity of the kind; null with findings when it is not one. */
export function readMarkdownEntity(productFolder: string, path: string, decl: KindDecl, findings: Finding[]): MarkdownEntity | null {
  const full = join(productFolder, path);
  let text: string;
  try {
    text = readFileSync(full, 'utf8');
  } catch (error) {
    findings.push({ file: path, line: 1, message: `the file cannot be read: ${(error as Error).message}` });
    return null;
  }
  const { front, body, bodyLine } = splitFrontMatter(text);
  if (front === null) {
    findings.push({ file: path, line: 1, message: `the file has no front matter: an entity of kind "${decl.name}" starts with --- , its id and its kind, ---` });
    return null;
  }
  const lines = new LineCounter();
  const doc = parseDocument(front, { lineCounter: lines });
  if (doc.errors.length > 0) {
    findings.push({ file: path, line: 1 + (doc.errors[0]!.linePos?.[0].line ?? 1), message: `the front matter is not YAML: ${doc.errors[0]!.message.split('\n')[0]}` });
    return null;
  }
  const value: unknown = doc.toJS();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    findings.push({ file: path, line: 2, message: 'the front matter is a mapping' });
    return null;
  }
  const record = value as Record<string, unknown>;
  const problem = (message: string, line = 2): null => {
    findings.push({ file: path, line, message });
    return null;
  };
  const id = record['id'];
  if (typeof id !== 'string' || !/^[^:\s]+:\S+$/.test(id)) return problem(`"id" is the kind, a colon and a slug, such as "${decl.name}:name"; got ${JSON.stringify(id)}`);
  if (!id.startsWith(`${decl.name}:`)) return problem(`the id "${id}" does not start with "${decl.name}:", the kind the manifest gives this place`);
  if (record['kind'] !== decl.name) return problem(`"kind" is "${decl.name}" in the manifest and ${JSON.stringify(record['kind'])} here`);
  const relates = record['relates'];
  if (relates !== undefined && (!Array.isArray(relates) || relates.some((entry) => typeof entry !== 'string'))) return problem('"relates" is a list of graph keys');
  const sources = record['sources'];
  if (sources !== undefined && (!Array.isArray(sources) || sources.some((entry) => typeof entry !== 'string'))) return problem('"sources" is a list of texts');
  const title = record['title'];
  if (title !== undefined && typeof title !== 'string') return problem('"title" is a text');
  const producer = record['producer'];
  if (producer !== undefined && producer !== 'agent' && producer !== 'person') return problem('"producer" is "agent" or "person"');
  return {
    id,
    kind: decl.name,
    title: typeof title === 'string' && title !== '' ? title : id.slice(id.indexOf(':') + 1),
    relates: (relates as string[] | undefined) ?? [],
    producer: (producer as string | undefined) ?? null,
    sources: (sources as string[] | undefined) ?? [],
    body,
    bodyLine,
    file: path,
    front: record,
  };
}

/** Every Markdown entity the manifest places in the product repository. */
export function readMarkdownEntities(productFolder: string, manifest: KindsManifest): { entities: MarkdownEntity[]; findings: Finding[] } {
  const findings: Finding[] = [];
  const entities: MarkdownEntity[] = [];
  for (const decl of manifest.kinds.values()) {
    if (decl.source !== 'markdown') continue;
    const paths = decl.file !== undefined ? [decl.file] : markdownFilesBelow(productFolder, decl.folder!);
    for (const path of paths) {
      try {
        if (!statSync(join(productFolder, path)).isFile()) continue;
      } catch {
        continue; // the singleton's file is simply not written yet
      }
      const entity = readMarkdownEntity(productFolder, path, decl, findings);
      if (entity !== null) entities.push(entity);
    }
  }
  const seen = new Map<string, MarkdownEntity>();
  const unique: MarkdownEntity[] = [];
  for (const entity of entities) {
    const first = seen.get(entity.id);
    if (first !== undefined) {
      findings.push({ file: entity.file, line: 2, message: `the id "${entity.id}" is also the id of ${first.file}; an id names one entity` });
      continue;
    }
    seen.set(entity.id, entity);
    unique.push(entity);
  }
  return { entities: unique.sort((a, b) => byCodePoint(a.id, b.id)), findings };
}

// ---- the body ---------------------------------------------------------------------------------

interface Node {
  type: string;
  value?: string;
  url?: string;
  identifier?: string;
  label?: string;
  children?: Node[];
  position?: { start: { line: number; offset?: number }; end: { line: number; offset?: number } };
}

const parser = unified().use(remarkParse).use(remarkGfm);

/** A `madarch:` target found in a Markdown text, with the line it stands on. */
export interface FoundLink {
  /** The destination as written, `madarch:` included. */
  url: string;
  line: number;
  /** True when the link stands in a footnote definition: a ground. */
  ground: boolean;
}

export interface BodyReading {
  links: FoundLink[];
  findings: Finding[];
  /** The statements with no footnote, with the line each starts on. */
  ungrounded: { text: string; line: number }[];
  /** How many statements the body makes. */
  statements: number;
}

/**
 * The plain text of a node, with a footnote reference standing as `\u0001<label>\u0002` so sentences can be told grounded
 * and the notes that ground each can be named.
 */
function flatten(node: Node, out: string[]): void {
  // A `[^n]` the parser left as text names a note that is not defined: it grounds nothing and is not part of the statement.
  if (node.type === 'text') out.push((node.value ?? '').replace(/\[\^[^\]\s]+\]/g, ''));
  else if (node.type === 'inlineCode') out.push(node.value ?? '');
  else if (node.type === 'footnoteReference') out.push(`\u0001${node.identifier ?? node.label ?? ''}\u0002`);
  else if (node.type === 'break') out.push(' ');
  else for (const child of node.children ?? []) flatten(child, out);
}

/** A sentence of a paragraph and the labels of the footnotes that end it. */
interface Sentence {
  text: string;
  grounded: boolean;
  notes: string[];
}

/**
 * Statements of a paragraph: sentences ending in . ! ? followed by a blank (the footnote reference after the full stop
 * belongs to the sentence). A formatted run (bold, a link, code) is one piece: a sentence is cut only at a blank in the
 * paragraph's own text, so the app, which cuts the same tree, finds the same sentences (`statements.ts` in the app).
 */
function sentencesOf(paragraph: Node): Sentence[] {
  const sentences: Sentence[] = [];
  let current = '';
  let terminated = false;
  const close = (): void => {
    const notes = [...current.matchAll(/\u0001([^\u0002]*)\u0002/g)].map((match) => match[1]!);
    const text = current.replace(/\u0001[^\u0002]*\u0002/g, '').trim();
    if (text !== '') sentences.push({ text, grounded: notes.length > 0, notes });
    current = '';
    terminated = false;
  };
  for (const child of paragraph.children ?? []) {
    const parts: string[] = [];
    flatten(child, parts);
    const flat = parts.join('');
    // The footnote references inside the piece stay in the sentence and say nothing of where it ends.
    for (const piece of flat.split(/(\u0001[^\u0002]*\u0002)/)) {
      if (piece.startsWith('\u0001')) {
        current += piece;
        continue;
      }
      for (const char of piece) {
        if (terminated && /\s/.test(char)) {
          // Only the paragraph's own text ends a sentence at a blank; inside a formatted run the blank is part of it.
          if (child.type === 'text') close();
          else current += char;
          continue;
        }
        if (terminated && !/[.!?)"'\u201d]/.test(char)) terminated = false;
        current += char;
        if (/[.!?]/.test(char)) terminated = true;
      }
    }
  }
  close();
  return sentences;
}

/** Text that connects rather than states: a heading-like line, "See also", or a line of only links. */
function isConnecting(paragraph: Node, sentenceText: string): boolean {
  const words = sentenceText.split(/\s+/).filter(Boolean);
  if (words.length < 4 || /^(see|see also|related|next)\b/i.test(sentenceText)) return true;
  const onlyLinks = (paragraph.children ?? []).every((child) => child.type === 'link' || (child.type === 'text' && (child.value ?? '').trim().replace(/[,;:.\-–—]/g, '') === ''));
  return onlyLinks;
}

/** Links inside Markdown headings, including reference links resolved by the same parsed document. */
export function headingLinks(body: string, bodyLine: number): FoundLink[] {
  const tree = parser.parse(body) as unknown as Node;
  const definitions = new Map<string, string>();
  const collect = (node: Node): void => {
    if (node.type === 'definition' && node.identifier !== undefined && node.url !== undefined && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
    for (const child of node.children ?? []) collect(child);
  };
  collect(tree);
  const links: FoundLink[] = [];
  const walk = (node: Node, inHeading: boolean): void => {
    const heading = inHeading || node.type === 'heading';
    const url = node.type === 'link' ? node.url : node.type === 'linkReference' && node.identifier !== undefined ? definitions.get(node.identifier) : undefined;
    if (heading && url !== undefined) links.push({ url, line: bodyLine - 1 + (node.position?.start.line ?? 1), ground: false });
    for (const child of node.children ?? []) walk(child, heading);
  };
  walk(tree, false);
  return links;
}

/** Reads a body: its `madarch:` links, its footnote problems and its ungrounded statements. Lines are the file's. */
export function readBody(body: string, file: string, bodyLine: number): BodyReading {
  const tree = parser.parse(body) as unknown as Node;
  const links: FoundLink[] = [];
  const findings: Finding[] = [];
  const ungrounded: { text: string; line: number }[] = [];
  const references = new Map<string, number>();
  const definitions = new Map<string, { line: number; grounds: number }>();
  let statements = 0;
  const lineOf = (node: Node): number => (node.position?.start.line ?? 1) - 1 + bodyLine;
  const walk = (node: Node, inGround: boolean, inQuote: boolean): void => {
    if (node.type === 'link' || node.type === 'definition') {
      if (typeof node.url === 'string' && node.url.startsWith(SCHEME)) links.push({ url: node.url, line: lineOf(node), ground: inGround });
    }
    if (node.type === 'footnoteReference') {
      const id = node.identifier ?? node.label ?? '';
      if (!references.has(id)) references.set(id, lineOf(node));
    }
    if (node.type === 'text') {
      for (const match of (node.value ?? '').matchAll(/\[\^([^\]\s]+)\]/g)) {
        const id = match[1]!.toLowerCase();
        if (!references.has(id)) references.set(id, lineOf(node));
      }
    }
    if (node.type === 'footnoteDefinition') {
      const id = node.identifier ?? node.label ?? '';
      const before = links.length;
      for (const child of node.children ?? []) walk(child, true, inQuote);
      definitions.set(id, { line: lineOf(node), grounds: links.length - before });
      return;
    }
    if (node.type === 'paragraph' && !inGround) {
      for (const sentence of sentencesOf(node)) {
        if (isConnecting(node, sentence.text)) continue;
        statements += 1;
        if (!sentence.grounded) ungrounded.push({ text: sentence.text, line: lineOf(node) });
      }
    }
    for (const child of node.children ?? []) walk(child, inGround, inQuote);
  };
  walk(tree, false, false);
  for (const [id, line] of references) {
    if (!definitions.has(id)) findings.push({ file, line, message: `the footnote [^${id}] is used and never defined` });
  }
  for (const [id, definition] of definitions) {
    if (definition.grounds === 0) findings.push({ file, line: definition.line, message: `the footnote [^${id}] lists no ground: a footnote is a list of madarch: links` });
  }
  return { links, findings, ungrounded, statements };
}

/** A `madarch:` target without its scheme; the anchor of a document target is split off. */
export function parseTarget(url: string): { kind: 'key'; key: string } | { kind: 'doc'; path: string; anchor: string | null } {
  let target = url.slice(SCHEME.length);
  try {
    target = decodeURIComponent(target);
  } catch {
    // an escape that does not decode is taken as written; resolution then fails by name
  }
  if (target.startsWith('doc:')) {
    const rest = target.slice('doc:'.length);
    const hash = rest.indexOf('#');
    return hash < 0 ? { kind: 'doc', path: rest, anchor: null } : { kind: 'doc', path: rest.slice(0, hash), anchor: rest.slice(hash + 1) };
  }
  return { kind: 'key', key: target };
}


// ---- statements -------------------------------------------------------------------------------

/** One statement of a body: its sentence, the paragraph it stands in, and the notes that ground it. */
export interface Statement {
  text: string;
  /** The file's line the paragraph starts at. */
  line: number;
  /** The paragraph as written in the body, footnote references removed. */
  paragraph: string;
  /** The labels of the footnotes that end the sentence; empty when it is ungrounded. */
  notes: string[];
}

export interface StatementReading {
  statements: Statement[];
  /** The `madarch:` destinations each footnote lists, by its label, in the order written. */
  definitions: Map<string, string[]>;
}

/** Reads a body's statements with their paragraphs and its footnotes' grounds (the sentences `readBody` counts). */
export function readStatements(body: string, bodyLine: number): StatementReading {
  const tree = parser.parse(body) as unknown as Node;
  const statements: Statement[] = [];
  const definitions = new Map<string, string[]>();
  const lineOf = (node: Node): number => (node.position?.start.line ?? 1) - 1 + bodyLine;
  const urlsIn = (node: Node, out: string[]): void => {
    if ((node.type === 'link' || node.type === 'definition') && typeof node.url === 'string' && node.url.startsWith(SCHEME)) out.push(node.url);
    for (const child of node.children ?? []) urlsIn(child, out);
  };
  const walk = (node: Node): void => {
    if (node.type === 'footnoteDefinition') {
      const urls: string[] = [];
      urlsIn(node, urls);
      definitions.set(node.identifier ?? node.label ?? '', urls);
      return;
    }
    if (node.type === 'paragraph') {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      const paragraph = start === undefined || end === undefined ? '' : body.slice(start, end).replace(/\[\^[^\]\s]+\]/g, '').replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' ').trim();
      for (const sentence of sentencesOf(node)) {
        if (isConnecting(node, sentence.text)) continue;
        statements.push({ text: sentence.text, line: lineOf(node), paragraph, notes: sentence.notes });
      }
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return { statements, definitions };
}
