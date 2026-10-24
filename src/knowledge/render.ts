/**
 * A page of the wiki (decision 0029): the entity is found, its kind's template
 * is read from the product repository, and the template's text and blocks are
 * rendered over the graph and the Markdown. Nothing here names a kind: the
 * kind's declaration and its template say what the page shows.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTAINS } from '../graph/vocabulary.js';
import { byCodePoint } from '../model/order.js';
import {
  attributeOf, bodyBlock, callBlock, childrenBlock, idOf, kindOf, propertiesBlock, refOfGraph, refOfMarkdown, relatedBlock, sourceBlock,
  type RenderContext, type Subject,
} from './blocks.js';
import { graphBlock, treemapBlock } from './diagrams.js';
import { diagramsBlock } from './views.js';
import { definitionBlock } from './definition.js';
import { historyBlock } from './history.js';
import type { GraphEntity } from './graph-read.js';
import { implementedByBlock, linkedFromBlock, statedBlock, termBlock } from './doc-blocks.js';
import { homeKind, type Finding, type Origin } from './kinds.js';
import { readBody } from './markdown.js';
import type { DocEntity } from './doc-entities.js';
import type { MarkdownEntity } from './markdown.js';
import type { Block, EntityListing, EntityRef, KindSummary, PageModel } from './model.js';
import { documentAddress, noEntityMessage, type Resolution } from './resolve.js';
import { parseTemplate, substitute } from './template.js';
import { termLinks } from './glossary.js';

export type PageResult = { ok: true; page: PageModel } | { ok: false; status: 404 | 500; message: string };

/** The entity at an id: a Markdown page by id, or a graph entity by key (the first scope when the key is in several). */
export async function findSubject(ctx: RenderContext, id: string): Promise<{ subject: Subject; others: number } | undefined> {
  const markdown = ctx.markdown.get(id);
  if (markdown !== undefined) return { subject: { source: 'markdown', entity: markdown }, others: 0 };
  const document = ctx.docEntities.get(id);
  if (document !== undefined) return { subject: { source: 'document', entity: document }, others: 0 };
  const found = await ctx.graph.find(id);
  if (found.length === 0) return undefined;
  return { subject: { source: 'graph', entity: found[0]! }, others: found.length - 1 };
}

/**
 * Renders the page of an entity. `lang` is the interface language the reader reads in: a block parameter
 * `title-<lang>` (for example `title-ru="Файлы"`) names the block in that language where the template gives one.
 */
/** The blocks that read the graph at length: drawn by a read of their own when the page is asked for with `defer`. */
const DEFERRED_BLOCKS: ReadonlySet<string> = new Set(['graph', 'sequence', 'system', 'modules', 'er', 'treemap', 'history', 'definition']);

export async function renderPage(ctx: RenderContext, id: string, lang?: string, options: { defer?: boolean; only?: number } = {}): Promise<PageResult> {
  const located = await findSubject(ctx, id);
  if (located === undefined) return { ok: false, status: 404, message: noEntityMessage(id, lang ?? ctx.language) };
  const { subject } = located;
  const decl = ctx.manifest.kinds.get(kindOf(subject));
  if (decl === undefined) {
    return { ok: false, status: 404, message: `"${id}" is an entity of kind ${kindOf(subject)}, and ${ctx.manifest.file} declares no page for it: a kind is shown when the manifest names it and its template` };
  }
  let templateText: string;
  try {
    templateText = readFileSync(join(ctx.productFolder, decl.template), 'utf8');
  } catch (error) {
    return { ok: false, status: 500, message: `the template ${decl.template} of kind ${decl.name} cannot be read: ${(error as Error).message}` };
  }
  const findings: Finding[] = [];
  const blocks: Block[] = [];
  const declared = decl.attributes === undefined ? undefined : new Set(decl.attributes);
  const value = (name: string): string | undefined => {
    if (declared !== undefined && !declared.has(name) && !['label', 'title', 'key', 'keyrest', 'id', 'kind', 'slug'].includes(name)) return undefined;
    return attributeOf(subject, name);
  };
  for (const part of parseTemplate(templateText)) {
    // One block of the template, asked for by its line (the page a deferred diagram reads itself from).
    if (options.only !== undefined && part.line !== options.only) continue;
    if (part.type === 'text') {
      const text = substitute(part.text, part.line, decl.template, value, findings);
      if (text.trim() !== '') blocks.push({ type: 'markdown', markdown: text });
      continue;
    }
    if (part.type === 'problem') {
      findings.push({ file: decl.template, line: part.line, message: part.message });
      blocks.push({ type: 'problem', block: ':::', message: part.message, file: decl.template, line: part.line });
      continue;
    }
    const params: Record<string, string> = {};
    for (const [name, raw] of Object.entries(part.params)) params[name] = substitute(raw, part.line, decl.template, value, findings, { escape: false });
    for (const name of Object.keys(params)) {
      if (!name.startsWith('title-')) continue;
      if (lang !== undefined && name === `title-${lang}`) params['title'] = params[name]!;
      delete params[name];
    }
    // The diagrams read the graph many times; a page that asks for them later answers at once and draws them when they come.
    if (options.defer === true && DEFERRED_BLOCKS.has(part.name)) {
      blocks.push({ type: 'deferred', block: part.name, title: params['title'] ?? '', line: part.line });
      continue;
    }
    const block = await renderBlock(ctx, subject, part.name, params, decl.template, part.line, lang);
    if (block.type === 'problem') findings.push({ file: block.file, line: block.line, message: `:::${block.block}: ${block.message}` });
    blocks.push({ ...block, name: part.name });
  }
  // Every `madarch:` link the page's text holds is resolved here, once, and shown as broken when it does not.
  const urls = new Set<string>();
  const bodyLinks: { url: string; line: number; ground: boolean }[] = [];
  for (const block of blocks) {
    if (block.type === 'markdown') for (const link of readBody(block.markdown, decl.template, 1).links) urls.add(link.url);
  }
  for (const block of blocks) if (block.type === 'term') for (const link of termLinks({ definition: block.definition, synonyms: block.synonyms, code: block.code, usedIn: block.usedIn, ambiguous: block.ambiguous })) urls.add(link);
  if (subject.source === 'markdown' && blocks.some((block) => block.type === 'body')) {
    const reading = readBody(subject.entity.body, subject.entity.file, subject.entity.bodyLine);
    findings.push(...reading.findings);
    for (const link of reading.links) {
      urls.add(link.url);
      bodyLinks.push(link);
    }
  }
  // A document entity's text may link to the graph too; its links are shown as they resolve (a link of a document is no finding of the product's pages).
  if (subject.source === 'document' && blocks.some((block) => block.type === 'body')) for (const link of readBody(subject.entity.text, subject.entity.path, subject.entity.line).links) urls.add(link.url);
  const resolutions: Record<string, Resolution> = {};
  for (const url of [...urls].sort(byCodePoint)) resolutions[url] = await ctx.resolver.resolve(url);
  if (subject.source === 'markdown') {
    for (const link of bodyLinks) {
      const resolution = resolutions[link.url];
      if (resolution?.state === 'broken') findings.push({ file: subject.entity.file, line: link.line, message: `${link.ground ? 'a ground' : 'a link'} does not resolve: ${resolution.reason}` });
    }
  }
  const notes: string[] = [];
  if (located.others > 0) notes.push(`The key ${id} is also in ${located.others} other repositor${located.others === 1 ? 'y' : 'ies'} of this product; this page shows the first.`);
  return {
    ok: true,
    page: {
      id: idOf(subject),
      kind: kindOf(subject),
      title: titleOf(subject, decl.title),
      trail: await trailOf(ctx, subject),
      blocks,
      resolutions,
      findings,
      notes,
    },
  };
}

function titleOf(subject: Subject, attribute: string): string {
  return attributeOf(subject, attribute) ?? (subject.source === 'graph' ? subject.entity.label : subject.entity.title);
}

/** The product's name for the context diagram: the title of its home page, else a plain word. */
export function productTitleOf(ctx: RenderContext): string {
  const home = homeKind(ctx.manifest);
  const page = home === undefined ? undefined : [...ctx.markdown.values()].find((entity) => entity.kind === home.name);
  return page?.title ?? 'Product';
}

async function renderBlock(ctx: RenderContext, subject: Subject, name: string, params: Readonly<Record<string, string>>, file: string, line: number, lang: string | undefined): Promise<Block> {
  switch (name) {
    case 'body': return bodyBlock(ctx, subject, name, file, line);
    case 'graph': return await graphBlock(ctx, subject, params);
    case 'treemap': return await treemapBlock(ctx, subject, params);
    case 'history': return await historyBlock(ctx, subject, params, file, line);
    case 'definition': return await definitionBlock(ctx, subject, params, file, line);
    case 'related': return await relatedBlock(ctx, subject, params, file, line);
    case 'callers': return await callBlock(ctx, subject, 'in', params, file, line);
    case 'callees': return await callBlock(ctx, subject, 'out', params, file, line);
    case 'source': return await sourceBlock(ctx, subject, params, file, line);
    case 'system':
    case 'modules':
    case 'er':
    case 'sequence': return await diagramsBlock({ ctx, lang, productTitle: productTitleOf(ctx) }, subject, name, params, { product: ctx.manifest.diagram, env: process.env }, { file, line });
    case 'children': return await childrenBlock(ctx, subject, params, file, line);
    case 'properties': return propertiesBlock(subject, params, file, line);
    case 'term': return termBlock(ctx, subject, params, file, line);
    case 'stated': return statedBlock(ctx, subject, params, file, line);
    case 'implementedby': return await implementedByBlock(ctx, subject, params, file, line);
    case 'linkedfrom': return await linkedFromBlock(ctx, subject, params, file, line);
    default: return { type: 'problem', block: name, file, line, message: `"${name}" is not a block of the library` };
  }
}

/** The way up: containers for a graph entity (nearest first, reversed to read from the top), the home page above a Markdown page. */
async function trailOf(ctx: RenderContext, subject: Subject): Promise<EntityRef[]> {
  if (subject.source === 'graph') {
    const up = await ctx.graph.containers(subject.entity, CONTAINS);
    return up.reverse().map((entity) => refOfGraph(ctx, entity));
  }
  if (subject.source === 'document') {
    const doc = subject.entity;
    return [{ id: `doc:${doc.repo === null ? '' : `@${doc.repo}/`}${doc.path}`, kind: 'document', label: doc.repo === null ? doc.path : `${doc.repo}: ${doc.path}`, href: documentAddress(doc.repo, doc.path) }];
  }
  const home = homeKind(ctx.manifest);
  const page = home === undefined ? undefined : [...ctx.markdown.values()].find((entity) => entity.kind === home.name && entity.id !== subject.entity.id);
  return page === undefined ? [] : [refOfMarkdown(ctx, page)];
}

// ---- listings ---------------------------------------------------------------------------------

/** The origins of a kind's entities: the manifest's word, else what the kind's source tells. */
function originsOf(ctx: RenderContext, decl: { name: string; source: 'graph' | 'markdown' | 'document'; origin?: Origin }): Origin[] {
  if (decl.origin !== undefined) return [decl.origin];
  if (decl.source === 'graph') return ['code'];
  if (decl.source === 'document') return ['person'];
  // A page the agent wrote says so in its front matter; a page with no producer was written by a person.
  const producers = new Set([...ctx.markdown.values()].filter((entity) => entity.kind === decl.name).map((entity) => (entity.producer === 'agent' ? 'agent' : 'person') as Origin));
  return [...producers].sort(byCodePoint);
}

export async function kindSummaries(ctx: RenderContext): Promise<KindSummary[]> {
  const counts = new Map((await ctx.graph.kindCounts()).map((entry) => [entry.kind, entry.count]));
  const statements = new Map((await ctx.index?.counts() ?? []).map((entry) => [entry.kind, entry.statements]));
  return [...ctx.manifest.kinds.values()].map((decl) => ({
    kind: decl.name,
    source: decl.source,
    single: decl.file !== undefined,
    ...(decl.group === undefined ? {} : { group: decl.group }),
    origins: originsOf(ctx, decl),
    ...(decl.descriptions === undefined ? {} : { descriptions: { ...decl.descriptions } }),
    ...(decl.labels === undefined ? {} : { labels: { ...decl.labels } }),
    ...(statements.has(decl.name) ? { statements: statements.get(decl.name)! } : {}),
    count: decl.source === 'markdown'
      ? [...ctx.markdown.values()].filter((entity) => entity.kind === decl.name).length
      : decl.source === 'document'
        ? [...ctx.docEntities.values()].filter((entity) => entity.kind === decl.name).length
        : counts.get(decl.name) ?? 0,
  }));
}

export async function listEntities(ctx: RenderContext, kind: string, options: { q?: string; after?: string; limit: number }): Promise<EntityListing | undefined> {
  const decl = ctx.manifest.kinds.get(kind);
  if (decl === undefined) return undefined;
  if (decl.source === 'markdown' || decl.source === 'document') {
    const text = options.q?.trim().toLowerCase() ?? '';
    const pool: (MarkdownEntity | DocEntity)[] = decl.source === 'markdown' ? [...ctx.markdown.values()] : [...ctx.docEntities.values()];
    const all = pool.filter((entity) => entity.kind === kind && (text === '' || entity.title.toLowerCase().includes(text) || entity.id.toLowerCase().includes(text))).sort((a, b) => byCodePoint(a.id, b.id));
    const from = options.after === undefined ? 0 : all.findIndex((entity) => byCodePoint(entity.id, options.after!) > 0);
    const rows = from < 0 ? [] : all.slice(from, from + options.limit);
    const last = rows[rows.length - 1];
    const more = from >= 0 && from + options.limit < all.length;
    return { kind, total: all.length, rows: rows.map((entity) => refOfMarkdown(ctx, entity)), next: more && last !== undefined ? last.id : null };
  }
  const found = await ctx.graph.list(kind, { ...(options.q === undefined ? {} : { q: options.q }), ...(options.after === undefined ? {} : { after: options.after }), limit: options.limit });
  return { kind, total: found.total, rows: found.rows.map((entity: GraphEntity) => refOfGraph(ctx, entity)), next: found.next };
}
