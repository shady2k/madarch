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
  attributeOf, bodyBlock, callBlock, erBlock, idOf, kindOf, refOfGraph, refOfMarkdown, relatedBlock, sourceBlock,
  type RenderContext, type Subject,
} from './blocks.js';
import { graphBlock, modulesBlock, sequenceBlock, systemBlock, treemapBlock } from './diagrams.js';
import type { GraphEntity } from './graph-read.js';
import { homeKind, type Finding } from './kinds.js';
import { readBody } from './markdown.js';
import type { Block, EntityListing, EntityRef, KindSummary, PageModel } from './model.js';
import type { Resolution } from './resolve.js';
import { parseTemplate, substitute } from './template.js';

export type PageResult = { ok: true; page: PageModel } | { ok: false; status: 404 | 500; message: string };

/** The entity at an id: a Markdown page by id, or a graph entity by key (the first scope when the key is in several). */
export async function findSubject(ctx: RenderContext, id: string): Promise<{ subject: Subject; others: number } | undefined> {
  const markdown = ctx.markdown.get(id);
  if (markdown !== undefined) return { subject: { source: 'markdown', entity: markdown }, others: 0 };
  const found = await ctx.graph.find(id);
  if (found.length === 0) return undefined;
  return { subject: { source: 'graph', entity: found[0]! }, others: found.length - 1 };
}

export async function renderPage(ctx: RenderContext, id: string): Promise<PageResult> {
  const located = await findSubject(ctx, id);
  if (located === undefined) return { ok: false, status: 404, message: `no entity "${id}" in the graph or among the product's Markdown pages` };
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
    if (declared !== undefined && !declared.has(name) && !['label', 'title', 'key', 'id', 'kind', 'slug'].includes(name)) return undefined;
    return attributeOf(subject, name);
  };
  for (const part of parseTemplate(templateText)) {
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
    const block = await renderBlock(ctx, subject, part.name, params, decl.template, part.line);
    if (block.type === 'problem') findings.push({ file: block.file, line: block.line, message: `:::${block.block}: ${block.message}` });
    blocks.push(block);
  }
  // Every `madarch:` link the page's text holds is resolved here, once, and shown as broken when it does not.
  const urls = new Set<string>();
  const bodyLinks: { url: string; line: number; ground: boolean }[] = [];
  for (const block of blocks) {
    if (block.type === 'markdown') for (const link of readBody(block.markdown, decl.template, 1).links) urls.add(link.url);
  }
  if (subject.source === 'markdown' && blocks.some((block) => block.type === 'body')) {
    const reading = readBody(subject.entity.body, subject.entity.file, subject.entity.bodyLine);
    findings.push(...reading.findings);
    for (const link of reading.links) {
      urls.add(link.url);
      bodyLinks.push(link);
    }
  }
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

async function renderBlock(ctx: RenderContext, subject: Subject, name: string, params: Readonly<Record<string, string>>, file: string, line: number): Promise<Block> {
  switch (name) {
    case 'body': return bodyBlock(subject, name, file, line);
    case 'graph': return await graphBlock(ctx, subject, params);
    case 'system': return await systemBlock(ctx, params);
    case 'modules': return await modulesBlock(ctx, subject, params, file, line);
    case 'treemap': return await treemapBlock(ctx, subject, params);
    case 'related': return await relatedBlock(ctx, subject, params, file, line);
    case 'callers': return await callBlock(ctx, subject, 'in', params, file, line);
    case 'callees': return await callBlock(ctx, subject, 'out', params, file, line);
    case 'source': return await sourceBlock(ctx, subject, params, file, line);
    case 'er': return await erBlock(ctx, subject, params, file, line);
    case 'sequence': return await sequenceBlock(ctx, subject, params, file, line);
    default: return { type: 'problem', block: name, file, line, message: `"${name}" is not a block of the library` };
  }
}

/** The way up: containers for a graph entity (nearest first, reversed to read from the top), the home page above a Markdown page. */
async function trailOf(ctx: RenderContext, subject: Subject): Promise<EntityRef[]> {
  if (subject.source === 'graph') {
    const up = await ctx.graph.containers(subject.entity, CONTAINS);
    return up.reverse().map((entity) => refOfGraph(ctx, entity));
  }
  const home = homeKind(ctx.manifest);
  const page = home === undefined ? undefined : [...ctx.markdown.values()].find((entity) => entity.kind === home.name && entity.id !== subject.entity.id);
  return page === undefined ? [] : [refOfMarkdown(ctx, page)];
}

// ---- listings ---------------------------------------------------------------------------------

export async function kindSummaries(ctx: RenderContext): Promise<KindSummary[]> {
  const counts = new Map((await ctx.graph.kindCounts()).map((entry) => [entry.kind, entry.count]));
  return [...ctx.manifest.kinds.values()].map((decl) => ({
    kind: decl.name,
    source: decl.source,
    single: decl.file !== undefined,
    ...(decl.labels === undefined ? {} : { labels: { ...decl.labels } }),
    count: decl.source === 'markdown' ? [...ctx.markdown.values()].filter((entity) => entity.kind === decl.name).length : counts.get(decl.name) ?? 0,
  }));
}

export async function listEntities(ctx: RenderContext, kind: string, options: { q?: string; after?: string; limit: number }): Promise<EntityListing | undefined> {
  const decl = ctx.manifest.kinds.get(kind);
  if (decl === undefined) return undefined;
  if (decl.source === 'markdown') {
    const text = options.q?.trim().toLowerCase() ?? '';
    const all = [...ctx.markdown.values()].filter((entity) => entity.kind === kind && (text === '' || entity.title.toLowerCase().includes(text) || entity.id.toLowerCase().includes(text))).sort((a, b) => byCodePoint(a.id, b.id));
    const from = options.after === undefined ? 0 : all.findIndex((entity) => byCodePoint(entity.id, options.after!) > 0);
    const rows = from < 0 ? [] : all.slice(from, from + options.limit);
    const last = rows[rows.length - 1];
    const more = from >= 0 && from + options.limit < all.length;
    return { kind, total: all.length, rows: rows.map((entity) => refOfMarkdown(ctx, entity)), next: more && last !== undefined ? last.id : null };
  }
  const found = await ctx.graph.list(kind, { ...(options.q === undefined ? {} : { q: options.q }), ...(options.after === undefined ? {} : { after: options.after }), limit: options.limit });
  return { kind, total: found.total, rows: found.rows.map((entity: GraphEntity) => refOfGraph(ctx, entity)), next: found.next };
}
