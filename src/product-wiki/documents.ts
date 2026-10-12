/**
 * The product's documents, as the wiki reads them (decision 0021, outcome 3
 * of the standalone charter): the fields a document carries are read the
 * way the reading shell has always read them `Name: value` between the
 * identity line and the first section, and the kind a page is comes from
 * the product's kinds registry — the file the skill set writes at setup —
 * through the kit this module is handed: the document's explicit generic
 * field first, then its identity line's id prefix, then the place its path
 * names. A page the registry names not at all keeps the plain page
 * behaviour it had before the registry read it: no kind, no invented
 * category. Where the product holds no registry, nothing is a kind anywhere
 * and the module still reads the fields as plain text lines.
 *
 * What the registry is and how it refuses is the contract's own reading
 * (`src/product/contract.ts`); this module consumes it, and names nothing
 * of any set vocabulary: the prefixes and folders come from the registry's
 * own fields, and a status is computed from the document's own text — the
 * sections `Answer` and `Verdict` stand in the document or they do not —
 * never from a kind's name.
 */
import { dirname as dirOf, isAbsolute, join as joinPath } from 'node:path';
import { registryKit, kindOfId, kindOfPath, type RegistryKit } from '../product/registry.js';
import type { RegistryKind } from '../product/contract.js';

/** A product document's kind, as the registry that names it spells it. */
export type DocumentKind = string;

/** One field as the form's `Name: value` line holds it, at its line. */
export interface DocumentField {
  name: string;
  value: string;
  /** The 1-based line the field stands on, as the set's check names it. */
  line: number;
}

/**
 * The page's Markdown with the field lines the header block already shows
 * blanked: every field's own line is emptied, nothing else moves, so the
 * file's line numbers — the check's findings, every pointer the page
 * names — stay true while the page shows the fields once. The identity
 * line, the sections and every line the block did not read stand as
 * before.
 */
export function blankFieldLines(markdown: string, fields: readonly DocumentField[]): string {
  if (fields.length === 0) return markdown;
  const lines = markdown.split('\n');
  for (const field of fields) {
    const index = field.line - 1;
    if (index >= 0 && index < lines.length) lines[index] = '';
  }
  return lines.join('\n');
}

/** One link-field target: an id, or the file-stem address a whole document's kind is read by, and the field that named it. */
export interface GrownFromId {
  id: string;
  via: string;
}

/** One section of the form's own, at the line its heading stands on. */
export interface DocumentSection {
  name: string;
  line: number;
  /** The section's own content lines, joined, fences and HTML comments out. */
  text: string;
}

/** What one page's Markdown holds as a document of the set, read only. */
export interface ParsedDocument {
  path: string;
  /** The kind the product's registry names the page, when it names it; `undefined` for a plain page. */
  kind: DocumentKind | undefined;
  /** The identity line's id when the shapes read one; a document of a file kind may carry the file stem's word as its address. */
  id?: string;
  title: string;
  fields: DocumentField[];
  sections: DocumentSection[];
  grewFromIds: GrownFromId[];
  /** Every id page's name the forms recognize, read outside code spans and fences. */
  mentions: string[];
  /** The body's inline links and wiki addresses, resolved to page paths within the product. */
  linkTargets: string[];
}

/**
 * The status the document's own text computes, never written: a document
 * whose sections hold a question's material (the sections its form gathers,
 * `Question` and `What settles it`) is answered when its `Answer` section
 * carries text and stands open while it does not, and one whose sections
 * hold a `Verdict` stands in the first word the verdict says. A document
 * the text carries none of this in computes no status; the words are the
 * document's own, never a kind's data in code.
 */
export type ComputedStatus = 'answered' | 'open' | 'confirmed' | 'refuted' | 'unclear';

export function statusOf(doc: ParsedDocument): ComputedStatus | undefined {
  if (doc.id === undefined) return undefined;
  const question = doc.sections.find((s) => s.name === 'Question' || s.name === 'What settles it');
  if (question !== undefined) {
    const answer = doc.sections.find((s) => s.name === 'Answer');
    return answer !== undefined && answer.text.trim() !== '' ? 'answered' : 'open';
  }
  const verdict = doc.sections.find((s) => s.name === 'Verdict');
  if (verdict === undefined) return undefined;
  const word = verdict.text.trim().match(/^(confirmed|refuted|unclear)\b/i);
  if (word === null) return undefined;
  const said = word[1];
  return said === undefined ? undefined : (said.toLowerCase() as ComputedStatus);
}


// ---- one Markdown body's lines, examples marked ---------------------------

interface BodyLine {
  raw: string;
  line: number;
  structural: boolean;
}

/** The lines of one Markdown body, the check's own marking: fenced code
 * and HTML comments are examples, never content. */
function linesOf(body: string): BodyLine[] {
  const out: BodyLine[] = [];
  const markOf = (raw: string) => raw.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
  let fence: [string, number] | null = null;
  let comment = false;
  body.replace(/\r\n/g, '\n').split('\n').forEach((raw, index) => {
    const mark = markOf(raw);
    let structural = true;
    if (fence !== null) {
      // A line inside a fence is an example, whatever it holds; the closing
      // line of the same tick run ends the fence.
      structural = false;
      if (mark !== null) {
        const ticks = mark[1] ?? '';
        if (ticks[0] === fence[0] && ticks.length >= fence[1] && !(mark[2] ?? '').trim()) fence = null;
      }
    } else if (mark !== null) {
      structural = false;
      const ticks = mark[1] ?? '';
      fence = [ticks[0] ?? '`', ticks.length];
    } else if (comment || raw.trimStart().startsWith('<!--')) {
      structural = false;
      comment = !raw.includes('-->');
    }
    out.push({ raw, line: index + 1, structural });
  });
  return out;
}

/** One Markdown line's ids, its code spans removed, as the set's check mentions them. */
function mentionsOf(raw: string, kit: RegistryKit | undefined): string[] {
  const bare = raw.replace(/`[^`]*`/g, '');
  if (kit === undefined) return [];
  const ids = [...bare.matchAll(kit.mentionShape)].map((match) => match[0]);
  for (const address of kit.fileAddresses.keys()) {
    if (new RegExp(`(?<![\\w-])${address}(?![\\w-])`).test(bare)) ids.push(address);
  }
  return ids;
}

/**
 * Resolves one body link's target against the page that holds it: a wiki
 * address (`/p/…`) decodes to the page it names when held; a relative link
 * is read from the page's own folder. A target that climbs out of the
 * product, an absolute one and an outside scheme resolve to nothing.
 */
export function resolveBodyLink(fromPath: string, target: string, held: ReadonlySet<string>): string | undefined {
  let wanted = target.trim();
  if (wanted === '' || wanted.startsWith('#')) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(wanted)) return undefined;
  if (wanted.startsWith('/p/')) {
    let path = wanted.slice('/p/'.length);
    // The address may carry a fragment or a query ("#section", "?x"): the
    // page is the path before them.
    path = (path.split('#')[0] ?? '').split('?')[0] ?? '';
    try { path = decodeURIComponent(path); } catch { return undefined; }
    return held.has(path) ? path : undefined;
  }
  wanted = ((wanted.split('#')[0] ?? '').split('?')[0]) ?? '';
  if (wanted === '' || isAbsolute(wanted)) return undefined;
  const parts: string[] = [];
  for (const segment of joinPath(dirOf(fromPath), wanted).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') { if (parts.length === 0) return undefined; parts.pop(); continue; }
    parts.push(segment);
  }
  const resolved = parts.join('/');
  return held.has(resolved) ? resolved : undefined;
}

/**
 * The body links of one structural line: the inline `[label](target)`
 * links, with their code spans out, and the wiki addresses the body
 * spells. A label that wraps over lines reaches no reader here — the set's
 * own check reads links per line the same way — so the read is
 * conservative.
 */
const INLINE_LINK = /\[[^\]\n]*\]\(([^)\n]+)\)/g;
const WIKI_ADDRESS = /\/p\/[^\s)"'<>`]+/g;

function linkTargetsOf(raw: string, fromPath: string, held: ReadonlySet<string>): string[] {
  const bare = raw.replace(/`[^`]*`/g, '');
  const written: string[] = [];
  for (const match of bare.matchAll(INLINE_LINK)) written.push(match[1] as string);
  for (const match of bare.matchAll(WIKI_ADDRESS)) written.push(match[0].replace(/[.,;:]$/, ''));
  const resolved: string[] = [];
  for (const target of written) {
    const path = resolveBodyLink(fromPath, target, held);
    if (path !== undefined && !resolved.includes(path)) resolved.push(path);
  }
  return resolved;
}

/** A link field's targets: the addresses of a product's documents, as its ids are spelled. */
function grewFromOf(name: string, value: string, kit: RegistryKit | undefined): GrownFromId[] {
  const named = value.split(',').map((part) => part.trim()).filter((part) => isAddressOf(part, kit));
  return named.map((id) => ({ id, via: name }));
}

/**
 * Whether a field's value names a link target the wiki resolves: a
 * well-formed id the registry's prefixes can read with no registry — the
 * shapes the set's own link lines carry is a plain word-dash-number id —
 * else a whole product document's file-stem address (`VISION` for the
 * document a single-file kind's folder names), which the registry's data
 * names. The values' resolution to pages is the wiki's later; the filter
 * keeps every addressable word the form wrote.
 */
function isAddressOf(value: string, kit: RegistryKit | undefined): boolean {
  if (kit !== undefined) {
    if (kit.idShape.test(value)) return true;
    return kit.fileAddresses.has(value) && value.length > 0;
  }
  return /^[A-Za-z][A-Za-z0-9_-]*-\d+$/.test(value);
}

/**
 * The link fields the reading shell has read since its first landing, the
 * forms' own vocabulary of "grew from" rows unchanged by the registry: the
 * only fields whose values the wiki reads as the document's links. A field
 * outside this table is never a link field here, however id-shaped its
 * value looks — the check owns what a form refuses; the wiki reads only
 * the links it defined before the registry came.
 */
const LINK_FIELDS: { [name: string]: true } = {
  'Grew from': true,
  'Serves': true,
  'Concerns': true,
  'Tests': true,
  'Of': true,
  'Supersedes': true,
};

/**
 * Reads one page's Markdown as a document the registry names, or as a plain
 * page (kind `undefined`): the identity line `# <ID> — <title>` gives the
 * document its id when the id carries a prefix one of the registry's kinds
 * names — with no registry, when it carries a plain word-dash-number shape
 * — and an `Id:` field line does the same where the identity line carries
 * none. The fields stand one per line as `Name: value` between the identity
 * line and the first `## ` section; every section records where it begins
 * and what it holds. The kind: the document's own generic `Kind:` field
 * first, then the id's prefix, then the place its path finds — each naming
 * a kind of the registry, and nothing invented where none names. The link
 * fields (LINK_FIELDS) are read as the document's links; the mentions and
 * the body's links are read outside code spans and fences, per structural
 * line.
 */
export function parseDocument(path: string, markdown: string, held: ReadonlySet<string>, kit: RegistryKit | undefined = undefined): ParsedDocument {
  const all = linesOf(markdown);
  const first = all.find((line) => line.raw.trim());
  const head = first !== undefined && first.structural ? first.raw.match(/^# (\S+) — (.+)$/) : null;
  const identityWord = head !== null ? head[1] : undefined;
  const titleText = head !== null ? head[2] : undefined;
  const title = titleText !== undefined ? titleText.trim() : first !== undefined ? first.raw.replace(/^#\s*/, '').trim() : path.replace(/\.md$/, '');

  const fields: DocumentField[] = [];
  const sections: DocumentSection[] = [];
  const waiting = new Map<DocumentSection, string[]>();
  let opened: DocumentSection | null = null;
  let sectionOpened = false;
  for (const line of all.slice(first === undefined ? 0 : all.indexOf(first) + 1)) {
    if (!line.structural) {
      // A fenced line or a comment inside a section is an example, not the
      // section's content; the section text keeps the structural lines only.
      continue;
    }
    const h2 = line.raw.match(/^## (.+)$/);
    if (h2 !== null) {
      const name = (h2[1] ?? '').trim();
      if (sections.some((s) => s.name === name)) { opened = null; continue; } // repeated: the check refuses it; the read keeps the first
      opened = { name, line: line.line, text: '' };
      waiting.set(opened, []);
      sections.push(opened);
      sectionOpened = true;
      continue;
    }
    if (opened !== null) { waiting.get(opened)!.push(line.raw); continue; }
    if (sectionOpened) continue;
    const field = line.raw.match(/^([A-Z][A-Za-z ]*?):\s*(.*)$/);
    const fieldName = field !== null ? field[1] : undefined;
    const fieldValue = field !== null ? field[2] : undefined;
    if (fieldName === undefined || fieldValue === undefined || fieldValue.trim() === '') continue;
    fields.push({ name: fieldName, value: fieldValue.trim(), line: line.line });
  }
  for (const [section, raws] of waiting) {
    section.text = raws
      .filter((raw) => raw.trim() !== '' && !raw.trimStart().startsWith('<!--'))
      .join('\n')
      .trim();
  }

  // The id: the identity line's word when the shapes read one, else an `Id:`
  // field whose value does. The shapes are the registry's prefixes with a
  // registry, a plain word-dash-number id without one.
  const idShape = kit !== undefined ? kit.idShape : /^[A-Za-z][A-Za-z0-9_-]*-\d+$/;
  let id = identityWord !== undefined && idShape.test(identityWord) ? identityWord : undefined;
  if (id === undefined) {
    const named = fields.find((field) => field.name.toLowerCase() === 'id');
    if (named !== undefined && idShape.test(named!.value)) id = named!.value;
  }

  // The kind: the explicit generic `Kind:` field when it names a kind of
  // the registry, then the id's prefix, then the place the path sits in —
  // all of them registry reads, never anything inferred without one.
  let kind: DocumentKind | undefined;
  if (kit !== undefined) {
    const named = fields.find((field) => field.name.toLowerCase() === 'kind');
    if (named !== undefined) {
      kind = kit.kinds.find((candidate) => candidate.name.toLowerCase() === named!.value.toLowerCase())?.name;
    }
    if (kind === undefined && id !== undefined) kind = kit.byPrefix.get(id.slice(0, id.indexOf('-')))?.name;
    if (kind === undefined) kind = kindOfPath(kit, path)?.name;
  }

  const mentions: string[] = [];
  const linkTargets: string[] = [];
  const content = first === undefined ? all : all.slice(all.indexOf(first));
  for (const line of content) {
    if (!line.structural) continue;
    for (const named of mentionsOf(line.raw, kit)) if (!mentions.includes(named)) mentions.push(named);
    for (const target of linkTargetsOf(line.raw, path, held)) if (!linkTargets.includes(target)) linkTargets.push(target);
  }

  const grewFromIds: GrownFromId[] = [];
  for (const field of fields) {
    if (LINK_FIELDS[field.name] !== true) continue;
    for (const grown of grewFromOf(field.name, field.value, kit)) {
      if (!grewFromIds.some((heldEntry) => heldEntry.id === grown.id && heldEntry.via === grown.via)) grewFromIds.push(grown);
    }
  }

  return { path, kind, id, title, fields, sections, grewFromIds, mentions, linkTargets };
}

// ---- across the product: the by-id index, the grown-from and backlinks ----

/** Every page's document read one product walk held. */
export interface ProductDocuments {
  /** By the page's path within the product. */
  byPath: Map<string, ParsedDocument>;
  /** By the document's id as the id shapes read it; a page without an id is not here. */
  byId: Map<string, ParsedDocument>;
}

/**
 * Reads the documents out of every page's Markdown, so a registry's data
 * puts each page of a kind under its kind, and rebuilds the by-id index.
 * None cached — the caller re-reads the pages fresh and calls this again
 * with what they hold. One addition the index makes itself: a document of
 * a file kind (a kind whose folder is one file) that the product's
 * documents address by the file stem's capitals — the way the form link
 * lines spell the whole document's address — carries that word as its id,
 * so those links resolve and the backlinks both ways reach it; the address
 * is used where the product's own documents wrote it, nowhere else.
 */
export function documentsOf(paths: readonly string[], read: (path: string) => string, held: ReadonlySet<string>, kit: RegistryKit | undefined = undefined): ProductDocuments {
  const byPath = new Map<string, ParsedDocument>();
  const byId = new Map<string, ParsedDocument>();
  for (const path of paths) {
    const doc = parseDocument(path, read(path), held, kit);
    byPath.set(path, doc);
    if (doc.id !== undefined && !byId.has(doc.id)) byId.set(doc.id, doc);
  }
  if (kit !== undefined) {
    const named = new Set<string>();
    for (const doc of byPath.values()) {
      for (const grown of doc.grewFromIds) named.add(grown.id);
      for (const mentioned of doc.mentions) named.add(mentioned);
    }
    for (const [address, folder] of kit.fileAddresses) {
      if (!named.has(address) || byId.has(address)) continue;
      const doc = byPath.get(folder);
      if (doc === undefined || doc.id !== undefined) continue;
      doc.id = address;
      byId.set(address, doc);
    }
  }
  return { byPath, byId };
}

/** Whom a document's link fields name, resolved to the pages they are. */
export function grownFromOf(doc: ParsedDocument, docs: ProductDocuments): GrownFromEntry[] {
  const entries: GrownFromEntry[] = [];
  for (const grown of doc.grewFromIds) {
    const target = docs.byId.get(grown.id);
    entries.push(target === undefined
      ? { id: grown.id, via: grown.via }
      : { id: grown.id, via: grown.via, path: target.path, title: target.title, kind: target.kind });
  }
  return entries;
}

/** One target a page grew from, as the page's header shows it. */
export interface GrownFromEntry {
  id: string;
  /** The field that named it (`Grew from`, `Serves`, `Of`…). */
  via: string;
  /** The page within the product, when the id resolves there. */
  path?: string;
  title?: string;
  kind?: DocumentKind;
}

/** Who links to a document: link fields first, then the ids its body names, then the addresses it spells. */
export function backlinksOf(doc: ParsedDocument, docs: ProductDocuments): BacklinkEntry[] {
  const entries: BacklinkEntry[] = [];
  for (const other of docs.byPath.values()) {
    if (other === doc || other.path === doc.path) continue;
    const viaField = other.grewFromIds.some((grown) => grown.id === doc.id)
      || other.fields.some((field) => LINK_FIELDS[field.name] === true && field.value.split(',').some((part) => part.trim() === doc.id));
    if (viaField) entries.push({ path: other.path, title: other.title, id: other.id });
  }
  for (const other of docs.byPath.values()) {
    if (doc.id !== undefined && other.path !== doc.path && other.mentions.includes(doc.id)
        && !entries.some((entry) => entry.path === other.path)) {
      entries.push({ path: other.path, title: other.title, id: other.id });
    }
  }
  for (const other of docs.byPath.values()) {
    if (other.path !== doc.path && other.linkTargets.includes(doc.path)
        && !entries.some((entry) => entry.path === other.path)) {
      entries.push({ path: other.path, title: other.title, id: other.id });
    }
  }
  return entries;
}

/** One backlink as the page's "Linked from" shows it. */
export interface BacklinkEntry {
  path: string;
  title: string;
  id?: string;
}
