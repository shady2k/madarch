/**
 * The glossary of a product (decision 0031): the terms of the documents its
 * manifest names as glossaries (a kind with `terms:`), each a document entity
 * (`doc-entities.ts`) read here into plain fields.
 *
 * A term is a bold phrase that opens a list item. The item says what the term
 * means in plain words and may list under it, one per line:
 *
 * ```markdown
 * - **Payment token** - The proof a provider returns when it captured money.
 *   - Also called: payment proof, token of payment
 *   - In code: `PaymentToken`, `CardToken`
 *   - Used in: [the architecture](docs/architecture.md)
 *   - Ambiguous: the documents also use it for the vault reference; see [Q-3](docs/questions/q-3.md)
 * ```
 *
 * The labels are fixed words in the two interface languages. Nothing is
 * guessed: a line that is not one of them is part of the definition.
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { byCodePoint } from '../model/order.js';
import type { DocEntity } from './doc-entities.js';
import type { KindsManifest } from './kinds.js';
import { detectDocumentLanguage, type LocalizedDocumentSource } from '../writer/localized-source.js';

export type TermField = 'synonyms' | 'code' | 'usedIn' | 'ambiguous';

/** The label words of the sub-items, lower case, per field. */
const LABELS: Readonly<Record<string, TermField>> = {
  'also called': 'synonyms', 'synonyms': 'synonyms', 'также называют': 'synonyms', 'синонимы': 'synonyms',
  'in code': 'code', 'code names': 'code', 'в коде': 'code',
  'used in': 'usedIn', 'где используется': 'usedIn',
  'ambiguous': 'ambiguous', 'неоднозначно': 'ambiguous', 'неоднозначный': 'ambiguous',
};

export interface TermFields {
  /** The definition in plain words, Markdown. */
  definition: string;
  synonyms: string[];
  code: string[];
  /** Where the term is used, Markdown as written. */
  usedIn: string | null;
  /** Why the term is ambiguous, Markdown as written (it may link to an open question); null for an unambiguous term. */
  ambiguous: string | null;
}

interface TermNode {
  readonly type: string;
  readonly value?: string;
  readonly position?: { readonly start: { readonly offset: number }; readonly end: { readonly offset: number } };
  readonly children?: readonly TermNode[];
}

const termProcessor = unified().use(remarkParse).use(remarkGfm);

/** A source slice, or the node's own value when a parser gave it no position. */
function termSlice(text: string, node: TermNode): string {
  if (node.position === undefined) return node.value ?? '';
  return text.slice(node.position.start.offset, node.position.end.offset);
}

/** One line of Markdown as one line: a wrapped field is joined with spaces, as a reader sees it. */
function oneLine(text: string): string {
  let out = '';
  let space = false;
  for (const character of text) {
    if (character === ' ' || character === '\t' || character === '\n' || character === '\r' || character === '\f') { space = out !== ''; continue; }
    if (space) { out += ' '; space = false; }
    out += character;
  }
  return out.trim();
}

/** The comma-separated names of a field, without the backticks and edge emphasis Markdown writes them with. */
const names = (value: string): string[] => {
  const out: string[] = [];
  for (const part of value.split(',')) {
    let held = '';
    for (const character of part) if (character !== '`') held += character;
    let from = 0;
    let to = held.length;
    while (from < to && (held[from] === ' ' || held[from] === '*' || held[from] === '\t')) from += 1;
    while (to > from && (held[to - 1] === ' ' || held[to - 1] === '*' || held[to - 1] === '\t')) to -= 1;
    const name = held.slice(from, to);
    if (name !== '') out.push(name);
  }
  return out;
};

/** Reads the fields of a term's text (the entity's `text`: the item's first line and its continuation). */
export function parseTermText(text: string): TermFields {
  const fields: TermFields = { definition: '', synonyms: [], code: [], usedIn: null, ambiguous: null };
  const definition: string[] = [];
  const tree = termProcessor.parse(text) as unknown as TermNode;
  const add = (field: TermField, value: string): void => {
    if (field === 'synonyms') fields.synonyms.push(...names(value));
    else if (field === 'code') fields.code.push(...names(value));
    else if (field === 'usedIn') fields.usedIn = fields.usedIn === null || fields.usedIn === '' ? value : `${fields.usedIn} ${value}`.trim();
    else fields.ambiguous = fields.ambiguous === null || fields.ambiguous === '-' ? (value === '' ? '-' : value) : `${fields.ambiguous} ${value}`.trim();
  };
  /** The field a paragraph opens with, when its first line names one of the glossary's own labels. */
  const fieldOf = (paragraph: TermNode): { field: TermField; raw: string; colon: number } | undefined => {
    const raw = termSlice(text, paragraph);
    let colon = -1;
    for (let index = 0; index < raw.length; index += 1) {
      if (raw[index] === ':') { colon = index; break; }
      if (raw[index] === '\n') return undefined;
    }
    if (colon < 0) return undefined;
    const field = LABELS[raw.slice(0, colon).trim().toLowerCase()];
    return field === undefined ? undefined : { field, raw, colon };
  };
  /** A list item whose paragraph opens with one of the glossary's own labels is a field; every other block is definition. */
  const item = (node: TermNode): void => {
    const paragraph = node.children?.find((child) => child.type === 'paragraph');
    if (paragraph === undefined) return;
    const found = fieldOf(paragraph);
    if (found === undefined) { definition.push(oneLine(termSlice(text, paragraph))); return; }
    add(found.field, oneLine(found.raw.slice(found.colon + 1)));
  };
  // A field list nests: the body of a term keeps the item's opening paragraph at column one and the fields under
  // it indented, so the second and later fields parse as a list inside the first field's item. Visit every item of
  // every nested list, not only the top-level ones (madarch-ztyq.9, review 199).
  const list = (node: TermNode): void => {
    for (const child of node.children ?? []) {
      if (child.type !== 'listItem') continue;
      item(child);
      for (const inner of child.children ?? []) if (inner.type === 'list') list(inner);
    }
  };
  for (const block of tree.children ?? []) {
    if (block.type === 'list') {
      list(block);
      continue;
    }
    if (block.type === 'paragraph') {
      // A product may write a field without a list mark; the label still makes it a field, not definition prose.
      const found = fieldOf(block);
      if (found === undefined) definition.push(termSlice(text, block));
      else add(found.field, oneLine(found.raw.slice(found.colon + 1)));
      continue;
    }
    if (block.type === 'blockquote') {
      for (const child of block.children ?? []) if (child.type === 'paragraph') definition.push(termSlice(text, child));
      continue;
    }
    // A code block, a heading or an HTML block is not a field: what a fenced sample says is an example, not this term.
  }
  fields.definition = definition.map((part) => part.trim()).filter((part) => part !== '').join('\n');
  return fields;
}

/** A term as the glossary lists it: where it is stated and what it says. */
export interface GlossaryTerm extends TermFields {
  /** Original wording, shown collapsed when a separate localized statement is used. */
  source?: { original: string; document: string; line: number; endLine: number };
  id: string;
  title: string;
  repo: string | null;
  path: string;
  line: number;
  endLine: number;
  /** The section's anchor in its document. */
  anchor: string;
  /** The product has one code repository, so the place of the term does not name it. */
  single: boolean;
  href: string;
}

/** The terms of the document kinds that name glossaries, in code point order of their titles. */
export function glossaryTerms(manifest: KindsManifest, entities: Iterable<DocEntity>, localized: ReadonlyMap<string, LocalizedDocumentSource> = new Map(), language = manifest.language ?? 'en', singleRepository = false): GlossaryTerm[] {
  const kinds = new Set([...manifest.kinds.values()].filter((kind) => kind.source === 'document' && kind.terms !== undefined).map((kind) => kind.name));
  const terms: GlossaryTerm[] = [];
  for (const entity of entities) {
    if (!kinds.has(entity.kind)) continue;
    const source = localized.get(entity.id);
    const sameLanguage = source !== undefined && source.sourceLanguage === language;
    const detectedLanguage = detectDocumentLanguage(entity.text);
    const needsLocalization = detectedLanguage !== language;
    const originalFields = parseTermText(entity.text);
    const localizedFields = source !== undefined && !sameLanguage ? parseTermText(source.statement) : originalFields;
    const fields = source !== undefined && !sameLanguage ? { ...originalFields, definition: localizedFields.definition || source.statement } : needsLocalization ? { ...originalFields, definition: '' } : originalFields;
    terms.push({ ...fields, ...(source === undefined || sameLanguage ? {} : { source: { original: source.original, document: source.sourceDocument, line: source.sourceLine, endLine: source.sourceEndLine } }), id: entity.id, title: entity.title, repo: entity.repo, path: entity.path, line: entity.line, endLine: entity.endLine, anchor: entity.anchor, single: entity.repo !== null && singleRepository, href: `/k/e/${encodeURIComponent(entity.id)}` });
  }
  return terms.sort((a, b) => byCodePoint(a.title.toLowerCase(), b.title.toLowerCase()) || byCodePoint(a.id, b.id));
}

/** The `madarch:` links in a text, so the glossary can resolve them for the page that shows the text. */
export function madarchLinks(text: string | null): string[] {
  if (text === null) return [];
  const out: string[] = [];
  let at = 0;
  while (at < text.length) {
    const open = text.indexOf('](', at);
    if (open < 0) break;
    let start = open + 2;
    while (start < text.length && text[start] === ' ') start += 1;
    if (!text.startsWith('madarch:', start)) { at = open + 2; continue; }
    let end = start;
    while (end < text.length && text[end] !== ')' && text[end] !== ' ' && text[end] !== '\n' && text[end] !== '\t') end += 1;
    out.push(text.slice(start, end));
    at = end;
  }
  return out;
}

export const termLinks = (term: TermFields): string[] => [...madarchLinks(term.definition), ...madarchLinks(term.usedIn), ...madarchLinks(term.ambiguous)];
