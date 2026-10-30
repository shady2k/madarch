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
import { parseTermText, type TermFields } from './term-fields.js';
import type { DocEntity } from './doc-entities.js';
import type { KindsManifest } from './kinds.js';
import { detectDocumentLanguage, type LocalizedDocumentSource } from '../writer/localized-source.js';

export { parseTermText, type TermField, type TermFields } from './term-fields.js';

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
