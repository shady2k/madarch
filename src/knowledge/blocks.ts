/**
 * The block library (decision 0029): `body`, `graph`, `related`, `callers`,
 * `callees`, `source`, `er` and `sequence`. The engine owns the blocks; a
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
import type { GraphEntity, GraphReader, SourceSpan } from './graph-read.js';
import type { KindsManifest } from './kinds.js';
import type { MarkdownEntity } from './markdown.js';
import { readBody } from './markdown.js';
import type { Block, CallRow, CodeLocation, EntityRef, RelatedGroup } from './model.js';
import { entityAddress, noEntityMessage, sourceAddress, type Resolver } from './resolve.js';

export type Subject = { source: 'graph'; entity: GraphEntity } | { source: 'markdown'; entity: MarkdownEntity };

export interface RenderContext {
  productFolder: string;
  manifest: KindsManifest;
  graph: GraphReader;
  markdown: ReadonlyMap<string, MarkdownEntity>;
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
export function locationOf(ctx: Pick<RenderContext, 'repoOfScope'>, scope: string, span: SourceSpan): CodeLocation {
  const repo = ctx.repoOfScope(scope) ?? null;
  return { repo, path: span.path, lineStart: span.lineStart, lineEnd: span.lineEnd, href: sourceAddress(repo, span.path, span.lineStart) };
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

export function refOfMarkdown(ctx: RenderContext, entity: MarkdownEntity): EntityRef {
  return { id: entity.id, kind: entity.kind, label: entity.title, href: ctx.manifest.kinds.has(entity.kind) ? entityAddress(entity.id) : null };
}

const toInt = (value: string | undefined, fallback: number, min: number, max: number): number => {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

const list = (value: string | undefined): string[] | undefined => (value === undefined ? undefined : value.split(',').map((entry) => entry.trim()).filter(Boolean));

/** Mermaid text of a label: no quote or line break can end the string. */
function mermaidLabel(text: string, max = 44): string {
  const flat = text.replace(/["`\n\r\\]/g, "'").replace(/[<>]/g, '');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

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
    if (name === 'kind') return entity.kind;
    const whole = entity.properties[name];
    if (whole !== undefined) return stringify(whole);
    return stringify(dig(entity.properties, name));
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

// ---- body -------------------------------------------------------------------------------------

export function bodyBlock(subject: Subject, block: string, file: string, line: number): Block {
  if (subject.source !== 'markdown') {
    return { type: 'problem', block, file, line, message: 'the body block shows the Markdown of a page; the entities of this kind come from the graph and have none' };
  }
  const reading = readBody(subject.entity.body, subject.entity.file, subject.entity.bodyLine);
  return { type: 'body', markdown: subject.entity.body, file: subject.entity.file, statements: reading.statements, ungrounded: reading.ungrounded };
}

// ---- related and graph ------------------------------------------------------------------------

/** Markdown pages that name the key in `relates`, and the pages a Markdown page relates to. */
export async function relatesGroups(ctx: RenderContext, subject: Subject): Promise<RelatedGroup[]> {
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

export async function graphBlock(ctx: RenderContext, subject: Subject, params: Readonly<Record<string, string>>): Promise<Block> {
  const depth = toInt(params['depth'], 1, 1, 2);
  const limit = toInt(params['limit'], 24, 1, 60);
  const relations = list(params['relation']);
  const title = params['title'] ?? 'Links';
  const labels: string[] = [];
  const ids = new Map<string, string>();
  const lines: string[] = ['flowchart LR'];
  const add = (key: string, label: string): string => {
    const held = ids.get(key);
    if (held !== undefined) return held;
    const id = `n${ids.size}`;
    ids.set(key, id);
    labels.push(`  ${id}["${mermaidLabel(label)}"]`);
    return id;
  };
  const centerKey = idOf(subject);
  const centerLabel = subject.source === 'graph' ? subject.entity.label : subject.entity.title;
  add(centerKey, centerLabel);
  const edges: string[] = [];
  let total = 0;
  const neighborsOf = async (current: Subject): Promise<{ key: string; label: string; relation: string; direction: 'out' | 'in' }[]> => {
    const found: { key: string; label: string; relation: string; direction: 'out' | 'in' }[] = [];
    if (current.source === 'graph') {
      for (const group of await declaredNeighbors(ctx, current)) {
        if (relations !== undefined && !relations.includes(group.relation)) continue;
        for (const row of group.rows) found.push({ key: row.entity.id, label: row.entity.label, relation: group.relation, direction: 'out' });
      }
      for (const group of await ctx.graph.neighbors(current.entity, { ...(relations === undefined ? {} : { relations }), direction: 'both', limit: limit + 1 })) {
        for (const row of group.rows) found.push({ key: row.entity.key, label: row.entity.label, relation: group.relation, direction: group.direction });
      }
    }
    if (relations === undefined || relations.includes('relates')) {
      for (const group of await relatesGroups(ctx, current)) {
        for (const row of group.rows) if (row.entity.broken === undefined) found.push({ key: row.entity.id, label: row.entity.label, relation: 'relates', direction: group.direction });
      }
    }
    return found;
  };
  let frontier: Subject[] = [subject];
  const expanded = new Set<string>([centerKey]);
  for (let hop = 0; hop < depth; hop += 1) {
    const next: Subject[] = [];
    for (const current of frontier) {
      const from = ids.get(idOf(current))!;
      const found = await neighborsOf(current);
      total += found.length;
      for (const neighbor of found) {
        if (ids.size >= limit + 1 && !ids.has(neighbor.key)) continue;
        const to = add(neighbor.key, neighbor.label);
        const word = mermaidLabel(relationWord(neighbor.relation), 24);
        const edge = neighbor.direction === 'out' ? `  ${from} -->|${word}| ${to}` : `  ${to} -->|${word}| ${from}`;
        if (!edges.includes(edge)) edges.push(edge);
        if (!expanded.has(neighbor.key) && hop + 1 < depth) {
          expanded.add(neighbor.key);
          const [again] = await ctx.graph.find(neighbor.key);
          if (again !== undefined) next.push({ source: 'graph', entity: again });
        }
      }
    }
    frontier = next;
  }
  if (edges.length === 0) return { type: 'graph', title, mermaid: '', shown: 0, total };
  lines.push(...labels, ...edges, `  style n0 stroke-width:2px`);
  return { type: 'graph', title, mermaid: lines.join('\n'), shown: ids.size - 1, total };
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
  if (text === undefined) return { type: 'problem', block: 'source', file, line, message: `the file ${span.path} is not readable in ${repo ?? 'the product repository'} at the commit the graph was filled from` };
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const end = Math.min(span.lineEnd, lines.length);
  const stop = Math.min(end, span.lineStart + SOURCE_BLOCK_LINES - 1);
  return {
    type: 'source',
    title: params['title'] ?? 'Source',
    location: { repo, path: span.path, lineStart: span.lineStart, lineEnd: end, href: sourceAddress(repo, span.path, span.lineStart) },
    language: languageOf(span.path),
    text: lines.slice(span.lineStart - 1, stop).join('\n'),
    truncated: stop < end,
  };
}

// ---- sequence ---------------------------------------------------------------------------------

export async function sequenceBlock(ctx: RenderContext, subject: Subject, params: Readonly<Record<string, string>>, file: string, line: number): Promise<Block> {
  if (subject.source !== 'graph') return { type: 'problem', block: 'sequence', file, line, message: 'the sequence block follows calls of the graph; the entities of this kind are Markdown pages' };
  const relation = params['relation'] ?? CALLS;
  const depth = toInt(params['depth'], 2, 1, 5);
  const limit = toInt(params['limit'], 16, 1, 60);
  const title = params['title'] ?? 'Call sequence';
  const participants = new Map<string, string>();
  const names: string[] = [];
  const participantOf = (entity: GraphEntity): string => {
    const path = typeof entity.properties['path'] === 'string' ? entity.properties['path'] : entity.span?.path ?? entity.key;
    const label = path.slice(path.lastIndexOf('/') + 1);
    const held = participants.get(path);
    if (held !== undefined) return held;
    const alias = `p${participants.size}`;
    participants.set(path, alias);
    names.push(`  participant ${alias} as ${mermaidLabel(label, 32)}`);
    return alias;
  };
  const messages: string[] = [];
  let total = 0;
  const seen = new Set<string>([subject.entity.key]);
  let frontier: GraphEntity[] = [subject.entity];
  participantOf(subject.entity);
  for (let hop = 0; hop < depth; hop += 1) {
    const next: GraphEntity[] = [];
    for (const caller of frontier) {
      const calls = await ctx.graph.edgesOf(caller, relation, 'out', 100);
      for (const call of calls.rows) {
        total += 1;
        if (messages.length >= limit) continue;
        messages.push(`  ${participantOf(caller)}->>${participantOf(call.other)}: ${mermaidLabel(call.other.label.replace(/^.*\./, ''), 36)}`);
        if (!seen.has(call.other.key)) {
          seen.add(call.other.key);
          next.push(call.other);
        }
      }
    }
    frontier = next;
  }
  if (messages.length === 0) return { type: 'sequence', title, mermaid: '', shown: 0, total: 0 };
  return { type: 'sequence', title, mermaid: ['sequenceDiagram', ...names, ...messages].join('\n'), shown: messages.length, total };
}

// ---- er ---------------------------------------------------------------------------------------

const ER_TYPE = (type: unknown): string => {
  const word = String(type ?? 'text').trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_(),-]/g, '');
  return word === '' ? 'text' : word;
};

export async function erBlock(ctx: RenderContext, subject: Subject, params: Readonly<Record<string, string>>, file: string, line: number): Promise<Block> {
  if (subject.source !== 'graph') return { type: 'problem', block: 'er', file, line, message: 'the er block draws tables of the graph; the entities of this kind are Markdown pages' };
  const entity = subject.entity;
  const title = params['title'] ?? 'Tables';
  const limit = toInt(params['limit'], 12, 1, 40);
  let tables: GraphEntity[];
  let total: number;
  if (entity.kind === 'code.database') {
    const found = await ctx.graph.byPrefix('code.table', `code.table:${entity.key.slice(entity.key.indexOf(':') + 1)}/`, limit);
    tables = found.rows;
    total = found.total;
  } else if (entity.kind === 'code.table') {
    tables = [entity];
    total = 1;
  } else {
    return { type: 'problem', block: 'er', file, line, message: `the er block draws a database or a table, and this is a ${entity.kind}` };
  }
  if (tables.length === 0) return { type: 'er', title, mermaid: '', tables: 0, shownTables: 0 };
  const out: string[] = ['erDiagram'];
  const nameOf = (table: GraphEntity): string => mermaidLabel(table.label, 40).replace(/\s/g, '_');
  const inDiagram = new Set(tables.map((table) => table.key));
  for (const table of tables) {
    const columns = await ctx.graph.byPrefix('code.column', `${table.key}/`, 40);
    out.push(`  "${nameOf(table)}" {`);
    for (const column of columns.rows) {
      const marks = [column.properties['primaryKey'] === true ? 'PK' : '', column.properties['unique'] === true ? 'UK' : ''].filter(Boolean).join(',');
      out.push(`    ${ER_TYPE(column.properties['type'])} ${mermaidLabel(column.label, 40).replace(/\s/g, '_')}${marks === '' ? '' : ` ${marks}`}`);
    }
    out.push('  }');
  }
  const edges = new Set<string>();
  for (const table of tables) {
    for (const group of await ctx.graph.neighbors(table, { relations: ['code.foreign-key'], direction: 'out', limit: 40 })) {
      for (const row of group.rows) {
        if (!inDiagram.has(row.entity.key)) continue;
        edges.add(`  "${nameOf(table)}" }o--|| "${nameOf(row.entity)}" : "foreign key"`);
      }
    }
  }
  out.push(...[...edges].sort(byCodePoint));
  return { type: 'er', title, mermaid: out.join('\n'), tables: total, shownTables: tables.length };
}
