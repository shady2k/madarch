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
  | { state: 'ok'; target: string; kind: string; label: string; href: string | null; note?: string; location?: CodeLocation }
  | { state: 'broken'; target: string; reason: string };

/** Where an entity page and a source view stand in the app. */
export const entityAddress = (key: string): string => `/k/e/${encodeURIComponent(key)}`;
export const kindAddress = (kind: string): string => `/k/kind/${encodeURIComponent(kind)}`;
export function sourceAddress(repo: string | null, path: string, line?: number): string {
  const query = new URLSearchParams();
  if (repo !== null) query.set('repo', repo);
  query.set('path', path);
  if (line !== undefined) query.set('line', String(line));
  return `/k/src?${query.toString()}`;
}

export { findAnchor, slugOf } from './anchors.js';

/** What is said of a key that names nothing. */
export const noEntityMessage = (key: string): string => `no entity "${key}" in the graph or among the product's Markdown pages`;

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
    if (key === '') return { state: 'broken', target: url, reason: 'the link names nothing after "madarch:"' };
    const markdown = this.deps.markdown.get(key);
    if (markdown !== undefined) return { state: 'ok', target: url, kind: markdown.kind, label: markdown.title, href: this.deps.declared(markdown.kind) ? entityAddress(key) : null };
    const found = await this.deps.graph.find(key);
    if (found.length === 0) {
      return { state: 'broken', target: url, reason: noEntityMessage(key) };
    }
    return resolutionOfEntity(url, found[0]!, this.deps.declared(found[0]!.kind), this.deps.locate(found[0]!), found.length > 1 ? `the key is also in ${found.length - 1} other repositor${found.length === 2 ? 'y' : 'ies'}; the first is shown` : undefined);
  }

  private async resolveDocument(url: string, path: string, anchor: string | null): Promise<Resolution> {
    if (path === '') return { state: 'broken', target: url, reason: 'the document link names no path' };
    const roots: (string | null)[] = [null, ...this.deps.repositories()];
    const seen: string[] = [];
    for (const root of roots) {
      const text = await this.deps.readDocument(root, path);
      if (text === undefined) continue;
      seen.push(root ?? 'the product repository');
      if (anchor === null || anchor === '') return { state: 'ok', target: url, kind: 'document', label: path, href: sourceAddress(root, path) };
      const line = findAnchor(text, anchor);
      if (line !== null) return { state: 'ok', target: url, kind: 'document', label: `${path}#${anchor}`, href: sourceAddress(root, path, line) };
    }
    if (seen.length === 0) return { state: 'broken', target: url, reason: `no document "${path}" in the product repository or its code repositories` };
    return { state: 'broken', target: url, reason: `the document "${path}" (in ${seen.join(', ')}) has no section "${anchor}"` };
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
    ...(note === undefined ? {} : { note }),
    ...(location === undefined ? {} : { location }),
  };
}
