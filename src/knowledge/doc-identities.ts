/**
 * The stable identities of a document's sections (madarch-ztyq.3, decision 0032
 * section 4). A number such as UC-1 or BR-3 is an alias the document writes: it
 * is not what a section is, because a person renumbers a document, deletes a
 * use case or writes an unnumbered one, and a link must not follow the number.
 * So each section gets an identity of its own, kept in a mapping beside the
 * product — in its store, never in the repository — and the wiki's page id stays
 * `doc:<path>#<anchor>` as before.
 *
 * The mapping is what makes the identities stable: a section that keeps its
 * anchor keeps its identity, a section whose text is unchanged keeps it through
 * a renumbering, and a section neither the anchor nor the text knows is new and
 * gets a new identity. Every read answers the mapping as it now stands, so the
 * caller keeps it; nothing is invented and nothing is dropped silently.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { sha256Hex } from '../graph/digest.js';
import { byCodePoint } from '../model/order.js';
import type { Finding } from './kinds.js';

/** The file the mapping is kept in, in the product's store (`<store>/<product id>/`). */
export const IDENTITIES_FILE = 'doc-identities.json';

/** One section as the mapping keeps it: its identity, the anchor and the kind it had, and the digest of its text. */
export interface DocIdentity {
  /** `doc-section:<hex>`; the identity a link keeps when a heading or a number changes. */
  readonly stableId: string;
  readonly anchor: string;
  readonly kind: string;
  /** The digest of the section's own text, the naming line aside. */
  readonly digest: string;
  readonly title: string;
}

/** The identities of one document, and the counter a new identity's number comes from. */
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
  return sha256Hex(new TextEncoder().encode(text.replace(/\s+/g, ' ').trim())).slice(0, 32);
}

/** The identity of the `sequence`th new section of a document: the document, the anchor it was written under, and the number. */
export function stableIdFor(key: string, anchor: string, sequence: number): string {
  return `doc-section:${sha256Hex(new TextEncoder().encode(`${key}\u0000${anchor}\u0000${String(sequence)}`)).slice(0, 24)}`;
}

/**
 * The identities of a document's sections as this read found them: a section
 * with the anchor it had keeps its identity; a section whose text is unchanged
 * keeps it through a renumbering; anything else is new and gets a new identity,
 * and the counter moves forward so no identity is ever given twice.
 */
export function assignStableIds(key: string, sections: readonly SectionIdentity[], previous: DocumentIdentities | undefined): { ids: string[]; next: DocumentIdentities } {
  const held = previous?.sections ?? [];
  const used = new Set<number>();
  const digests = sections.map((section) => textDigest(section.text));
  const ids: (string | undefined)[] = sections.map(() => undefined);
  sections.forEach((section, index) => {
    const at = held.findIndex((entry, position) => !used.has(position) && entry.anchor === section.anchor);
    if (at < 0) return;
    used.add(at);
    ids[index] = held[at]!.stableId;
  });
  sections.forEach((section, index) => {
    if (ids[index] !== undefined) return;
    const at = held.findIndex((entry, position) => !used.has(position) && entry.digest === digests[index]);
    if (at < 0) return;
    used.add(at);
    ids[index] = held[at]!.stableId;
  });
  let sequence = Math.max(previous?.nextSequence ?? 0, held.length);
  sections.forEach((section, index) => {
    if (ids[index] !== undefined) return;
    ids[index] = stableIdFor(key, section.anchor, sequence);
    sequence += 1;
  });
  return {
    ids: ids.map((id) => id!),
    next: {
      nextSequence: sequence,
      sections: sections.map((section, index) => ({ stableId: ids[index]!, anchor: section.anchor, kind: section.kind, digest: digests[index]!, title: section.title })),
    },
  };
}

/** A field of the mapping that does not read, as a finding at the line it stands on. */
function lineOf(text: string, needle: string): number {
  const at = text.split('\n').findIndex((line) => line.includes(needle));
  return at < 0 ? 1 : at + 1;
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
      findings.push({ file, line, message: `the identities of ${key} are { "nextSequence": <a whole number>, "sections": [ { stableId, anchor, kind, digest, title } ] }, so its sections are read as new` });
      continue;
    }
    const sections: DocIdentity[] = [];
    let bad = false;
    for (const item of list as unknown[]) {
      const section = item as Record<string, unknown> | null;
      const field = (name: string): string | undefined => (section !== null && typeof section === 'object' && typeof section[name] === 'string' ? section[name] as string : undefined);
      const stableId = field('stableId');
      const anchor = field('anchor');
      const kind = field('kind');
      const digest = field('digest');
      const title = field('title');
      if (stableId === undefined || anchor === undefined || kind === undefined || digest === undefined || title === undefined) { bad = true; continue; }
      sections.push({ stableId, anchor, kind, digest, title });
    }
    if (bad) findings.push({ file, line, message: `a section of ${key} does not name its stableId, anchor, kind, digest and title, so that section is read as new` });
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
    const serialize = (sections: readonly DocIdentity[]): string => JSON.stringify([...sections].sort((x, y) => byCodePoint(x.stableId, y.stableId)));
    if (serialize(one.sections) !== serialize(other.sections)) return false;
  }
  return true;
}
