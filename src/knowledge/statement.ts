/**
 * The statement view (madarch-m38l.6): one sentence of a page the agent wrote,
 * the paragraph it stands in, and each of its grounds with an excerpt of what
 * it points at, the lines of code with the cited ones marked or the text of the
 * use case, rule or decision. The sentence is found by its text in the page's
 * body; a sentence the body does not hold is refused in words, never guessed.
 */
import { byCodePoint } from '../model/order.js';
import { graphDocument, documentSections } from './anchors.js';
import { propertiesBlock, refOfGraph, refOfMarkdown, relatedBlock, type RenderContext } from './blocks.js';
import type { GraphEntity } from './graph-read.js';
import { parseTarget } from './markdown.js';
import type { CodeLocation, Excerpt, GroundView, RelyingRef, StatementModel } from './model.js';
import { documentAddress, noEntityMessage, sourceAddress, type Resolution } from './resolve.js';

/** What a card of an entity shows of its neighbours: this many groups, this many rows in each. */
const CARD_GROUPS = 4;
const CARD_ROWS = 5;

/**
 * Whether a ground on an entity of this kind is a card of the entity (its name, kind, facts, what it is related to and
 * its page) rather than the lines it was read from. The product decides it: a kind whose declaration says `card: true`
 * gets the card, and every other kind — a function, a class, a file, a route — keeps the code excerpt. The engine names
 * no kind (decision 0033's owner rule: the engine holds no product data).
 */
function cardKind(ctx: RenderContext, kind: string): boolean {
  return ctx.manifest.kinds.get(kind)?.card === true;
}

async function entityCard(ctx: RenderContext, entity: GraphEntity): Promise<Excerpt> {
  const subject = { source: 'graph' as const, entity };
  const facts = propertiesBlock(subject, {}, '', 0, ctx.manifest.kinds.get(entity.kind)?.details, ctx.manifest.properties, ctx.language);
  const related = await relatedBlock(ctx, subject, { limit: String(CARD_ROWS) }, '', 0);
  const ref = refOfGraph(ctx, entity);
  return {
    type: 'entity',
    entity: ref,
    facts: facts.type === 'properties' ? facts.rows : [],
    related: related.type === 'related' ? related.groups.slice(0, CARD_GROUPS).map((group) => ({ ...group, rows: group.rows.slice(0, CARD_ROWS) })) : [],
  };
}

export type StatementResult = { ok: true; statement: StatementModel } | { ok: false; status: 404; message: string };

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

async function codeExcerpt(_ctx: RenderContext, entity: GraphEntity, location: CodeLocation): Promise<Excerpt | null> {
  const source = entity.properties['source'];
  if (source === undefined) return null;
  if (source === null || typeof source !== 'object' || Array.isArray(source)) throw new Error(`src/knowledge/statement.ts:1: ${entity.key}.source requires a structured source opinion`);
  const value = source as Record<string, unknown>;
  if (typeof value['text'] !== 'string' || typeof value['language'] !== 'string' || typeof value['truncated'] !== 'boolean') throw new Error(`src/knowledge/statement.ts:1: ${entity.key}.source requires text, language and truncated`);
  return { type: 'code', location, language: value['language'], firstLine: location.lineStart, text: value['text'], marked: { start: location.lineStart, end: location.lineEnd }, truncated: value['truncated'] };
}

async function groundOf(ctx: RenderContext, url: string): Promise<GroundView> {
  const resolution: Resolution = await ctx.resolver.resolve(url);
  if (resolution.state === 'broken') return { url, resolution, excerpt: null };
  if (resolution.entity !== undefined) {
    if (ctx.markdown.has(resolution.entity)) return { url, resolution, excerpt: null };
    const [entity] = await ctx.graph.find(resolution.entity);
    if (entity !== undefined && cardKind(ctx, entity.kind)) return { url, resolution, excerpt: await entityCard(ctx, entity) };
    if (entity !== undefined && resolution.location !== undefined) return { url, resolution, excerpt: await codeExcerpt(ctx, entity, resolution.location) };
    if (entity !== undefined && typeof entity.properties['path'] === 'string') {
      const repo = ctx.repoOfScope(entity.scope) ?? null;
      const web = ctx.webOf?.(repo, entity.properties['path'], 1, 1);
      const location: CodeLocation = { repo, path: entity.properties['path'], lineStart: 1, lineEnd: 1, href: sourceAddress(repo, entity.properties['path'], 1), ...(web === undefined ? {} : { web }) };
      return { url, resolution, excerpt: await codeExcerpt(ctx, entity, location) };
    }
    return { url, resolution, excerpt: null };
  }
  // A document excerpt is the producer's stated section and exact range.
  const target = parseTarget(url);
  if (target.kind === 'doc') {
    const qualifier = target.path.startsWith('@') ? target.path.indexOf('/') : -1;
    const path = qualifier > 1 ? target.path.slice(qualifier + 1) : target.path;
    const roots = qualifier > 1 ? [target.path.slice(1, qualifier)] : [null, ...ctx.repositories];
    for (const root of roots) {
      const document = await graphDocument(ctx.graph, root, path, [...ctx.manifest.kinds.values()].filter((kind) => kind.fields?.some((field) => field.name === 'markdown')).map((kind) => kind.name));
      if (document === undefined) continue;
      const section = documentSections(document).find((entry) => entry.anchor === (target.anchor ?? ''));
      if (section === undefined) continue;
      return { url, resolution, excerpt: { type: 'text', markdown: section.markdown, place: { repo: root, path, lineStart: section.start, lineEnd: section.end, href: documentAddress(root, path, target.anchor) } } };
    }
  }
  return { url, resolution, excerpt: null };
}

/** The statement of a page whose text is the sentence; the page is a Markdown entity of the product. */
export async function buildStatement(ctx: RenderContext, pageId: string, sentence: string, turn = 0): Promise<StatementResult> {
  const page = ctx.markdown.get(pageId);
  if (page === undefined) return { ok: false, status: 404, message: noEntityMessage(pageId) };
  const wanted = squash(sentence);
  if (wanted === '') return { ok: false, status: 404, message: 'the sentence is empty' };
  const reading = page.statementReading;
  const found = reading.statements.filter((statement) => squash(statement.text) === wanted)[turn];
  if (found === undefined) {
    return { ok: false, status: 404, message: `${page.file} holds no statement ${JSON.stringify(sentence.length > 120 ? `${sentence.slice(0, 119)}…` : sentence)}${turn > 0 ? ` at its turn ${turn}` : ''}: the page changed since it was drawn, or the text is not one sentence of its body` };
  }
  const first = found.notes[0];
  const sameFirst = first === undefined ? 0 : reading.statements.slice(0, reading.statements.indexOf(found)).filter((candidate) => candidate.notes[0] === first).length;
  const name = first === undefined ? null : sameFirst === 0 ? first : `${first}~${sameFirst + 1}`;
  const urls: string[] = [];
  for (const note of found.notes) for (const url of reading.definitions.get(note) ?? []) if (!urls.includes(url)) urls.push(url);
  const grounds = await Promise.all(urls.map((url) => groundOf(ctx, url)));
  const resolutions: Record<string, Resolution> = {};
  for (const link of page.reading.links) {
    if (!(link.url in resolutions)) resolutions[link.url] = await ctx.resolver.resolve(link.url);
  }
  // The other statements that rely on the same grounds, from the index of the Markdown.
  const relying: RelyingRef[] = [];
  if (ctx.index !== undefined) {
    const seen = new Set<string>();
    for (const ground of grounds) {
      if (ground.resolution.state !== 'ok' || ground.resolution.entity === undefined) continue;
      const entity = ground.resolution.entity;
      // The index names a document section by the ground's path and the ANCHOR the ground writes — not by the page's
      // durable identity, which no anchor spells (madarch-ztyq.3, the review of A).
      const named = parseTarget(ground.url);
      const key = named.kind === 'doc' && named.anchor !== null
        ? `doc:${named.path.startsWith('@') && named.path.includes('/') ? named.path.slice(named.path.indexOf('/') + 1) : named.path}#${named.anchor.toLowerCase()}`
        : entity;
      for (const other of await ctx.index.relyingOn(key)) {
        const id = `${other.page}\0${other.line}\0${other.statement}`;
        if (seen.has(id) || (other.page === pageId && other.line === found.line && squash(other.text) === wanted)) continue;
        seen.add(id);
        // The index keeps the sentence without its markup; the statement is found again on its page by line and letters.
        const there = ctx.markdown.get(other.page);
        const letters = (text: string): string => text.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
        let sentence: string | undefined;
        let turn = 0;
        if (there !== undefined) {
          const all = there.statementReading.statements;
          const at = all.findIndex((candidate) => candidate.line === other.line && letters(candidate.text) === letters(other.text));
          if (at >= 0) {
            sentence = all[at]!.text;
            turn = all.slice(0, at).filter((candidate) => squash(candidate.text) === squash(sentence!)).length;
          }
        }
        relying.push({ page: other.page, pageTitle: other.pageTitle, text: other.text, line: other.line, file: other.file, how: other.how, ground: ground.resolution.label, ...(sentence === undefined ? {} : { sentence, turn }) });
      }
    }
  }
  return {
    ok: true,
    statement: {
      relying: relying.slice(0, 20),
      page: refOfMarkdown(ctx, page),
      name,
      sentence: found.text,
      paragraph: found.paragraph,
      file: page.file,
      line: found.line,
      grounded: found.notes.length > 0,
      grounds,
      resolutions: Object.fromEntries(Object.entries(resolutions).sort(([a], [b]) => byCodePoint(a, b))),
    },
  };
}
