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
import { byCodePoint } from '../model/order.js';
import type { DocEntity } from './doc-entities.js';
import type { KindsManifest } from './kinds.js';

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

const LABEL_LINE = /^\s*(?:[-*+]\s+)?([^:\n]{2,24}):\s*(.*)$/;

const names = (value: string): string[] => value.split(',').map((part) => part.replace(/`/g, '').replace(/^[*\s]+|[*\s]+$/g, '')).filter((part) => part !== '');

/** Reads the fields of a term's text (the entity's `text`: the item's first line and its continuation). */
export function parseTermText(text: string): TermFields {
  const definition: string[] = [];
  const fields: TermFields = { definition: '', synonyms: [], code: [], usedIn: null, ambiguous: null };
  let active: TermField | undefined;
  const add = (field: TermField, value: string): void => {
    if (field === 'synonyms') fields.synonyms.push(...names(value));
    else if (field === 'code') fields.code.push(...names(value));
    else if (field === 'usedIn') fields.usedIn = fields.usedIn === null || fields.usedIn === '' ? value : `${fields.usedIn} ${value}`.trim();
    else fields.ambiguous = fields.ambiguous === null || fields.ambiguous === '-' ? (value === '' ? '-' : value) : `${fields.ambiguous} ${value}`.trim();
  };
  for (const line of text.split('\n')) {
    const match = LABEL_LINE.exec(line);
    const field = match === null ? undefined : LABELS[match[1]!.trim().toLowerCase()];
    if (match !== null && field !== undefined) {
      active = field;
      add(field, match[2]!.trim());
      continue;
    }
    // After a label, a line that is no label is the rest of that field (a wrapped line); before any, it is the definition.
    if (active === undefined) definition.push(line.replace(/^\s{0,4}/, ''));
    else if (line.trim() !== '') add(active, line.trim());
  }
  fields.definition = definition.join('\n').trim();
  return fields;
}

/** A term as the glossary lists it: where it is stated and what it says. */
export interface GlossaryTerm extends TermFields {
  id: string;
  title: string;
  repo: string | null;
  path: string;
  line: number;
  endLine: number;
  /** The section's anchor in its document. */
  anchor: string;
  href: string;
}

/** The terms of the document kinds that name glossaries, in code point order of their titles. */
export function glossaryTerms(manifest: KindsManifest, entities: Iterable<DocEntity>): GlossaryTerm[] {
  const kinds = new Set([...manifest.kinds.values()].filter((kind) => kind.source === 'document' && kind.terms !== undefined).map((kind) => kind.name));
  const terms: GlossaryTerm[] = [];
  for (const entity of entities) {
    if (!kinds.has(entity.kind)) continue;
    terms.push({ ...parseTermText(entity.text), id: entity.id, title: entity.title, repo: entity.repo, path: entity.path, line: entity.line, endLine: entity.endLine, anchor: entity.anchor, href: `/k/e/${encodeURIComponent(entity.id)}` });
  }
  return terms.sort((a, b) => byCodePoint(a.title.toLowerCase(), b.title.toLowerCase()) || byCodePoint(a.id, b.id));
}

/** The `madarch:` links in a text, so the glossary can resolve them for the page that shows the text. */
export function madarchLinks(text: string | null): string[] {
  return text === null ? [] : [...text.matchAll(/\]\((madarch:[^)\s]+)\)/g)].map((match) => match[1]!);
}

export const termLinks = (term: TermFields): string[] => [...madarchLinks(term.definition), ...madarchLinks(term.usedIn), ...madarchLinks(term.ambiguous)];
