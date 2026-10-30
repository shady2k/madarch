/**
 * The fields of a glossary term, read from its Markdown tree (decision 0031).
 * A field is a list item or paragraph that opens with one of the glossary's
 * schema labels; every other block is definition prose.
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

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
  /** The field one line opens with, when its text names one of the glossary's own labels. */
  const fieldOfLine = (line: string): { field: TermField; colon: number } | undefined => {
    let colon = -1;
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] === ':') { colon = index; break; }
    }
    if (colon < 0) return undefined;
    const field = LABELS[line.slice(0, colon).trim().toLowerCase()];
    return field === undefined ? undefined : { field, colon };
  };
  /** The field a paragraph opens with, when its first line names one of the glossary's own labels. */
  const fieldOf = (paragraph: TermNode): { field: TermField; raw: string; colon: number } | undefined => {
    const raw = termSlice(text, paragraph);
    const first = raw.split('\n')[0]!;
    const found = fieldOfLine(first);
    return found === undefined ? undefined : { field: found.field, raw, colon: found.colon };
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
      const raw = termSlice(text, block);
      const lines = raw.split('\n');
      let firstField = -1;
      for (let index = 0; index < lines.length; index += 1) if (fieldOfLine(lines[index]!) !== undefined) { firstField = index; break; }
      if (firstField < 0) { definition.push(raw); continue; }
      if (firstField > 0) definition.push(lines.slice(0, firstField).join('\n'));
      // A soft line break does not make a new block in Markdown, but a line
      // that opens with a field label is still a field, not definition prose.
      let last: TermField | undefined;
      for (const line of lines.slice(firstField)) {
        const found = fieldOfLine(line);
        if (found !== undefined) { last = found.field; add(found.field, oneLine(line.slice(found.colon + 1))); }
        else if (last !== undefined) add(last, oneLine(line));
      }
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

