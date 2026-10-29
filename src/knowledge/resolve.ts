/**
 * Resolution of `madarch:` links (the vertical's shared formats, section 1): a
 * target is a graph logical key, a Markdown entity's id, or
 * `doc:<path>#<anchor>` for a section of a document. A target that does not
 * resolve is shown as broken with the reason, never dropped and never linked.
 */
import { findAnchor } from './anchors.js';
import type { GraphEntity, GraphReader } from './graph-read.js';
import type { CodeLocation } from './model.js';
import type { MarkdownEntity } from './markdown.js';
import { parseTarget } from './markdown.js';

export type Resolution =
  | { state: 'ok'; target: string; kind: string; label: string; href: string | null; note?: string; location?: CodeLocation; /** The id or key of the entity the target is, when it is one. */ entity?: string }
  /** `why` is the reason as data, so the app can say it in the reader's language; `reason` is the same in English for an engineer. */
  | { state: 'broken'; target: string; reason: string; why?: BrokenWhy };

export type BrokenWhy =
  | { code: 'empty' }
  | { code: 'no-entity'; key: string }
  | { code: 'no-path' }
  | { code: 'no-document'; path: string }
  | { code: 'no-section'; path: string; anchor: string; repos: string };

/**
 * A name in an address: a terminal `.md` or `.json` would be read as the file's
 * suffix, so that one dot is encoded and an entity whose id ends in it keeps an
 * HTML address of its own.
 */
function addressName(name: string): string {
  // Parentheses are sub-delimiters `encodeURIComponent` keeps, and an unbalanced
  // one would end a Markdown destination early; written as escapes they cannot.
  const encoded = encodeURIComponent(name).replaceAll('(', '%28').replaceAll(')', '%29');
  for (const suffix of ['.md', '.json']) {
    if (encoded.endsWith(suffix)) return `${encoded.slice(0, -suffix.length)}%2E${suffix.slice(1)}`;
  }
  return encoded;
}

/** Where an entity page and a source view stand in the app. */
export const entityAddress = (key: string): string => `/k/e/${addressName(key)}`;
export const kindAddress = (kind: string): string => `/k/kind/${addressName(kind)}`;
export function sourceAddress(repo: string | null, path: string, line?: number): string {
  const query = new URLSearchParams();
  if (repo !== null) query.set('repo', repo);
  query.set('path', path);
  if (line !== undefined) query.set('line', String(line));
  return `/k/src?${query.toString()}`;
}

export { findAnchor, slugOf } from './anchors.js';

/** Where a Markdown document stands in the app: a page of its own, at the section an anchor names. */
export function documentAddress(repo: string | null, path: string, anchor?: string | null): string {
  const query = new URLSearchParams();
  if (repo !== null) query.set('repo', repo);
  query.set('path', path);
  return `/k/doc?${query.toString()}${anchor === undefined || anchor === null || anchor === '' ? '' : `#${encodeURIComponent(anchor)}`}`;
}

const isMarkdownPath = (path: string): boolean => /\.(md|markdown)$/i.test(path);

/** What is said of a key that names nothing. */
export const noEntityMessage = (key: string, language?: string): string => (language === 'ru'
  ? `сущности "${key}" нет ни в графе, ни среди Markdown-страниц продукта`
  : `no entity "${key}" in the graph or among the product's Markdown pages`);

export interface ResolverDeps {
  graph: GraphReader;
  /** Markdown entities by id. */
  markdown: ReadonlyMap<string, MarkdownEntity>;
  /** Kinds the manifest declares, for whether an entity has a page. */
  declared: (kind: string) => boolean;
  /** A document's text from the product repository (`null`) or a code repository by name; `undefined` when it is not there. */
  readDocument: (repo: string | null, path: string) => Promise<string | undefined>;
  /** The names of the code repositories, in the order they are searched. */
  repositories: () => readonly string[];
  /** Where an entity is declared, for a reference to code to open the source at its line. */
  locate: (entity: GraphEntity) => CodeLocation | undefined;
  /** The entity of a document that starts at a line of the document, when the manifest's document kinds make one of it. */
  documentEntity?: (repo: string | null, path: string, line: number) => { id: string; kind: string; title: string } | undefined;
  /**
   * The entity of a document whose source anchor is the fragment, when the manifest's document kinds make one of it: a
   * passage address (`stories.1.2`) names one meaning of a paragraph, and only the entity's own anchor says which.
   */
  documentEntityByAnchor?: (repo: string | null, path: string, anchor: string) => { id: string; kind: string; title: string } | undefined;
  /**
   * The entity of a document whose durable identity is the fragment, when the manifest's document kinds make one of it:
   * a page id (`doc:<path>#<stableId>`) is a link that outlives a renamed heading or a removed `UC-`/`BR-` alias, so the
   * resolver must find the page by that identity and not only by the anchor the document writes now (finding 2).
   */
  documentEntityById?: (repo: string | null, path: string, stableId: string) => { id: string; kind: string; title: string } | undefined;
}

export class Resolver {
  private readonly cache = new Map<string, Resolution>();

  constructor(private readonly deps: ResolverDeps) {}

  async resolve(url: string): Promise<Resolution> {
    const held = this.cache.get(url);
    if (held !== undefined) return held;
    const resolved = await this.resolveNow(url);
    this.cache.set(url, resolved);
    return resolved;
  }

  private async resolveNow(url: string): Promise<Resolution> {
    const target = parseTarget(url);
    if (target.kind === 'doc') return await this.resolveDocument(url, target.path, target.anchor);
    const key = target.key;
    if (key === '') return { state: 'broken', target: url, reason: 'the link names nothing after "madarch:"', why: { code: 'empty' } };
    const markdown = this.deps.markdown.get(key);
    if (markdown !== undefined) return { state: 'ok', target: url, kind: markdown.kind, label: markdown.title, href: this.deps.declared(markdown.kind) ? entityAddress(key) : null, entity: key };
    const found = await this.deps.graph.find(key);
    if (found.length === 0) {
      return { state: 'broken', target: url, reason: noEntityMessage(key), why: { code: 'no-entity', key } };
    }
    return resolutionOfEntity(url, found[0]!, this.deps.declared(found[0]!.kind), this.deps.locate(found[0]!), found.length > 1 ? `the key is also in ${found.length - 1} other repositor${found.length === 2 ? 'y' : 'ies'}; the first is shown` : undefined);
  }

  private async resolveDocument(url: string, path: string, anchor: string | null): Promise<Resolution> {
    if (path === '') return { state: 'broken', target: url, reason: 'the document link names no path', why: { code: 'no-path' } };
    // `@<repository>/<path>` names the repository the document stands in; a path with no qualifier is looked for in the
    // product repository first and then in each connected one (madarch-ztyq.3, the review of finding C(a)).
    const qualifier = path.startsWith('@') ? path.slice(1) : null;
    const slash = qualifier === null ? -1 : qualifier.indexOf('/');
    const named = qualifier !== null && slash > 0 ? qualifier.slice(0, slash) : null;
    const where = named === null ? path : qualifier!.slice(slash + 1);
    const roots: (string | null)[] = named === null ? [null, ...this.deps.repositories()] : [named];
    const seen: string[] = [];
    for (const root of roots) {
      const text = await this.deps.readDocument(root, where);
      if (text === undefined) continue;
      seen.push(root ?? 'the product repository');
      // A Markdown document opens as a page of the wiki at its section; any other file opens in the source view.
      if (anchor === null || anchor === '') return { state: 'ok', target: url, kind: 'document', label: where, href: isMarkdownPath(where) ? documentAddress(root, where) : sourceAddress(root, where) };
      // Two kinds of reference, kept apart (madarch-ztyq.3, the review of finding A). A GROUND written as a source anchor
      // names the part the document gives that anchor NOW, so after two numbers swap it opens the passage that carries
      // `uc-1` today, and an anchor the document no longer has is a broken section rather than a stale identity. A page
      // id names a durable identity, which no anchor can spell (it holds a colon), so it resolves by identity alone.
      const line = findAnchor(text, anchor);
      const byAnchor = this.deps.documentEntityByAnchor?.(root, where, anchor.toLowerCase());
      const atLine = line === null ? undefined : this.deps.documentEntity?.(root, where, line);
      const atAnchor = byAnchor ?? atLine;
      const entity = atAnchor ?? this.deps.documentEntityById?.(root, where, anchor);
      if (entity !== undefined && this.deps.declared(entity.kind)) return { state: 'ok', target: url, kind: entity.kind, label: entity.title, href: entityAddress(entity.id), entity: entity.id };
      if (line !== null) return { state: 'ok', target: url, kind: 'document', label: `${where}#${anchor}`, href: isMarkdownPath(where) ? documentAddress(root, where, anchor) : sourceAddress(root, where, line) };
    }
    if (seen.length === 0) return { state: 'broken', target: url, reason: `no document "${where}" in ${named === null ? 'the product repository or its code repositories' : `the repository ${named}`}`, why: { code: 'no-document', path: where } };
    return { state: 'broken', target: url, reason: `the document "${where}" (in ${seen.join(', ')}) has no section "${anchor}"`, why: { code: 'no-section', path: where, anchor: anchor ?? '', repos: seen.join(', ') } };
  }
}

/** The resolution of a graph entity: its page when the manifest declares its kind, else its source when it has one. */
export function resolutionOfEntity(url: string, entity: GraphEntity, hasPage: boolean, location: CodeLocation | undefined, note?: string): Resolution {
  return {
    state: 'ok',
    target: url,
    kind: entity.kind,
    label: entity.label,
    href: hasPage ? entityAddress(entity.key) : null,
    entity: entity.key,
    ...(note === undefined ? {} : { note }),
    ...(location === undefined ? {} : { location }),
  };
}
