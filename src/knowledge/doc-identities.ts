/**
 * The durable identities of a document's sections (madarch-ztyq.3, decision 0032 section 4; the review of findings 2
 * and 3). A number such as UC-1, and an anchor such as `uc-1` or `qualities.1`, are things the document writes and a
 * person can change; a link must not follow them. Each section gets an identity of its own, minted once, kept in a
 * mapping beside the product — in its store, never in the repository — and the identity is what a page id, a wiki link,
 * a localized source's filename and a stored interpretation name. The anchor stays a display and resolution detail: a
 * ground may still name one, and it resolves to the section that stands there now.
 *
 * Reconciliation is by content first and by anchor second, with ambiguity left to the next pass: a section whose text is
 * unchanged keeps its identity even when it is renumbered or when two sections swap numbers (a digest held by exactly
 * one previous entry and claimed by exactly one section pairs them, and an ambiguous digest pairs nothing), and only then
 * does the anchor a section stands at decide. A section neither pass matches is new and gets a new identity — a name no
 * other identity of the document holds, so two sections can never share a page.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { sha256Hex } from '../graph/digest.js';
import { byCodePoint } from '../model/order.js';
import type { Finding } from './kinds.js';

/** The file the mapping is kept in, in the product's store (`<store>/<product id>/`). */
export const IDENTITIES_FILE = 'doc-identities.json';

/** One section as the mapping keeps it: its identity, the anchor it stands at now, its kind and the digest of its text. */
export interface DocIdentity {
  /** The durable identity: the fragment of the page id, minted once, never changed (madarch-ztyq.3 finding 2). */
  readonly id: string;
  /** The anchor the document gives the section now: a display and resolution detail, never the identity. */
  readonly anchor: string;
  readonly kind: string;
  /** The digest of the section's own text, the naming line aside. */
  readonly digest: string;
  readonly title: string;
}

/** The identities of one document, and the counter a name no anchor can give comes from. */
export interface DocumentIdentities {
  readonly nextSequence: number;
  readonly sections: readonly DocIdentity[];
}

/** The mapping of documents to their sections, keyed by `documentKey()`. */
export type DocIdentities = ReadonlyMap<string, DocumentIdentities>;

/** The key one document stands under in the mapping: the repository and the path a page id names. */
export function documentKey(repo: string | null, path: string): string {
  return `${repo === null ? '' : `@${repo}/`}${path}`;
}

/** A section as the reader found it, before it has an identity. */
export interface SectionIdentity {
  readonly anchor: string;
  readonly kind: string;
  readonly title: string;
  /** The section's own text, without the line that names it. */
  readonly text: string;
}

/** The digest of a section's text: its words, whatever the line breaks of the document are. */
export function textDigest(text: string): string {
  let collapsed = '';
  for (const char of text) {
    const space = char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v';
    if (space && collapsed.endsWith(' ')) continue;
    collapsed += space ? ' ' : char;
  }
  return sha256Hex(new TextEncoder().encode(collapsed.trim())).slice(0, 32);
}

/** The indexes of one value in a list, so a digest or an anchor claimed by several sections is told apart. */
function group<T>(entries: readonly T[], key: (entry: T) => string): Map<string, number[]> {
  const grouped = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    const named = key(entry);
    const held = grouped.get(named);
    if (held === undefined) grouped.set(named, [index]);
    else held.push(index);
  });
  return grouped;
}

/**
 * The identities of a document's sections as this read found them: unchanged content first, the anchor the section
 * stands at second, a new identity last. A digest or an anchor that several sections claim pairs none of them, so a swap
 * of two numbers exchanges nothing, and an insertion before a section does not shift what the section is.
 */
export function assignIdentities(key: string, sections: readonly SectionIdentity[], previous: DocumentIdentities | undefined): { ids: string[]; next: DocumentIdentities } {
  const held = previous?.sections ?? [];
  const used = new Set<number>();
  const ids: (string | undefined)[] = sections.map(() => undefined);
  const digests = sections.map((section) => textDigest(section.text));
  // 1. Unchanged content: a digest exactly one previous section holds and exactly one section writes.
  const heldByDigest = group(held, (entry) => entry.digest);
  for (const [digest, indexes] of group(digests, (entry) => entry)) {
    const old = heldByDigest.get(digest) ?? [];
    if (old.length !== 1 || indexes.length !== 1 || used.has(old[0]!)) continue;
    used.add(old[0]!);
    ids[indexes[0]!] = held[old[0]!]!.id;
  }
  // 2. The anchor: a section that kept its anchor keeps the identity that stood there, when that pairing is unambiguous.
  const heldByAnchor = group(held, (entry) => entry.anchor);
  const newByAnchor = new Map<string, number[]>();
  sections.forEach((section, index) => {
    if (ids[index] !== undefined) return;
    const held = newByAnchor.get(section.anchor);
    if (held === undefined) newByAnchor.set(section.anchor, [index]);
    else held.push(index);
  });
  for (const [anchor, indexes] of newByAnchor) {
    const old = (heldByAnchor.get(anchor) ?? []).filter((index) => !used.has(index));
    if (old.length !== 1 || indexes.length !== 1) continue;
    used.add(old[0]!);
    ids[indexes[0]!] = held[old[0]!]!.id;
  }
  // 3. A new section: a name of its own — the anchor it stands at, or that anchor and the first number no identity holds.
  const taken = new Set<string>(held.map((entry) => entry.id));
  for (const id of ids) if (id !== undefined) taken.add(id);
  let sequence = Math.max(previous?.nextSequence ?? 0, held.length);
  sections.forEach((section, index) => {
    if (ids[index] !== undefined) return;
    let name = section.anchor;
    let attempt = 2;
    while (name === '' || taken.has(name)) {
      name = section.anchor === '' ? `section-${String(sequence + attempt)}` : `${section.anchor}-${String(attempt)}`;
      attempt += 1;
    }
    taken.add(name);
    sequence += 1;
    ids[index] = name;
  });
  return {
    ids: ids.map((id) => id!),
    next: {
      nextSequence: sequence,
      sections: sections.map((section, index) => ({ id: ids[index]!, anchor: section.anchor, kind: section.kind, digest: digests[index]!, title: section.title })),
    },
  };
}

/** A field of the mapping that does not read, as a finding at the line it stands on. */
function lineOf(text: string, needle: string): number {
  let at = 0;
  let line = 1;
  for (;;) {
    const found = text.indexOf(needle, at);
    if (found < 0) return line === 1 ? 1 : line;
    for (let index = 0; index < found; index += 1) if (text[index] === '\n') line += 1;
    return line;
  }
}

/** The mapping kept in `file`: a store that is missing is a product whose documents were never read; one that cannot be read is a finding. */
export function readDocIdentities(file: string): { identities: Map<string, DocumentIdentities>; findings: Finding[] } {
  const identities = new Map<string, DocumentIdentities>();
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { identities, findings: [] };
    return { identities, findings: [{ file, line: 1, message: `the identities cannot be read: ${(error as Error).message}` }] };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { identities, findings: [{ file, line: 1, message: `the identities are not valid JSON, so every section is read as new: ${(error as Error).message}` }] };
  }
  const body = value as Record<string, unknown> | null;
  const documents = body !== null && typeof body === 'object' && !Array.isArray(body) ? body['documents'] : undefined;
  if (documents === null || documents === undefined || typeof documents !== 'object' || Array.isArray(documents)) {
    return { identities, findings: [{ file, line: 1, message: 'the identities are { "documents": { "<document>": { "nextSequence": <number>, "sections": [...] } } }' }] };
  }
  const findings: Finding[] = [];
  for (const [key, entry] of Object.entries(documents as Record<string, unknown>).sort(([a], [b]) => byCodePoint(a, b))) {
    const line = lineOf(text, JSON.stringify(key));
    const document = entry as Record<string, unknown> | null;
    const sequence = document === null || typeof document !== 'object' ? undefined : document['nextSequence'];
    const list = document === null || typeof document !== 'object' ? undefined : document['sections'];
    if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 0 || !Array.isArray(list)) {
      findings.push({ file, line, message: `the identities of ${key} are { "nextSequence": <a whole number>, "sections": [ { id, anchor, kind, digest, title } ] }, so its sections are read as new` });
      continue;
    }
    const sections: DocIdentity[] = [];
    let bad = false;
    for (const item of list as unknown[]) {
      const section = item as Record<string, unknown> | null;
      const field = (name: string): string | undefined => (section !== null && typeof section === 'object' && typeof section[name] === 'string' ? section[name] as string : undefined);
      const id = field('id');
      const anchor = field('anchor');
      const kind = field('kind');
      const digest = field('digest');
      const title = field('title');
      if (id === undefined || anchor === undefined || kind === undefined || digest === undefined || title === undefined) { bad = true; continue; }
      sections.push({ id, anchor, kind, digest, title });
    }
    if (bad) findings.push({ file, line, message: `a section of ${key} does not name its id, anchor, kind, digest and title, so that section is read as new` });
    identities.set(key, { nextSequence: sequence, sections });
  }
  return { identities, findings };
}

/** Writes the mapping beside the product, in a file of its own so a reader never sees half of one. */
export function writeDocIdentities(file: string, identities: DocIdentities): void {
  const documents: Record<string, DocumentIdentities> = {};
  for (const [key, entry] of [...identities].sort(([a], [b]) => byCodePoint(a, b))) documents[key] = { nextSequence: entry.nextSequence, sections: entry.sections };
  const text = `${JSON.stringify({ documents }, null, 2)}\n`;
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new Error(`${file}: the identities could not be written: ${(error as Error).message}`);
  }
}

/** Whether two mappings keep the same identities and the same counter, so nothing has to be written. */
export function sameDocIdentities(a: DocIdentities, b: DocIdentities): boolean {
  if (a.size !== b.size) return false;
  const keysA = [...a.keys()].sort(byCodePoint);
  const keysB = [...b.keys()].sort(byCodePoint);
  if (keysA.join('\u0000') !== keysB.join('\u0000')) return false;
  for (const key of keysA) {
    const one = a.get(key)!;
    const other = b.get(key)!;
    if (one.nextSequence !== other.nextSequence || one.sections.length !== other.sections.length) return false;
    const serialize = (sections: readonly DocIdentity[]): string => JSON.stringify([...sections].sort((x, y) => byCodePoint(x.id, y.id)));
    if (serialize(one.sections) !== serialize(other.sections)) return false;
  }
  return true;
}
