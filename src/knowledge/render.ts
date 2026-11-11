import { operationMetadata } from './operation-catalogue.js';
import { contentLanguage } from './plural.js';
/**
 * A page of the wiki (decision 0029): the entity is found, its kind's template
 * is read from the product repository, and the template's text and blocks are
 * rendered over the graph and the Markdown. Nothing here names a kind: the
 * kind's declaration and its template say what the page shows.
 */
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { CONTAINS } from '../graph/vocabulary.js';
import { byCodePoint } from '../model/order.js';
import {
  attributeOf, bodyBlock, callBlock, childrenBlock, fileBlock, folderBlock, idOf, kindOf, memberAnchor, memberParent, membersBlock, pageAttributes, propertiesBlock, refOfGraph, refOfMarkdown, relatedBlock, repositoryBlock, sourceBlock, termBlock,
  type RenderContext, type Subject,
} from './blocks.js';
import { filesBlock, graphBlock, treemapBlock } from './diagrams.js';
import { diagramsBlock, relationsBlock } from './views.js';
import { definitionBlock } from './definition.js';
import { historyBlock } from './history.js';
import { withSpan } from '../obs/trace.js';
import type { GraphEntity } from './graph-read.js';
import { linkedFromBlock } from './linked-from.js';
import { overviewAbout, overviewData, overviewHow, overviewReading, overviewStatus, overviewTerms } from './overview.js';
import { filePageBlock } from './file-page.js';
import { homeKind, listingFormOf, type Finding, type KindDecl, type Origin } from './kinds.js';
import { readBody } from './markdown.js';
import type { MarkdownEntity } from './markdown.js';
import type { Block, EntityListing, EntityRef, KindSummary, PageModel } from './model.js';
import { entityAddress, noEntityMessage, sourceAddress, type Resolution } from './resolve.js';
import { HOME_ADDRESS } from './addresses.js';
import { renderLiquidPage } from './liquid.js';
import { blockIdentity, foldLanguageParams, parseTemplate, substitute } from './template.js';
import { kindNumbers } from './kind-numbers.js';

export type PageResult = { ok: true; page: PageModel } | { ok: false; status: 404 | 500; message: string };

/** The entity at an id: a Markdown page by id, or a graph entity by key (the first scope when the key is in several). */
export async function findSubject(ctx: RenderContext, id: string): Promise<{ subject: Subject; others: number } | undefined> {
  const markdown = ctx.markdown.get(id);
  if (markdown !== undefined) return { subject: { source: 'markdown', entity: markdown }, others: 0 };
  const found = await ctx.graph.find(id);
  if (found.length === 0) return undefined;
  return { subject: { source: 'graph', entity: found[0]! }, others: found.length - 1 };
}

/**
 * Renders the page of an entity. `lang` is the interface language the reader reads in: a block parameter
 * `title-<lang>` (for example `title-ru="Файлы"`) names the block in that language where the template gives one.
 */
/** The blocks that read the graph at length: drawn by a read of their own when the page is asked for with `defer`. */
const DEFERRED_BLOCKS: ReadonlySet<string> = new Set(['graph', 'sequence', 'system', 'modules', 'er', 'treemap', 'files', 'history', 'definition', 'overview-how', 'overview-data']);

export async function renderPage(ctx: RenderContext, id: string, lang?: string, options: { defer?: boolean; only?: string } = {}): Promise<PageResult> {
  const located = await findSubject(ctx, id);
  if (located === undefined) return { ok: false, status: 404, message: noEntityMessage(id, lang ?? ctx.language) };
  const { subject } = located;
  const decl = ctx.manifest.kinds.get(kindOf(subject));
  if (decl === undefined) {
    return { ok: false, status: 404, message: `"${id}" is an entity of kind ${kindOf(subject)}, and ${ctx.manifest.file} declares no page for it: a kind is shown when the manifest names it and its template` };
  }
  // A member kind has no page of its own: an old address opens the parent's page at the member's fragment (madarch-m38l.21).
  if (decl.member !== undefined) {
    const parent = await memberParent(ctx, subject, decl.member);
    if (parent === undefined) {
      // The page a member belongs on is its parent's, and there is none: drawing the member alone would show a table of
      // one row that no page admits to holding, so the address answers with what the manifest declares and what is missing.
      const holds = decl.member.parentKind === undefined ? 'nothing holds it' : `no ${decl.member.parentKind} holds it`;
      return {
        ok: false,
        status: 404,
        message: `"${id}" is an entity of kind ${decl.name}, which ${ctx.manifest.file}:${decl.line} declares a member by ${decl.member.relation} (${decl.member.direction}), and ${holds}: there is no page to show it on`,
      };
    }
    const parentPage = await renderPage(ctx, parent.key, lang, options);
    if (parentPage.ok) return { ok: true, page: { ...parentPage.page, redirect: { id: parent.key, anchor: memberAnchor(idOf(subject)) } } };
    return parentPage;
  }
  const findings: Finding[] = [];
  let blocks: Block[] = [];
  const value = (name: string): string | undefined => allowedAttribute(decl, name) ? attributeOf(subject, name) : undefined;
  // A kind's template is Liquid (decision 0032) or, for a product made before it, the Markdown template of 0029: both
  // answer blocks in the template's order, and both read a block where the graph is.
  if (decl.template.endsWith('.liquid')) {
    const outcome = await renderLiquidPage({
      productFolder: ctx.productFolder,
      files: ctx.files,
      template: decl.template,
      data: { ...pageAttributes(subject, decl.attributes), lang: lang ?? ctx.language },
      ...(lang === undefined ? {} : { lang }),
      defer: options.defer === true,
      deferred: [...DEFERRED_BLOCKS],
      ...(options.only === undefined ? {} : { only: options.only }),
      render: (name, params, file, line) => renderBlock(ctx, subject, name, params, file === '' ? decl.template : file, line, lang, decl.details),
    });
    findings.push(...outcome.findings);
    for (const block of outcome.blocks) {
      if (block.type === 'problem') findings.push({ file: block.file, line: block.line, message: `${block.block}: ${block.message}` });
      blocks.push(block);
    }
    if (outcome.refused !== undefined && outcome.blocks.length === 0) return { ok: false, status: 500, message: outcome.refused };
  } else {
    // The template is the product repository's file as the graph holds it: a reader of a page never opens the checkout.
    const templateText = ctx.files.text(decl.template);
    if (templateText === undefined) {
      return { ok: false, status: 500, message: `the template ${decl.template} of kind ${decl.name} cannot be read: the graph holds no text of it (src/knowledge/render.ts)` };
    }
    for (const part of parseTemplate(templateText)) {
      // One block asked for by its identity is the whole page a deferred diagram reads: its text is not part of the answer.
      if (options.only !== undefined && part.type !== 'block') continue;
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
      const params = legacyParams(part.params, part.line, decl.template, value, findings, lang);
      // One block of the template, asked for by its identity (the page a deferred diagram reads itself from).
      if (options.only !== undefined && blockIdentity(part.name, params) !== options.only) continue;
      // The diagrams read the graph many times; a page that asks for them later answers at once and draws them when they come.
      if (options.defer === true && DEFERRED_BLOCKS.has(part.name)) {
        blocks.push({ type: 'deferred', block: part.name, title: params['title'] ?? '', id: blockIdentity(part.name, params) });
        continue;
      }
      const block = await renderBlock(ctx, subject, part.name, params, decl.template, part.line, lang, decl.details);
      if (block.type === 'problem') findings.push({ file: block.file, line: block.line, message: `:::${block.block}: ${block.message}` });
      blocks.push({ ...block, name: part.name });
    }
  }

  // A section with nothing in it is not a section a reader meets: it is left out of the page, unless what it looked
  // for is itself worth saying, and then it carries one sentence in the reader's language (madarch-m38l.21).
  const onlyBlock = options.only === undefined ? undefined : blocks[0];
  for (const block of blocks) {
    if ((block.type === 'callers' || block.type === 'callees') && block.rows.length === 0) {
      block.emptyNote ??= lang === 'ru' ? 'В графе не записано ни одного вызова.' : 'No calls are recorded in the graph.';
    }
    // A group, a list or a view with no row is not drawn inside a section that has others.
    if (block.type === 'related') block.groups = block.groups.filter((group) => group.rows.length > 0);
    if (block.type === 'history') block.sections = block.sections.filter((section) => section.rows.length > 0);
    if (block.type === 'diagrams') block.views = block.views.filter((view) => view.elements.length > 0 || view.mermaidSource !== '');
  }
  blocks = blocks.filter(isDrawn);
  // A deferred block the reader asked for by its identity already existed on the page: an empty one answers as an
  // empty diagram so the placeholder leaves the page, while an identity the template does not hold stays a 404.
  if (options.only !== undefined && blocks.length === 0 && onlyBlock?.type === 'diagrams') blocks = [onlyBlock];
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
      language: contentLanguage(lang ?? ctx.language),
      title: titleOf(subject, decl.title),
      trail: await trailOf(ctx, subject),
      blocks,
      resolutions,
      findings,
      notes,
    },
  };
}

/** Whether a block draws anything a reader can use. An informative absence is drawn by `emptyNote` on the block. */
function isDrawn(block: Block): boolean {
  switch (block.type) {
    case 'related': return block.groups.length > 0 && block.groups.some((group) => group.rows.length > 0);
    case 'callers':
    case 'callees': return block.rows.length > 0 || (block.emptyNote !== undefined && block.emptyNote.trim() !== '');
    case 'refs': return (block.hideEmpty !== true || block.total > 0) && (block.rows.length > 0 || (block.emptyNote !== undefined && block.emptyNote.trim() !== ''));
    case 'properties': return block.rows.length > 0;
    case 'repository': return block.data.steps.tree;
    case 'folder': return block.data.files.length > 0 || block.data.folders.length > 0;
    case 'file': return true;
    case 'members': return block.rows.length > 0;
    case 'graph': return block.neighborhood.nodes.length > 1 || block.neighborhood.edges.length > 0 || block.neighborhood.more.length > 0;
    case 'treemap': return true;
    case 'files': return true;
    case 'history': return block.sections.some((section) => section.rows.length > 0);
    case 'definition': return block.members.length > 0 || block.spec.text.trim() !== '' || block.document !== undefined || (block.descriptions ?? []).length > 0;
    case 'source': return block.text.trim() !== '';
    case 'markdown': return block.markdown.trim() !== '';
    case 'diagrams': return block.views.some((view) => view.elements.length > 0 || view.mermaidSource !== '');
    default: return true;
  }
}

function titleOf(subject: Subject, attribute: string): string {
  if (subject.source === 'graph') return graphTitleOf(attribute, subject.entity);
  return markdownTitleOf(attribute, subject.entity);
}

/**
 * A graph entity's title, resolved as its page resolves it: the manifest's `title` attribute when the entity has it,
 * else the entity's label. The changed-page list names a page by the same title the page shows.
 */
export function graphTitleOf(attribute: string, entity: Pick<GraphEntity, 'key' | 'kind' | 'label' | 'properties'>): string {
  return attributeOf({ source: 'graph', entity: { ...entity, nodeIds: [], scope: '' } }, attribute) ?? entity.label;
}

/** A Markdown entity's title, resolved as its page resolves it from the manifest's `title` attribute. */
export function markdownTitleOf(attribute: string, entity: MarkdownEntity): string {
  return attributeOf({ source: 'markdown', entity }, attribute) ?? entity.title;
}

/** The product's name for the context diagram: the title of its home page, else a plain word. */
export function productTitleOf(ctx: RenderContext): string {
  const home = homeKind(ctx.manifest);
  const page = home === undefined ? undefined : [...ctx.markdown.values()].find((entity) => entity.kind === home.name);
  return page?.title ?? 'Product';
}

/** The attributes a page may read whatever its kind says: what names a page in the navigation and the address of an entity. */
const RESERVED_ATTRIBUTES: readonly string[] = ['label', 'title', 'key', 'keyrest', 'id', 'kind', 'slug'];

/** Whether a template may read this attribute: a kind that names its attributes reads those, and the reserved ones. */
function allowedAttribute(decl: KindDecl, name: string): boolean {
  return decl.attributes === undefined || decl.attributes.includes(name) || RESERVED_ATTRIBUTES.includes(name);
}

/** The parameters of a block of a Markdown template (0029): `{{attribute}}` substituted, and every `<name>-<lang>` folded into `<name>`. */
function legacyParams(
  raw: Readonly<Record<string, string>>,
  line: number,
  file: string,
  value: (name: string) => string | undefined,
  findings: Finding[],
  lang?: string,
): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [name, text] of Object.entries(raw)) params[name] = substitute(text, line, file, value, findings, { escape: false });
  return foldLanguageParams(params, lang);
}

async function renderBlock(ctx: RenderContext, subject: Subject, name: string, params: Readonly<Record<string, string>>, file: string, line: number, lang: string | undefined, details: readonly string[] | undefined): Promise<Block> {
  return await withSpan(`wiki.block.${name}`, { 'wiki.block': name }, async () => await renderBlockOf(ctx, subject, name, params, file, line, lang, details));
}

async function renderBlockOf(ctx: RenderContext, subject: Subject, name: string, params: Readonly<Record<string, string>>, file: string, line: number, lang: string | undefined, details: readonly string[] | undefined): Promise<Block> {
  switch (name) {
    case 'body': return bodyBlock(ctx, subject, name, file, line);
    case 'graph': return await graphBlock(ctx, subject, params);
    case 'treemap': return await treemapBlock(ctx, subject, params, file, line, lang ?? ctx.language);
    case 'files': return await filesBlock(ctx, subject, params, file, line, lang ?? ctx.language);
    case 'history': return await historyBlock(ctx, subject, params, file, line, lang);
    case 'definition': return await definitionBlock(ctx, subject, params, file, line);
    case 'related': return await relatedBlock(ctx, subject, params, file, line);
    case 'callers': return await callBlock(ctx, subject, 'in', params, file, line);
    case 'callees': return await callBlock(ctx, subject, 'out', params, file, line);
    case 'source': return await sourceBlock(ctx, subject, params, file, line);
    case 'system':
    case 'modules':
    case 'er':
    case 'sequence': return await diagramsBlock({ ctx, lang, productTitle: productTitleOf(ctx) }, subject, name, params, { product: ctx.manifest.diagram, env: process.env }, { file, line });
    case 'relations': return await relationsBlock({ ctx, lang, productTitle: productTitleOf(ctx) }, subject, params, { product: ctx.manifest.diagram, env: process.env }, { file, line });
    case 'children': return await childrenBlock(ctx, subject, params, file, line);
    case 'repository': return await repositoryBlock(ctx, subject, params, file, line);
    case 'folder': return await folderBlock(ctx, subject, params, file, line);
    case 'file': return await fileBlock(ctx, subject, params, file, line);
    case 'properties': return propertiesBlock(subject, params, file, line, details, ctx.manifest.properties, lang ?? ctx.language);
    case 'term': return termBlock(ctx, subject, { ...params, lang: lang ?? ctx.language }, file, line);
    case 'members': return await membersBlock(ctx, subject, params, file, line, lang ?? ctx.language);
    case 'linkedfrom': return await linkedFromBlock(ctx, subject, params);
    case 'overview-about': return await overviewAbout(ctx, subject, params, lang);
    case 'overview-how': return await overviewHow(ctx, subject, params, file, line, lang);
    case 'overview-data': return await overviewData(ctx, params, file, line, lang);
    case 'overview-terms': return await overviewTerms(ctx, params, lang);
    case 'overview-status': return await overviewStatus(ctx, params, lang);
    case 'overview-reading': return overviewReading(ctx, params, lang);
    case 'file-page': return await filePageBlock(ctx, subject, file, line);
    default: return { type: 'problem', block: name, file, line, message: `"${name}" is not a block of the library` };
  }
}

/** The way up: containers for a graph entity (nearest first, reversed to read from the top), the home page above a Markdown page. */
async function trailOf(ctx: RenderContext, subject: Subject): Promise<EntityRef[]> {
  const parts: EntityRef[] = [];
  const push = (ref: EntityRef): void => {
    // The root folder's bare '/' is not a step: the repository below names the same place. No id is listed twice.
    if (ref.label.trim() === '/' || parts.some((held) => held.id === ref.id)) return;
    parts.push(ref);
  };
  const home = homeKind(ctx.manifest);
  const homePage = home === undefined ? undefined : [...ctx.markdown.values()].find((entity) => entity.kind === home.name);
  // The first step is the product's home, linked at the root address; a product with no name falls back to its home page.
  if (ctx.productName !== undefined && ctx.productName !== '') push({ id: 'home', kind: 'product', label: ctx.productName, href: HOME_ADDRESS });
  else if (homePage !== undefined) push(refOfMarkdown(ctx, homePage));
  if (subject.source === 'markdown') {
    if (homePage === undefined || subject.entity.id !== homePage.id) push(refOfMarkdown(ctx, subject.entity));
    return parts;
  }
  const entity = subject.entity;
  const repository = typeof entity.properties['repository'] === 'string'
    ? entity.properties['repository']
    : entity.kind === 'code.repository' && typeof entity.properties['name'] === 'string' ? entity.properties['name'] : '';
  if (entity.kind !== 'code.repository' && repository !== '') {
    const [repo] = await ctx.graph.find(`code.repository:${repository}`);
    if (repo !== undefined) push(refOfGraph(ctx, repo));
  }
  for (const held of (await ctx.graph.containers(entity, CONTAINS)).reverse()) {
    if (held.kind === 'code.repository') continue;
    push(refOfGraph(ctx, held));
  }
  push(refOfGraph(ctx, entity));
  return parts;
}


/**
 * The page of one file the graph holds (madarch-hsqs stage A): the facts its file block reads from the graph — the
 * properties the manifest's `details:` names for the kind, in the manifest's words for this language — the file's
 * block, its text and its history. The graph is the one source; there is no repository page model beside it.
 */
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
  const numbers = await kindNumbers(ctx);
  return [...ctx.manifest.kinds.values()].filter((decl) => decl.member === undefined).map((decl) => ({
    kind: decl.name,
    source: decl.source,
    single: decl.file !== undefined,
    // The listing and the navigation the manifest gives the kind travel to the app, which holds no kind of its own: an
    // app screen asks the kind summary which table the kind's page draws and where the kind stands in the navigation.
    ...(decl.listing === undefined ? {} : { listing: decl.listing }),
    ...(decl.nav === undefined ? {} : { nav: decl.nav }),
    ...(decl.group === undefined ? {} : { group: decl.group }),
    origins: originsOf(ctx, decl),
    ...(decl.descriptions === undefined ? {} : { descriptions: { ...decl.descriptions } }),
    ...(decl.labels === undefined ? {} : { labels: { ...decl.labels } }),
    ...(numbers.statements.has(decl.name) ? { statements: numbers.statements.get(decl.name)! } : {}),
    count: numbers.count(decl.name, decl.source),
  }));
}

/** A node of the Markdown tree, as the excerpt's reading walks it. */
interface ReaderNode {
  type?: string;
  value?: string;
  alt?: string;
  children?: ReaderNode[];
}

const EXCERPT_PARSER = unified().use(remarkParse).use(remarkGfm);

/**
 * The words a reader reads from a Markdown node: block by block, each leaf's text, and the marks gone — a footnote
 * reference, a link's address, emphasis and code delimiters, an HTML comment. Nothing is stripped from the source as
 * text; the parser says what the document's words are and this walk keeps them.
 */
function readerWords(node: ReaderNode, out: string[]): void {
  const type = node.type ?? '';
  if (type === 'html' || type === 'footnoteReference' || type === 'footnoteDefinition' || type === 'definition') return;
  if (type === 'text' || type === 'inlineCode' || type === 'code') {
    if (node.value !== undefined && node.value !== '') out.push(node.value);
    return;
  }
  if (type === 'image') {
    if (node.alt !== undefined && node.alt !== '') out.push(node.alt);
    return;
  }
  if (type === 'break' || type === 'thematicBreak') {
    out.push(' ');
    return;
  }
  const block = type === 'paragraph' || type === 'heading' || type === 'listItem' || type === 'tableCell' || type === 'tableRow';
  if (block) out.push(' ');
  for (const child of node.children ?? []) readerWords(child, out);
  if (block) out.push(' ');
}

/** The words on one line, with single spaces, no leading or trailing space. */
function oneLine(parts: readonly string[]): string {
  let text = '';
  let gap = false;
  for (const part of parts) {
    for (const char of part) {
      if (char === ' ' || char === '\n' || char === '\r' || char === '\t') {
        gap = text !== '';
        continue;
      }
      if (gap) {
        text += ' ';
        gap = false;
      }
      text += char;
    }
  }
  return text;
}

/** The text around the first match of `needle` a reader reads, on one line, cut at word boundaries with ellipses. */
function excerptOf(body: string, needle: string, language: string, width = 90): string | undefined {
  if (needle === '') return undefined;
  const parts: string[] = [];
  readerWords(EXCERPT_PARSER.parse(body) as unknown as ReaderNode, parts);
  const flat = oneLine(parts);
  const at = flat.toLocaleLowerCase(language).indexOf(needle);
  if (at < 0) return undefined;
  let start = Math.max(0, at - width);
  if (start > 0) {
    const space = flat.indexOf(' ', start);
    if (space >= 0 && space < at) start = space + 1;
  }
  let end = Math.min(flat.length, at + needle.length + width);
  if (end < flat.length) {
    const space = flat.lastIndexOf(' ', end);
    if (space > at + needle.length) end = space;
  }
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/**
 * The wiki's search: the Markdown pages whose title or body holds the text, and the graph's entities of the declared
 * kinds whose label or presented key holds it, grouped by kind. The text is matched in the wiki's language, with that
 * language's own lowercasing, and a page's body gives the excerpt a reader sees. No separate index is kept: both are
 * the reads the wiki already makes, over the store it already reads.
 */
export async function searchWiki(ctx: RenderContext, query: string, lang?: string, options: { perKind: number; limit: number } = { perKind: 5, limit: 40 }): Promise<{ groups: { kind: string; total: number; rows: { id: string; kind: string; title: string; href: string; excerpt?: string }[] }[]; total: number }> {
  const language = lang ?? ctx.language;
  const needle = query.trim().toLocaleLowerCase(language);
  if (needle === '') return { groups: [], total: 0 };
  const groups = new Map<string, { kind: string; total: number; rows: { id: string; kind: string; title: string; href: string; excerpt?: string }[] }>();
  const groupOf = (kind: string) => groups.get(kind) ?? { kind, total: 0, rows: [] };
  const markdown = [...ctx.markdown.values()]
    .filter((entity) => entity.title.toLocaleLowerCase(language).includes(needle) || entity.body.toLocaleLowerCase(language).includes(needle))
    .sort((a, b) => byCodePoint(a.title, b.title) || byCodePoint(a.id, b.id));
  for (const entity of markdown) {
    const group = groupOf(entity.kind);
    group.total += 1;
    if (group.rows.length < options.perKind) {
      const excerpt = excerptOf(entity.body, needle, language);
      group.rows.push({ id: entity.id, kind: entity.kind, title: entity.title, href: entityAddress(entity.id), ...(excerpt === undefined ? {} : { excerpt }) });
    }
    groups.set(entity.kind, group);
  }
  const graphKinds = [...ctx.manifest.kinds.values()].filter((decl) => decl.source === 'graph' && decl.member === undefined).map((decl) => decl.name);
  // A store that holds no graph yet answers no graph row; the Markdown pages are still found, and the search never
  // fails because a fill has not run.
  let graphFound: Awaited<ReturnType<RenderContext['graph']['search']>> = [];
  try {
    graphFound = await ctx.graph.search(graphKinds, needle, options);
  } catch {
    graphFound = [];
  }
  for (const found of graphFound) {
    const group = groupOf(found.kind);
    group.total += found.total;
    for (const entity of found.entities) {
      if (group.rows.length >= options.perKind) break;
      group.rows.push({ id: entity.key, kind: entity.kind, title: entity.label, href: entityAddress(entity.key) });
    }
    groups.set(found.kind, group);
  }
  const ordered = [...groups.values()].sort((a, b) => byCodePoint(a.kind, b.kind));
  return { groups: ordered, total: ordered.reduce((sum, group) => sum + group.total, 0) };
}

export async function listEntities(ctx: RenderContext, kind: string, options: { q?: string; after?: string; limit: number }): Promise<EntityListing | undefined> {
  const decl = ctx.manifest.kinds.get(kind);
  if (decl === undefined || decl.member !== undefined) return undefined;
  // The graph is the one source of a file listing too: its `code.file` entities carry their repository in the key, so
  // two repositories' paths never collide, and each row links to the entity page the graph names.
  if (kind === 'code.file') {
    const filter = options.q?.trim() ?? '';
    const head = filter === '' ? 'code.file:' : `code.file:${filter}`;
    const page = await ctx.graph.byPrefix('code.file', head, options.limit + 1, options.after);
    const rows = page.rows.slice(0, options.limit);
    return {
      kind, total: page.total,
      next: page.rows.length > options.limit ? rows[rows.length - 1]?.key ?? null : null,
      rows: rows.map((entity) => {
        const repository = String(entity.properties['repository'] ?? '');
        const path = String(entity.properties['path'] ?? '');
        const web = ctx.webOf?.(repository, path, 1, 1);
        return {
          id: entity.key, kind, label: entity.label,
          href: entityAddress(entity.key),
          location: { repo: repository, path, lineStart: 1, lineEnd: 1, href: sourceAddress(repository, path, 1), ...(web === undefined ? {} : { web }) },
        };
      }),
    };
  }
  if (decl.source === 'markdown') {
    const text = options.q?.trim().toLowerCase() ?? '';
    const all = [...ctx.markdown.values()].filter((entity) => entity.kind === kind && (text === '' || entity.title.toLowerCase().includes(text) || entity.id.toLowerCase().includes(text))).sort((a, b) => byCodePoint(a.id, b.id));
    const from = options.after === undefined ? 0 : all.findIndex((entity) => byCodePoint(entity.id, options.after!) > 0);
    const rows = from < 0 ? [] : all.slice(from, from + options.limit);
    const last = rows[rows.length - 1];
    const more = from >= 0 && from + options.limit < all.length;
    return { kind, total: all.length, rows: rows.map((entity) => refOfMarkdown(ctx, entity)), next: more && last !== undefined ? last.id : null };
  }
  // A document kind's entities are the graph's: the fill's plugins read the documents and publish what they state,
  // and the list reads only the graph (a kind no plugin fills has no table, and its list is empty).
  // The form of the listing is the kind's own (decision 0033: `listing:` of its declaration): the operations table asks
  // the graph for the operations and the channels its contracts declare, and reads what declares, serves and calls each.
  const operationsListed = listingFormOf(ctx.manifest, kind) === 'operations';
  const found = await (operationsListed ? ctx.graph.listOperations.bind(ctx.graph) : ctx.graph.list.bind(ctx.graph, kind))({ ...(options.q === undefined ? {} : { q: options.q }), ...(options.after === undefined ? {} : { after: options.after }), limit: options.limit });
  const operations = operationsListed ? Object.fromEntries(await Promise.all(found.rows.map(async (entity) => [entity.key, await operationMetadata(ctx, entity)] as const))) : undefined;
  return { kind, total: found.total, rows: found.rows.map((entity: GraphEntity) => refOfGraph(ctx, entity)), next: found.next, ...(operations === undefined ? {} : {operations}) };
}
