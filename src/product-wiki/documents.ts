/**
 * The set's product documents, as the wiki reads them — the reading half of
 * the set's forms (references/product.md in the set's own text): this
 * module only reads, the set's check-product check (run by `checking.ts`)
 * refuses one out of form. What a page's kind is, which fields its form
 * carries and whom its link fields name, so a wiki page shows its form's
 * truth beside its text. A page whose first line is not the set's identity
 * line and whose path names no kind of the set is no document of the set:
 * it keeps the plain page behaviour it had before this module
 * (requirement `front-matter` reads the set's kinds only).
 *
 * The kinds are the set's own, read from the set at its HEAD (cea86a2,
 * 2026-10-11): the chain of the forms' table — vision, source, hypothesis,
 * user story, use case, product requirement, open question, prototype,
 * result — the practice kind (PRA-, docs/practices/, statuses active and
 * retired), and the project documents the set's templates write: roadmap,
 * milestone, change and design records, decision records, the architecture
 * document, capability documents and the exploration note.
 */
import { dirname as dirOf, isAbsolute, join as joinPath } from 'node:path';

/** A product document's kind, as a slug for the i18n catalogues. */
export type DocumentKind =
  | 'vision'
  | 'roadmap'
  | 'milestone'
  | 'sources'
  | 'hypotheses'
  | 'stories'
  | 'use-cases'
  | 'requirements'
  | 'decisions'
  | 'design'
  | 'architecture'
  | 'capability'
  | 'change'
  | 'exploration'
  | 'questions'
  | 'prototypes'
  | 'results'
  | 'practices'
  | 'practices-retired';

/**
 * The sidebar's kind groups, in the set's life-cycle order, stated: the
 * chain of the forms' table (vision, source, hypothesis, user story, use
 * case, product requirement, open question, prototype, result) with the
 * planning documents right after the vision, the project's design-side
 * records between the product requirements and the questions (decision,
 * design, architecture, capability, change record, exploration note), and
 * the practices last — rules learned as the work went on, active first and
 * retired apart. Pages of no set kind keep their path groups after.
 */
export const KIND_ORDER: readonly DocumentKind[] = [
  'vision',
  'roadmap',
  'milestone',
  'sources',
  'hypotheses',
  'stories',
  'use-cases',
  'requirements',
  'decisions',
  'design',
  'architecture',
  'capability',
  'change',
  'exploration',
  'questions',
  'prototypes',
  'results',
  'practices',
  'practices-retired',
];

/** The id prefixes the set's forms recognize, chain and practice alike. */
const ID_REGEX = /^(PRA|S|H|US|UC|FR|Q|P|R)-\d{3,}$/;
const MENTION_REGEX = /(?<![\w-])(?:PRA|S|H|US|UC|FR|Q|P|R)-\d{3,}(?![\w-])/g;
const VISION_REGEX = /(?<![\w-])VISION(?![\w-])/;

/** The kind each id prefix names. */
const ID_PREFIX_KIND: Record<string, DocumentKind> = {
  S: 'sources',
  H: 'hypotheses',
  US: 'stories',
  UC: 'use-cases',
  FR: 'requirements',
  Q: 'questions',
  P: 'prototypes',
  R: 'results',
  PRA: 'practices',
};

/**
 * The kind a page's PATH names, when the set's places give it one: the
 * vision at docs/vision.md, the project documents the set's templates
 * write at their places, and the practices. A chain document's id wins
 * over the folder it stands in; these place kinds settle the pages that
 * carry no chain id.
 */
export function kindOfPath(path: string): DocumentKind | undefined {
  if (path === 'docs/vision.md') return 'vision';
  if (path === 'docs/roadmap.md') return 'roadmap';
  if (path.startsWith('docs/milestones/')) return 'milestone';
  if (path.startsWith('docs/explorations/')) return 'exploration';
  if (path.startsWith('docs/changes/') && path.endsWith('/change.md')) return 'change';
  if (path.startsWith('docs/changes/') && path.endsWith('/design.md')) return 'design';
  if (path.startsWith('docs/decisions/')) return 'decisions';
  if (path === 'docs/system/architecture.md') return 'architecture';
  if (path.startsWith('docs/system/capabilities/')) return 'capability';
  if (path.startsWith('docs/practices/')) return 'practices';
  return undefined;
}

/** One field as the form's `Name: value` line holds it, at its line. */
export interface DocumentField {
  name: string;
  value: string;
  /** The 1-based line the field stands on, as the set's check names it. */
  line: number;
}

/** One link-field target: an id, or `VISION`, and the field that named it. */
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
  /** The kind the identity line or the path's place gives; `undefined` for a page of no set kind. */
  kind: DocumentKind | undefined;
  /** The identity line's id (`FR-001`, `VISION`, `PRA-001`), when the page carries one. */
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
 * The status the forms say is computed, never written, read a page's own
 * text: an open question is open until its `## Answer` holds content, and
 * a result carries its verdict's first word. The other kinds derive
 * nothing here, so a status stands on the page only where the set's
 * computation can say one from the document's own links.
 */
export type ComputedStatus = 'answered' | 'open' | 'confirmed' | 'refuted' | 'unclear';

export function statusOf(doc: ParsedDocument): ComputedStatus | undefined {
  if (doc.id === undefined) return undefined;
  const prefix = doc.id.split('-')[0];
  if (prefix === 'Q') {
    const answer = doc.sections.find((s) => s.name === 'Answer');
    return answer !== undefined && answer.text.trim() !== '' ? 'answered' : 'open';
  }
  if (prefix === 'R') {
    const verdict = doc.sections.find((s) => s.name === 'Verdict');
    if (verdict === undefined) return undefined;
    const word = verdict.text.trim().match(/^(confirmed|refuted|unclear)\b/i);
    if (word === null) return undefined;
    const said = word[1];
    return said === undefined ? undefined : (said.toLowerCase() as ComputedStatus);
  }
  return undefined;
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
function mentionsOf(raw: string): string[] {
  const bare = raw.replace(/`[^`]*`/g, '');
  const ids = [...bare.matchAll(MENTION_REGEX)].map((match) => match[0]);
  if (VISION_REGEX.test(bare)) ids.push('VISION');
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

/** A link field's targets: the ids, and `VISION`, its value names. */
function grewFromOf(name: string, value: string): GrownFromId[] {
  const named = value.split(',').map((part) => part.trim()).filter(isIdOrVision);
  return named.map((id) => ({ id, via: name }));
}

/** Whether a field's value names a link target of the set: an id or VISION. */
function isIdOrVision(value: string): boolean {
  return ID_REGEX.test(value) || value === 'VISION';
}

/**
 * Reads one page's Markdown as a document of the set, or as a plain page
 * (kind `undefined`): the identity line `# <ID> — <title>` gives the
 * chain's and the practice's documents their id and kind; the path's place
 * gives the project documents theirs. The fields stand one per line as
 * `Name: value` between the identity line and the first `## ` section;
 * every section records where it begins and what it holds. A link field is
 * any field whose value names ids or `VISION`; the mentions and the body's
 * links are read outside code spans and fences, per structural line.
 */
export function parseDocument(path: string, markdown: string, held: ReadonlySet<string>): ParsedDocument {
  const all = linesOf(markdown);
  const first = all.find((line) => line.raw.trim());
  const head = first !== undefined && first.structural ? first.raw.match(/^# (\S+) — (.+)$/) : null;
  const idText = head !== null ? head[1] : undefined;
  const id = idText !== undefined && ID_REGEX.test(idText) ? idText : undefined;
  const kind = id !== undefined && id.indexOf('-') > 0 ? ID_PREFIX_KIND[id.slice(0, id.indexOf('-'))] : kindOfPath(path);
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

  const mentions: string[] = [];
  const linkTargets: string[] = [];
  const content = first === undefined ? all : all.slice(all.indexOf(first));
  for (const line of content) {
    if (!line.structural) continue;
    for (const named of mentionsOf(line.raw)) if (!mentions.includes(named)) mentions.push(named);
    for (const target of linkTargetsOf(line.raw, path, held)) if (!linkTargets.includes(target)) linkTargets.push(target);
  }

  const grewFromIds: GrownFromId[] = [];
  for (const field of fields) {
    for (const grown of grewFromOf(field.name, field.value)) {
      if (!grewFromIds.some((heldId) => heldId.id === grown.id && heldId.via === grown.via)) grewFromIds.push(grown);
    }
  }

  return { path, kind, id, title, fields, sections, grewFromIds, mentions, linkTargets };
}

// ---- across the product: the by-id index, the grown-from and backlinks ----

/** Every page's document read one product walk held. */
export interface ProductDocuments {
  /** By the page's path within the product. */
  byPath: Map<string, ParsedDocument>;
  /** By the document's id (`FR-001`, `VISION`, `PRA-001`); a page without an id is not here. */
  byId: Map<string, ParsedDocument>;
}

/**
 * Reads the set's documents out of every page's Markdown: none cached —
 * the caller re-reads the pages fresh and calls this again with what they
 * hold.
 */
export function documentsOf(paths: readonly string[], read: (path: string) => string, held: ReadonlySet<string>): ProductDocuments {
  const byPath = new Map<string, ParsedDocument>();
  const byId = new Map<string, ParsedDocument>();
  for (const path of paths) {
    const doc = parseDocument(path, read(path), held);
    byPath.set(path, doc);
    if (doc.id !== undefined && !byId.has(doc.id)) byId.set(doc.id, doc);
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
      || other.fields.some((field) => field.value.split(',').some((part) => part.trim() === doc.id));
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
