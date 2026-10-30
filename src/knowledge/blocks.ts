/**
 * The block library (decision 0029): `body`, `related`, `callers`, `callees`
 * and `source`; the diagram blocks (`graph`, `treemap`) are `diagrams.ts` and
 * the drawn views (`system`, `modules`, `er`, `sequence`) are `views.ts`. The engine owns the blocks; a
 * template arranges them. Each block reads the graph or the Markdown and
 * answers a shape of `model.ts`, or a `problem` block that says why it could
 * not, with the template's file and line.
 *
 * The blocks that follow code relations (`callers`, `callees`, `sequence`)
 * and containment (`related` with a depth, the breadcrumb) read the engine's
 * own extractor schema (`code.calls`, `code.contains`) as their defaults; a
 * template names another relation with `relation="..."`.
 */
import { CALLS } from '../graph/vocabulary.js';
import { byCodePoint } from '../model/order.js';
import type { DocEntity, DocumentSource } from './doc-entities.js';
import { detectDocumentLanguage } from '../writer/localized-source.js';
import type { KindCount, RelyingStatement } from './index/queries.js';
import type { GraphEntity, GraphReader, SourceSpan } from './graph-read.js';
import type { KindsManifest, PropertyDecl, PropertyFormat } from './kinds.js';
import type { MarkdownEntity } from './markdown.js';
import { readBody } from './markdown.js';
import type { Block, CallRow, CodeLocation, EntityRef, RelatedGroup } from './model.js';
import { entityAddress, noEntityMessage, sourceAddress, type Resolver } from './resolve.js';

export type Subject = { source: 'graph'; entity: GraphEntity } | { source: 'markdown'; entity: MarkdownEntity } | { source: 'document'; entity: DocEntity };

export interface RenderContext {
  productFolder: string;
  manifest: KindsManifest;
  graph: GraphReader;
  markdown: ReadonlyMap<string, MarkdownEntity>;
  /** The entities of the manifest's document kinds, by id. */
  docEntities: ReadonlyMap<string, DocEntity>;
  /** The validated product-repository translation for an extracted document entity, by id. */
  localizedSources: ReadonlyMap<string, import('../writer/localized-source.js').LocalizedDocumentSource>;
  /** The current product wiki language, used when rendering document entities. */
  language: string;
  /** The Markdown documents the entities were read from (the product repository's and the code repositories'). */
  documents: readonly DocumentSource[];
  /** The names of the code repositories, in the order documents are searched. */
  repositories: readonly string[];
  /** The same place on the repository's web page (GitHub, GitLab, ...), when the repository's address is known. */
  webOf?: (repo: string | null, path: string, lineStart: number, lineEnd: number) => { host: string; url: string } | undefined;
  /** What the index of the Markdown (madarch-m38l.8) knows: the statements that rely on a key, and the counts per page kind. */
  index?: {
    relyingOn: (key: string) => Promise<RelyingStatement[]>;
    counts: () => Promise<KindCount[]>;
  };
  /** The commit a code repository was filled from, by name. */
  commitOf: (repo: string) => string | null;
  resolver: Resolver;
  /** The code repository a scope node is, by name. */
  repoOfScope: (scope: string) => string | undefined;
  /** A file's text in a repository at the commit the graph was filled from; null repo is the product repository. */
  readSource: (repo: string | null, path: string) => Promise<string | undefined>;
}

export const idOf = (subject: Subject): string => (subject.source === 'graph' ? subject.entity.key : subject.entity.id);
export const kindOf = (subject: Subject): string => subject.entity.kind;

const LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', mjs: 'javascript', go: 'go', sql: 'sql', json: 'json', yaml: 'yaml', yml: 'yaml',
  md: 'markdown', proto: 'protobuf', prisma: 'prisma', sh: 'shell', toml: 'toml', mod: 'go',
};

export function languageOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (name === 'Dockerfile' || name.startsWith('Dockerfile.')) return 'dockerfile';
  if (name === 'Makefile') return 'makefile';
  return LANGUAGES[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? 'text';
}

/** Where a span of a graph entity is: its repository by scope, the path and the lines. */
export function locationOf(ctx: Pick<RenderContext, 'repoOfScope' | 'webOf'>, scope: string, span: SourceSpan): CodeLocation {
  const repo = ctx.repoOfScope(scope) ?? null;
  const web = ctx.webOf?.(repo, span.path, span.lineStart, span.lineEnd);
  return { repo, path: span.path, lineStart: span.lineStart, lineEnd: span.lineEnd, href: sourceAddress(repo, span.path, span.lineStart), ...(web === undefined ? {} : { web }) };
}

export function refOfGraph(ctx: RenderContext, entity: GraphEntity, span?: SourceSpan): EntityRef {
  // A file has no declaration span: its place is the file, from its first line.
  const path = entity.properties['path'];
  const where = span ?? entity.span ?? (typeof path === 'string' ? { path, lineStart: 1, lineEnd: 1, byteStart: 0, byteEnd: 0 } : undefined);
  return {
    id: entity.key,
    kind: entity.kind,
    label: entity.label,
    href: ctx.manifest.kinds.has(entity.kind) ? entityAddress(entity.key) : null,
    ...(where === undefined ? {} : { location: locationOf(ctx, entity.scope, where) }),
  };
}

export function refOfMarkdown(ctx: RenderContext, entity: MarkdownEntity | DocEntity): EntityRef {
  return { id: entity.id, kind: entity.kind, label: entity.title, href: ctx.manifest.kinds.has(entity.kind) ? entityAddress(entity.id) : null };
}

const toInt = (value: string | undefined, fallback: number, min: number, max: number): number => {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

const list = (value: string | undefined): string[] | undefined => (value === undefined ? undefined : value.split(',').map((entry) => entry.trim()).filter(Boolean));

/** A relation type as a reader reads it on an edge: the extractor prefix dropped. */
export function relationWord(relation: string): string {
  return relation.startsWith('code.') ? relation.slice('code.'.length) : relation.startsWith('engine:') ? relation.slice('engine:'.length) : relation;
}

/** The edges the manifest declares for the entity's kind, resolved against the graph: only the ones whose other end exists. */
export async function declaredNeighbors(ctx: RenderContext, subject: Subject): Promise<RelatedGroup[]> {
  if (subject.source !== 'graph') return [];
  const decl = ctx.manifest.kinds.get(subject.entity.kind);
  const groups = new Map<string, RelatedGroup>();
  for (const relation of decl?.relations ?? []) {
    const key = relation.to.replace(/\{([\w.-]+)(?:\|(dirname|basename))?\}/g, (_whole, name: string, filter: string | undefined) => {
      const value = attributeOf(subject, name) ?? '';
      if (filter === 'dirname') return value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : '.';
      if (filter === 'basename') return value.slice(value.lastIndexOf('/') + 1);
      return value;
    });
    const found = await ctx.graph.find(key);
    if (found.length === 0) continue;
    const group = groups.get(relation.type) ?? { relation: relation.type, direction: 'out' as const, total: 0, rows: [] };
    group.rows.push({ entity: refOfGraph(ctx, found[0]!), count: 1 });
    group.total += 1;
    groups.set(relation.type, group);
  }
  return [...groups.values()];
}

/** The value of `{{name}}` for an entity: its fields, its properties by dotted path, lists joined. */
export function attributeOf(subject: Subject, name: string): string | undefined {
  const stringify = (value: unknown): string | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.map((entry) => stringify(entry) ?? '').filter((entry) => entry !== '').join(', ');
    return JSON.stringify(value);
  };
  const dig = (from: unknown, path: string): unknown => {
    let cursor: unknown = from;
    for (const part of path.split('.')) {
      if (cursor === null || typeof cursor !== 'object') return undefined;
      cursor = (cursor as Record<string, unknown>)[part];
    }
    return cursor;
  };
  if (subject.source === 'graph') {
    const entity = subject.entity;
    if (name === 'label') return entity.label;
    if (name === 'key' || name === 'id') return entity.key;
    // The key after its kind and colon: the part a child's key repeats (a table's key minus its kind, for its columns).
    if (name === 'keyrest') return entity.key.slice(entity.key.indexOf(':') + 1);
    if (name === 'kind') return entity.kind;
    const whole = entity.properties[name];
    if (whole !== undefined) return stringify(whole);
    return stringify(dig(entity.properties, name));
  }
  if (subject.source === 'document') {
    const doc = subject.entity;
    if (name === 'title' || name === 'label') return doc.title;
    if (name === 'id' || name === 'key') return doc.id;
    if (name === 'kind') return doc.kind;
    if (name === 'identifier') return doc.identifier ?? undefined;
    if (name === 'path' || name === 'file') return doc.path;
    if (name === 'repo') return doc.repo ?? undefined;
    if (name === 'anchor') return doc.anchor;
    if (name === 'line') return String(doc.line);
    return undefined;
  }
  const entity = subject.entity;
  if (name === 'title' || name === 'label') return entity.title;
  if (name === 'id' || name === 'key') return entity.id;
  if (name === 'kind') return entity.kind;
  if (name === 'slug') return entity.id.slice(entity.id.indexOf(':') + 1);
  if (name === 'file') return entity.file;
  if (name === 'producer') return entity.producer ?? undefined;
  return stringify(entity.front[name]) ?? stringify(dig(entity.front, name));
}

/**
 * The attributes a page's Liquid template reads, as `{{label}}` and as
 * `{{page.label}}`: the reserved ones every page has, the ones its kind declares,
 * and — for a kind that declares none — every flat property the entity holds.
 * They are the values `attributeOf` gives, so a page says the same thing in
 * either template language.
 */
export function pageAttributes(subject: Subject, declared?: readonly string[]): Record<string, string> {
  const names = new Set<string>(['label', 'title', 'key', 'keyrest', 'id', 'kind', 'slug', 'file', 'producer']);
  if (declared !== undefined) for (const name of declared) names.add(name);
  else if (subject.source === 'graph') for (const name of Object.keys(subject.entity.properties)) names.add(name);
  else if (subject.source === 'markdown') for (const name of Object.keys(subject.entity.front)) names.add(name);
  else for (const name of ['identifier', 'path', 'repo', 'anchor', 'line']) names.add(name);
  const attributes: Record<string, string> = {};
  for (const name of [...names].sort()) {
    const value = attributeOf(subject, name);
    if (value !== undefined) attributes[name] = value;
  }
  return attributes;
}

// ---- body -------------------------------------------------------------------------------------

export function bodyBlock(ctx: RenderContext, subject: Subject, block: string, file: string, line: number): Block {
  // A document entity's identity and source remain those of the original document; a valid translation is only its reader-facing statement.
  if (subject.source === 'document') {
    const source = ctx.localizedSources.get(subject.entity.id);
    const sourceLanguage = detectDocumentLanguage(subject.entity.text);
    const needsLocalization = sourceLanguage !== ctx.language;
    if (needsLocalization && source === undefined) return { type: 'problem', block, file: subject.entity.path, line: subject.entity.line, message: `no valid localized statement for ${subject.entity.id} in ${ctx.language}; see the localized-source finding for its file and line` };
    const sameLanguage = source !== undefined && source.sourceLanguage === ctx.language;
    return {
      type: 'body', markdown: source === undefined || sameLanguage ? subject.entity.text : source.statement,
      file: subject.entity.path, statements: 0, ungrounded: [],
      ...(source === undefined || sameLanguage ? {} : { localized: { statement: source.statement, original: source.original, sourceDocument: source.sourceDocument, sourceLine: source.sourceLine, sourceEndLine: source.sourceEndLine } }),
    };
  }
  if (subject.source !== 'markdown') {
    return { type: 'problem', block, file, line, message: 'the body block shows the Markdown of a page; the entities of this kind come from the graph and have none' };
  }
  const reading = readBody(subject.entity.body, subject.entity.file, subject.entity.bodyLine);
  return { type: 'body', markdown: subject.entity.body, file: subject.entity.file, statements: reading.statements, ungrounded: reading.ungrounded };
}

// ---- related and graph ------------------------------------------------------------------------

/** Markdown pages that name the key in `relates`, and the pages a Markdown page relates to. */
export async function relatesGroups(ctx: RenderContext, subject: Subject): Promise<RelatedGroup[]> {
  if (subject.source === 'document') return [];
  if (subject.source === 'graph') {
    const rows = [...ctx.markdown.values()].filter((page) => page.relates.includes(subject.entity.key)).map((page) => ({ entity: refOfMarkdown(ctx, page), count: 1 }));
    return rows.length === 0 ? [] : [{ relation: 'relates', direction: 'in', total: rows.length, rows }];
  }
  const rows: RelatedGroup['rows'] = [];
  for (const key of subject.entity.relates) {
    const markdown = ctx.markdown.get(key);
    if (markdown !== undefined) {
      rows.push({ entity: refOfMarkdown(ctx, markdown), count: 1 });
      continue;
    }
    const found = await ctx.graph.find(key);
    if (found.length > 0) rows.push({ entity: refOfGraph(ctx, found[0]!), count: 1 });
    else rows.push({ entity: { id: key, kind: key.slice(0, Math.max(0, key.indexOf(':'))), label: key, href: null, broken: noEntityMessage(key) }, count: 1 });
  }
  return rows.length === 0 ? [] : [{ relation: 'relates', direction: 'out', total: rows.length, rows }];
}

export async function relatedBlock(ctx: RenderContext, subject: Subject, params: Readonly<Record<string, string>>, file: string, line: number): Promise<Block> {
  const title = params['title'] ?? 'Related';
  const relations = list(params['relation']);
  const kinds = list(params['kind']);
  const limit = toInt(params['limit'], 50, 1, 500);
  const depth = toInt(params['depth'], 1, 1, 6);
  const direction = params['direction'];
  if (direction !== undefined && direction !== 'out' && direction !== 'in' && direction !== 'both') {
    return { type: 'problem', block: 'related', file, line, message: `direction is "out", "in" or "both", got "${direction}"` };
  }
  const groups: RelatedGroup[] = [];
  const wantsRelates = relations === undefined || relations.includes('relates');
  if (subject.source === 'graph') {
    const entity = subject.entity;
    const declared = (await declaredNeighbors(ctx, subject)).filter((group) => relations === undefined || relations.includes(group.relation));
    if (depth > 1) {
      if (relations === undefined || relations.length !== 1) return { type: 'problem', block: 'related', file, line, message: 'a related block with a depth follows exactly one relation: add relation="..."' };
      const relation = relations[0]!;
      const reached = new Map<string, { entity: EntityRef; hops: number }>();
      const note = (ref: EntityRef, hops: number): void => {
        const held = reached.get(ref.id);
        if (held === undefined || hops < held.hops) reached.set(ref.id, { entity: ref, hops });
      };
      for (const row of (await ctx.graph.reach(entity, relation, depth, 500)).rows) note(refOfGraph(ctx, row.entity), row.hops);
      for (const group of declared) {
        if (group.relation !== relation) continue;
        for (const seed of group.rows) {
          note(seed.entity, 1);
          const [seedEntity] = await ctx.graph.find(seed.entity.id);
          if (seedEntity === undefined) continue;
          for (const row of (await ctx.graph.reach(seedEntity, relation, depth - 1, 500)).rows) note(refOfGraph(ctx, row.entity), row.hops + 1);
        }
      }
      const ordered = [...reached.values()].filter((row) => kinds === undefined || kinds.includes(row.entity.kind)).sort((a, b) => a.hops - b.hops || byCodePoint(a.entity.id, b.entity.id));
      const rows = ordered.slice(0, limit).map((row) => ({ entity: row.entity, count: 1, hops: row.hops }));
      const total = ordered.length;
      if (total > 0) groups.push({ relation: relations[0]!, direction: 'out', total, rows });
    } else {
      for (const group of direction === 'in' ? [] : declared) {
        const rows = group.rows.filter((row) => kinds === undefined || kinds.includes(row.entity.kind));
        if (rows.length > 0) groups.push({ ...group, total: rows.length, rows });
      }
      for (const group of await ctx.graph.neighbors(entity, { ...(relations === undefined ? {} : { relations }), direction: direction ?? 'both', limit })) {
        const rows = group.rows.filter((row) => kinds === undefined || kinds.includes(row.entity.kind)).map((row) => ({ entity: refOfGraph(ctx, row.entity), count: row.edges }));
        if (kinds !== undefined && rows.length === 0) continue;
        groups.push({ relation: group.relation, direction: group.direction, total: kinds === undefined ? group.total : rows.length, rows });
      }
    }
  }
  if (wantsRelates && depth === 1) {
    for (const group of await relatesGroups(ctx, subject)) {
      const rows = group.rows.filter((row) => kinds === undefined || kinds.includes(row.entity.kind) || row.entity.broken !== undefined);
      if (rows.length > 0) groups.push({ ...group, total: rows.length, rows: rows.slice(0, limit) });
    }
  }
  groups.sort((a, b) => byCodePoint(a.relation, b.relation) || (a.direction === b.direction ? 0 : a.direction === 'out' ? -1 : 1));
  return { type: 'related', title, groups };
}

// ---- callers and callees ----------------------------------------------------------------------

export async function callBlock(ctx: RenderContext, subject: Subject, direction: 'in' | 'out', params: Readonly<Record<string, string>>, file: string, line: number): Promise<Block> {
  const type = direction === 'in' ? 'callers' : 'callees';
  if (subject.source !== 'graph') {
    return { type: 'problem', block: type, file, line, message: `the ${type} block follows relations of the graph; the entities of this kind are Markdown pages` };
  }
  const relation = params['relation'] ?? CALLS;
  const title = params['title'] ?? (direction === 'in' ? 'Callers' : 'Callees');
  const found = await ctx.graph.edgesOf(subject.entity, relation, direction, toInt(params['limit'], 100, 1, 1000));
  const rows: CallRow[] = found.rows.map((edge) => {
    const site = edge.span !== undefined ? locationOf(ctx, subject.entity.scope, edge.span) : undefined;
    return { entity: refOfGraph(ctx, edge.other), sites: Number(edge.properties['sites'] ?? 1), ...(site === undefined ? {} : { site }) };
  });
  return { type, title, total: found.total, rows };
}

// ---- source -----------------------------------------------------------------------------------

/** The most lines a source block shows; the rest is one click away in the source view. */
export const SOURCE_BLOCK_LINES = 200;

export async function sourceBlock(ctx: RenderContext, subject: Subject, params: Readonly<Record<string, string>>, file: string, line: number): Promise<Block> {
  if (subject.source !== 'graph') return { type: 'problem', block: 'source', file, line, message: 'the source block shows code; the entities of this kind are Markdown pages' };
  const entity = subject.entity;
  const span = entity.span ?? (typeof entity.properties['path'] === 'string' ? { path: entity.properties['path'], lineStart: 1, lineEnd: Number.MAX_SAFE_INTEGER, byteStart: 0, byteEnd: Number.MAX_SAFE_INTEGER } : undefined);
  if (span === undefined) return { type: 'problem', block: 'source', file, line, message: `${entity.key} has no declaration span and no path: nothing to show` };
  const repo = ctx.repoOfScope(entity.scope) ?? null;
  const text = await ctx.readSource(repo, span.path);
  if (text === undefined) {
    // History retains the old identity after a rename. Never present the successor's bytes as the old path at HEAD.
    if (entity.kind === 'code.file') {
      const renamed = await ctx.graph.edgesOf(entity, 'code.renamed-to', 'out', 500);
      const successors = [];
      for (const row of renamed.rows) {
        if (row.other.scope !== entity.scope || row.other.kind !== 'code.file') continue;
        const path = row.other.span?.path ?? row.other.properties['path'];
        if (typeof path === 'string' && await ctx.readSource(repo, path) !== undefined) successors.push(row.other);
      }
      if (successors.length > 0) return {type:'refs',title:ctx.language === 'ru' ? 'Файл переименован; исходный путь отсутствует в текущей ревизии' : 'File renamed; the original path is absent at the filled revision',total:successors.length,rows:successors.map((successor)=>({entity:refOfGraph(ctx,successor)}))};
    }
    return { type: 'problem', block: 'source', file, line, message: `the file ${span.path} is not readable in ${repo ?? 'the product repository'} at the commit the graph was filled from` };
  }
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const end = Math.min(span.lineEnd, lines.length);
  const stop = Math.min(end, span.lineStart + SOURCE_BLOCK_LINES - 1);
  return {
    type: 'source',
    title: params['title'] ?? 'Source',
    location: { repo, path: span.path, lineStart: span.lineStart, lineEnd: end, href: sourceAddress(repo, span.path, span.lineStart), ...(ctx.webOf?.(repo, span.path, span.lineStart, end) === undefined ? {} : { web: ctx.webOf(repo, span.path, span.lineStart, end)! }) },
    language: languageOf(span.path),
    text: lines.slice(span.lineStart - 1, stop).join('\n'),
    truncated: stop < end,
  };
}

// ---- properties -------------------------------------------------------------------------------

const YES_NO: Readonly<Record<string, readonly [string, string]>> = { en: ['yes', 'no'], ru: ['да', 'нет'] };

/** One object's values as words, never as JSON: a port's name and numbers, a build's file and context, a script's command. */
function objectWords(value: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [name, held] of Object.entries(value)) {
    if (held === null || held === undefined || held === '') continue;
    if (typeof held === 'string' || typeof held === 'number' || typeof held === 'boolean') parts.push(`${name} ${held}`);
    else if (Array.isArray(held)) parts.push(`${name} ${held.map((entry) => (typeof entry === 'string' || typeof entry === 'number' ? String(entry) : '')).filter(Boolean).join(', ')}`);
  }
  return parts.join(', ');
}

function portWords(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value === null || typeof value !== 'object') return '';
  const port = value as Record<string, unknown>;
  const name = typeof port['name'] === 'string' && port['name'] !== '' ? `${port['name']}: ` : '';
  const number = port['port'] === undefined ? '' : String(port['port']);
  const target = port['targetPort'] === undefined ? '' : ` → ${String(port['targetPort'])}`;
  return `${name}${number}${target}`;
}

/**
 * A property value as the reader reads it. The manifest says how: a list, commands, ports, a date, yes/no.
 * An object with no reader-facing shape is left out, so serialized JSON never reaches a page (madarch-m38l.21).
 */
function propertyText(value: unknown, format: PropertyFormat, lang: string): { value: string; valueKind?: 'date' | 'boolean' | 'code' } | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (Array.isArray(value) && value.length === 0) return undefined;
  const words = (entries: readonly unknown[]): string => entries.map((entry) => {
    if (format === 'ports') return portWords(entry);
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') return String(entry);
    return entry !== null && typeof entry === 'object' ? objectWords(entry as Record<string, unknown>) : '';
  }).filter((entry) => entry !== '').join(format === 'commands' ? '; ' : ', ');
  let text: string;
  let valueKind: 'date' | 'boolean' | 'code' | undefined;
  if (format === 'boolean' || typeof value === 'boolean') {
    text = (YES_NO[lang] ?? YES_NO['en']!)[value === true ? 0 : 1];
    valueKind = 'boolean';
  } else if (format === 'commands') {
    const parsed = typeof value === 'string' && value.trim().startsWith('[') ? (() => { try { const held: unknown = JSON.parse(value); return Array.isArray(held) ? held : undefined; } catch { return undefined; } })() : undefined;
    text = parsed === undefined ? (Array.isArray(value) ? words(value) : String(value)) : parsed.map(String).join(' ');
  } else if (format === 'ports') {
    text = Array.isArray(value) ? words(value) : portWords(value);
  } else if (format === 'build') {
    text = value !== null && typeof value === 'object' && !Array.isArray(value) ? objectWords(value as Record<string, unknown>) : String(value);
  } else if (format === 'scripts') {
    text = value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value as Record<string, unknown>).map(([key, held]) => `${key}: ${typeof held === 'string' ? held : objectWords(held as Record<string, unknown>)}`).join('; ') : String(value);
  } else if (Array.isArray(value)) {
    text = words(value);
  } else if (typeof value === 'object') {
    const summary = objectWords(value as Record<string, unknown>);
    if (summary === '') return undefined;
    text = summary;
  } else {
    text = String(value);
  }
  if (format === 'date') valueKind = 'date';
  if (format === 'code' && typeof value !== 'object') valueKind = 'code';
  return { value: text.length > 240 ? `${text.slice(0, 239)}…` : text, ...(valueKind === undefined ? {} : { valueKind }) };
}

/** The rows a kind's `details` name, in their order: every key labelled from the manifest, every value written for a reader. */
export function detailRows(
  entity: { properties: Record<string, unknown> },
  details: readonly string[] | undefined,
  properties: ReadonlyMap<string, PropertyDecl>,
  lang: string,
): import('./model.js').PropertyRow[] {
  if (details === undefined) return [];
  const rows: import('./model.js').PropertyRow[] = [];
  for (const name of details) {
    const decl = properties.get(name);
    if (decl === undefined) continue;
    const written = propertyText(entity.properties[name], decl.format, lang);
    if (written === undefined) continue;
    rows.push({ name, label: decl.labels[lang] ?? decl.labels['en'] ?? name, ...written });
  }
  return rows;
}

export function propertiesBlock(
  subject: Subject,
  params: Readonly<Record<string, string>>,
  file: string,
  line: number,
  details: readonly string[] | undefined,
  properties: ReadonlyMap<string, PropertyDecl>,
  lang: string,
): Block {
  const title = params['title'] ?? 'Details';
  if (subject.source === 'document') {
    const doc = subject.entity;
    const row = (name: string, value: string): import('./model.js').PropertyRow | undefined => {
      const decl = properties.get(name);
      return decl === undefined || value === '' ? undefined : { name, value, label: decl.labels[lang] ?? decl.labels['en'] ?? name };
    };
    const rows = [row('identifier', doc.identifier ?? ''), row('document', doc.path), row('line', String(doc.line))].filter((entry): entry is import('./model.js').PropertyRow => entry !== undefined);
    return { type: 'properties', title, rows };
  }
  if (subject.source !== 'graph') return { type: 'problem', block: 'properties', file, line, message: 'the properties block lists what the extractors read; the entities of this kind are Markdown pages (their front matter is theirs)' };
  return { type: 'properties', title, rows: detailRows(subject.entity, details, properties, lang) };
}

// ---- members ----------------------------------------------------------------------------------

/** The fragment a member has on its parent's page: stable for the entity's id, and usable as an HTML id. */
export function memberAnchor(id: string): string {
  return `member-${encodeURIComponent(id)}`;
}

/** The entity whose page a member belongs on: the edge the kind declares, else the property that names the parent. */
export async function memberParent(ctx: RenderContext, subject: Subject, member: import('./kinds.js').MemberDecl): Promise<GraphEntity | undefined> {
  if (subject.source !== 'graph') return undefined;
  const found = await ctx.graph.edgesOf(subject.entity, member.relation, member.direction, 20);
  const parent = found.rows.map((row) => row.other).find((other) => member.parentKind === undefined || other.kind === member.parentKind);
  if (parent !== undefined) return parent;
  if (member.property === undefined) return undefined;
  const key = subject.entity.properties[member.property];
  if (typeof key !== 'string' || key === '') return undefined;
  return (await ctx.graph.find(key)).find((other) => member.parentKind === undefined || other.kind === member.parentKind);
}

/**
 * The members of an entity: its fields, its facets. The page draws them as one table: the member's
 * short name, the facts that differ between rows, and the entities that read or write it. Facts every
 * row shares are stated once, above the table, in the reader's language (madarch-m38l.21).
 */
export async function membersBlock(
  ctx: RenderContext,
  subject: Subject,
  params: Readonly<Record<string, string>>,
  file: string,
  line: number,
  lang: string,
): Promise<Block> {
  const title = params['title'] ?? 'Members';
  const kind = params['kind'];
  const relation = params['relation'];
  if (kind === undefined || kind === '' || relation === undefined || relation === '') return { type: 'problem', block: 'members', file, line, message: 'the members block names the kind and the relation of the members it lists: kind="code.field" relation="code.contains"' };
  if (subject.source !== 'graph') return { type: 'problem', block: 'members', file, line, message: 'the members block lists entities of the graph; this entity is not one' };
  const direction = params['direction'] === 'out' ? 'out' : 'in';
  const limit = toInt(params['limit'], 200, 1, 500);
  const found = await ctx.graph.neighbors(subject.entity, { relations: [relation], direction, limit });
  const declaration = ctx.manifest.kinds.get(kind);
  const details = declaration?.details;
  const kindLabel = declaration?.labels?.[lang]?.one ?? declaration?.labels?.['en']?.one;
  const kindProperty = ctx.manifest.properties.get('symbolKind');
  const kindLabelName = kindProperty?.labels[lang] ?? kindProperty?.labels['en'];
  const omit = new Set(list(params['omit']) ?? []);
  const rows: import('./model.js').MemberRow[] = [];
  let total = 0;
  for (const group of found) {
    for (const row of group.rows) {
      if (row.entity.kind !== kind) continue;
      total += 1;
      if (rows.length >= limit) continue;
      const [member] = await ctx.graph.find(row.entity.key);
      if (member === undefined) continue;
      const readers = list(params['readers']) ?? [];
      const writers = list(params['writers']) ?? [];
      const refs = async (relations: readonly string[]): Promise<EntityRef[]> => {
        const held: EntityRef[] = [];
        for (const other of relations) for (const edge of (await ctx.graph.edgesOf(member, other, 'in', 100)).rows) held.push(refOfGraph(ctx, edge.other));
        return held;
      };
      const declaredName = member.properties['name'];
      const name = typeof declaredName === 'string' && declaredName.trim() !== '' ? declaredName : member.label;
      const values = detailRows(member, details, ctx.manifest.properties, lang).filter((value) => !omit.has(value.name));
      rows.push({ entity: refOfGraph(ctx, member), name, anchor: memberAnchor(member.key), values, readers: await refs(readers), writers: await refs(writers) });
    }
  }
  return { type: 'members', title, ...(kindLabel === undefined ? {} : { kindLabel }), ...(kindLabelName === undefined ? {} : { kindLabelName }), rows, total };
}

// ---- children ---------------------------------------------------------------------------------

/**
 * The entities of a kind whose key starts with a prefix: the tables of a database, the columns of a table. The keys the
 * extractors give a child repeat its parent's, so the parent needs no edge for it.
 */
export async function childrenBlock(ctx: RenderContext, subject: Subject, params: Readonly<Record<string, string>>, file: string, line: number): Promise<Block> {
  const kind = params['kind'];
  const prefix = params['prefix'];
  if (kind === undefined || prefix === undefined || prefix === '') return { type: 'problem', block: 'children', file, line, message: 'the children block names the kind and the key prefix of the entities it lists: kind="code.column" prefix="..."' };
  if (subject.source !== 'graph') return { type: 'problem', block: 'children', file, line, message: 'the children block lists entities of the graph by their keys; this entity is not one' };
  const found = await ctx.graph.byPrefix(kind, prefix, toInt(params['limit'], 100, 1, 500));
  const title = params['title'] ?? 'Contains';
  if (found.total === 0) return { type: 'related', title, groups: [] };
  return { type: 'related', title, groups: [{ relation: params['relation'] ?? 'code.contains', direction: 'out', total: found.total, rows: found.rows.map((entity) => ({ entity: refOfGraph(ctx, entity), count: 1 })) }] };
}
