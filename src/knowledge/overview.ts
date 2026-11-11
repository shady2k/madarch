/**
 * The six blocks of the product overview (madarch-47vw.5). A product's own template places them: what the product is,
 * how it works, its data, its key terms, where it stands and where to start reading. The engine names no entity and
 * holds no product data: a block reads the product's manifest, its Markdown, its graph and the store's own run state,
 * and the kind names it needs come from the template's parameters (`vision-kind`, `kind`, `milestone-kind`, ...).
 *
 * No section is empty: it shows what it read with the source it stands on, or says which entity's fill brings it and
 * links to the fill page. The one run state it reads is the last fill's end and the filled commit; no run trace, folder
 * list or repository address is shown.
 */
import { byCodePoint } from '../model/order.js';
import { attributeOf, type RenderContext, type Subject } from './blocks.js';
import { entityAddress, FILL_ADDRESS, DOCS_ADDRESS, CATALOGUE_ADDRESS, GLOSSARY_ADDRESS, PROBLEMS_ADDRESS, kindAddress, sourceAddress } from './addresses.js';
import type { GraphEntity } from './graph-read.js';
import { homeKind, listingFormOf, systemKindsOf } from './kinds.js';
import { kindNumbers } from './kind-numbers.js';
import type { Block, OverviewBlockShape, OverviewItem, OverviewSection, OverviewSource } from './model.js';
import { diagramsBlock, type ViewContext } from './views.js';

const WORDS = {
  en: {
    about: 'What the product is', how: 'How it works', data: 'Data', terms: 'Key terms', status: 'Where it stands', reading: 'Where to start reading',
    tables: 'Tables', schema: 'Whole schema', problems: 'Open problems', lastFill: 'Last fill', commit: 'Commit',
    home: 'Product home', documents: 'Documents', catalogue: 'Catalogue', glossary: 'Glossary', fill: 'Fill and progress',
    openFill: 'Open the fill', vision: 'vision', readme: 'README', termsOf: 'key terms', dataOf: 'the data schema',
    howOf: 'the system view', statusOf: 'the milestones and outcomes', aboutOf: 'what the product is',
  },
  ru: {
    about: 'Что это за продукт', how: 'Как он работает', data: 'Данные', terms: 'Ключевые термины', status: 'Где он сейчас', reading: 'С чего начать читать',
    tables: 'Таблиц', schema: 'Вся схема', problems: 'Открытые проблемы', lastFill: 'Последнее заполнение', commit: 'Коммит',
    home: 'Главная продукта', documents: 'Документы', catalogue: 'Каталог', glossary: 'Глоссарий', fill: 'Заполнение и его ход',
    openFill: 'Открыть заполнение', vision: 'видение', readme: 'README', termsOf: 'ключевые термины', dataOf: 'схема данных',
    howOf: 'схема системы', statusOf: 'вехи и результаты', aboutOf: 'то, что это за продукт',
  },
} as const;

type Lang = 'en' | 'ru';
const langOf = (lang: string | undefined): Lang => (lang === 'ru' ? 'ru' : 'en');
const words = (lang: string | undefined) => WORDS[langOf(lang)];
const paramsList = (value: string | undefined): string[] => value === undefined ? [] : value.split(',').map((one) => one.trim()).filter((one) => one !== '');
const titleOf = (params: Readonly<Record<string, string>>, section: OverviewSection, lang: string | undefined): string => params['title'] ?? words(lang)[section];

/** A kind's name in the reader's language, from the manifest alone. */
function kindLabel(ctx: RenderContext, kind: string, lang: string | undefined): string {
  const decl = ctx.manifest.kinds.get(kind);
  const entry = ctx.manifest.catalog?.kinds.get(kind);
  const language = langOf(lang);
  return decl?.labels?.[language]?.many ?? decl?.labels?.['en']?.many
    ?? entry?.labels?.[language]?.many ?? entry?.labels?.['en']?.many ?? kind;
}

/** A Markdown page's source: the file and the line its body starts at. */
function markdownSource(entity: { file: string; bodyLine: number }): OverviewSource {
  return { label: `${entity.file}:${entity.bodyLine}`, href: sourceAddress(null, entity.file, entity.bodyLine) };
}

/** A graph entity's source: its evidence's file and line, or its page when it has no file evidence. */
function graphSource(ctx: RenderContext, entity: GraphEntity): OverviewSource {
  const evidence = (entity.evidence ?? []).find((one) => one.path !== null && one.path !== undefined);
  if (evidence !== undefined && evidence.path !== null) {
    const repository = evidence.repository === ctx.ownRepository ? null : evidence.repository;
    const line = evidence.lineStart ?? 1;
    return { label: `${evidence.path}:${line}`, href: sourceAddress(repository, evidence.path, line) };
  }
  return { label: entity.label, href: entityAddress(entity.key) };
}

/** A text of a document or a field, cut to a paragraph a reader can take in. */
function excerpt(text: string, max = 600): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[\^[^\]]+\]:[^\n]*/gu, ' ')
    .replace(/\[\^[^\]]+\]/gu, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .split(/\r?\n/u)
    .map((line) => line.replace(/^#{1,6}\s*/u, '').replace(/^\s*(?:[-*+]|\d+\.)\s+/u, '').trim())
    .filter((line) => line !== '')
    .join(' ')
    .replace(/[*_`>]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1).trimEnd()}…`;
}

/** What a section without data says: which entity's fill brings it, and the way to the fill. */
function absent(lang: string | undefined, kinds: readonly string[], what: string): NonNullable<OverviewBlockShape['absent']> {
  const w = words(lang);
  const labels = kinds.map((kind) => kind);
  const named = labels.length === 0 ? null : labels.join(', ');
  const message = langOf(lang) === 'ru'
    ? named === null ? 'Это появится после заполнения.' : `Это появится после заполнения: ${named} — ${what}.`
    : named === null ? 'This appears after a fill.' : `This appears after a fill of ${named}: ${what}.`;
  return { message, href: FILL_ADDRESS, label: w.openFill };
}

/** The product's name for a diagram: its home page's title, else a plain word. */
function productTitle(ctx: RenderContext): string {
  const home = homeKind(ctx.manifest);
  const page = home === undefined ? undefined : [...ctx.markdown.values()].find((entity) => entity.kind === home.name);
  return page?.title ?? 'Product';
}

/** One graph entity of a kind, for a block that needs a subject for a view. */
async function firstEntity(ctx: RenderContext, kind: string): Promise<GraphEntity | undefined> {
  return (await ctx.graph.list(kind, { limit: 1 })).rows[0];
}

function block(section: OverviewSection, title: string, rest: Omit<OverviewBlockShape, 'type' | 'section' | 'title'>): OverviewBlockShape {
  return { type: 'overview', section, title, ...rest };
}

// ---- 1. what the product is ----------------------------------------------------------------------------------------

export async function overviewAbout(ctx: RenderContext, subject: Subject, params: Readonly<Record<string, string>>, lang: string | undefined): Promise<Block> {
  const title = titleOf(params, 'about', lang);
  const paragraphs: OverviewBlockShape['paragraphs'] = [];
  const visionKinds = paramsList(params['vision-kind']);
  for (const kind of visionKinds) {
    const decl = ctx.manifest.kinds.get(kind);
    if (decl === undefined) continue;
    if (decl.source === 'markdown') {
      const page = [...ctx.markdown.values()].find((entity) => entity.kind === kind);
      if (page !== undefined && page.body.trim() !== '') paragraphs.push({ text: excerpt(page.body), source: markdownSource(page) });
    } else {
      const entity = await firstEntity(ctx, kind);
      if (entity === undefined) continue;
      const text = ['vision', 'definition', 'description', 'summary']
        .map((field) => attributeOf({ source: 'graph', entity }, field))
        .find((value) => value !== undefined && value.trim() !== '');
      if (text !== undefined) paragraphs.push({ text: excerpt(text), source: graphSource(ctx, entity) });
    }
  }
  // The product page itself is the fallback: its body is the product's own statement when no separate vision page exists.
  if (paragraphs.length === 0 && subject.source === 'markdown' && subject.entity.body.trim() !== '') {
    paragraphs.push({ text: excerpt(subject.entity.body), source: markdownSource(subject.entity) });
  }
  const readme = params['readme'] ?? 'README.md';
  const readmeText = ctx.readSource === undefined ? undefined : await ctx.readSource(null, readme);
  if (readmeText !== undefined && readmeText.trim() !== '') {
    const text = excerpt(readmeText, 480);
    if (!paragraphs.some((paragraph) => paragraph.text === text)) paragraphs.push({ text, source: { label: `${readme}:1`, href: sourceAddress(null, readme, 1) } });
  }
  if (paragraphs.length > 0) return block('about', title, { paragraphs });
  return block('about', title, { absent: absent(lang, visionKinds.map((kind) => kindLabel(ctx, kind, lang)), words(lang).aboutOf) });
}

// ---- 2. how it works ------------------------------------------------------------------------------------------------

export async function overviewHow(ctx: RenderContext, subject: Subject, params: Readonly<Record<string, string>>, file: string, line: number, lang: string | undefined): Promise<Block> {
  const title = titleOf(params, 'how', lang);
  const view: ViewContext = { ctx, lang, productTitle: productTitle(ctx) };
  const diagrams = await diagramsBlock(view, subject, 'system', { ...params, title: '' }, { product: ctx.manifest.diagram, env: process.env }, { file, line });
  const kinds = systemKindsOf(ctx.manifest, 'container').map((kind) => kindLabel(ctx, kind, lang));
  if (diagrams.type === 'problem') return block('how', title, { absent: absent(lang, kinds, words(lang).howOf) });
  const drawn = diagrams.views.some((one) => one.empty === null || one.elements.length > 0 || one.mermaidSource !== '');
  if (!drawn) return block('how', title, { absent: absent(lang, kinds, words(lang).howOf) });
  return block('how', title, { diagrams });
}

// ---- 3. data -------------------------------------------------------------------------------------------------------

export async function overviewData(ctx: RenderContext, params: Readonly<Record<string, string>>, file: string, line: number, lang: string | undefined): Promise<Block> {
  const title = titleOf(params, 'data', lang);
  const w = words(lang);
  const numbers = await kindNumbers(ctx);
  const erKinds = [...ctx.manifest.kinds.values()].filter((decl) => decl.er !== undefined).sort((left, right) => byCodePoint(left.name, right.name));
  const declared = paramsList(params['kind']);
  const candidates = declared.length > 0 ? erKinds.filter((decl) => declared.includes(decl.name)) : erKinds;
  const labels = (candidates.length > 0 ? candidates : erKinds).map((decl) => kindLabel(ctx, decl.name, lang));
  for (const decl of candidates) {
    if (numbers.count(decl.name, decl.source) === 0) continue;
    const entity = await firstEntity(ctx, decl.name);
    if (entity === undefined) continue;
    const view: ViewContext = { ctx, lang, productTitle: productTitle(ctx) };
    const diagrams = await diagramsBlock(view, { source: 'graph', entity }, 'er', { ...params, title: '' }, { product: ctx.manifest.diagram, env: process.env }, { file, line });
    if (diagrams.type === 'problem') continue;
    const tables = diagrams.views[0]?.elements.length ?? 0;
    const rows: OverviewItem[] = [
      { label: w.tables, value: String(tables), href: kindAddress(decl.name) },
      { label: w.schema, value: kindLabel(ctx, decl.name, lang), href: kindAddress(decl.name) },
    ];
    return block('data', title, { diagrams, rows });
  }
  return block('data', title, { absent: absent(lang, labels, w.dataOf) });
}

// ---- 4. key terms --------------------------------------------------------------------------------------------------

export async function overviewTerms(ctx: RenderContext, params: Readonly<Record<string, string>>, lang: string | undefined): Promise<Block> {
  const title = titleOf(params, 'terms', lang);
  const w = words(lang);
  const declared = paramsList(params['kind']);
  const kinds = declared.length > 0
    ? declared.filter((kind) => ctx.manifest.kinds.has(kind))
    : [...ctx.manifest.kinds.values()].filter((decl) => listingFormOf(ctx.manifest, decl.name) === 'glossary').map((decl) => decl.name);
  const rows: OverviewItem[] = [];
  for (const kind of kinds) {
    if (rows.length >= 10) break;
    const decl = ctx.manifest.kinds.get(kind);
    if (decl === undefined) continue;
    if (decl.source === 'markdown') {
      for (const page of [...ctx.markdown.values()].filter((entity) => entity.kind === kind).sort((left, right) => byCodePoint(left.title, right.title))) {
        if (rows.length >= 10) break;
        rows.push({ label: page.title, value: excerpt(page.body, 180), href: entityAddress(page.id), source: markdownSource(page) });
      }
    } else {
      const entities = (await ctx.graph.list(kind, { limit: 10 - rows.length })).rows;
      for (const entity of entities) {
        const definition = attributeOf({ source: 'graph', entity }, 'definition') ?? attributeOf({ source: 'graph', entity }, 'description') ?? excerpt(entity.label, 180);
        rows.push({ label: entity.label, value: excerpt(definition, 180), href: entityAddress(entity.key), source: graphSource(ctx, entity) });
      }
    }
  }
  if (rows.length > 0) return block('terms', title, { rows });
  return block('terms', title, { absent: absent(lang, kinds.map((kind) => kindLabel(ctx, kind, lang)), w.termsOf) });
}

// ---- 5. where it stands --------------------------------------------------------------------------------------------

export async function overviewStatus(ctx: RenderContext, params: Readonly<Record<string, string>>, lang: string | undefined): Promise<Block> {
  const title = titleOf(params, 'status', lang);
  const w = words(lang);
  const rows: OverviewItem[] = [];
  const milestoneKinds = paramsList(params['milestone-kind']);
  const outcomeKinds = paramsList(params['outcome-kind']);
  let standing = 0;
  for (const kind of [...milestoneKinds, ...outcomeKinds]) {
    if (!ctx.manifest.kinds.has(kind)) continue;
    for (const entity of (await ctx.graph.list(kind, { limit: 5 })).rows) {
      standing += 1;
      rows.push({ label: entity.label, value: kindLabel(ctx, kind, lang), href: entityAddress(entity.key), source: graphSource(ctx, entity) });
    }
  }
  const problems = ctx.problemCount?.();
  rows.push({ label: w.problems, ...(problems === undefined ? {} : { value: String(problems) }), href: PROBLEMS_ADDRESS });
  const commit = ctx.commitOf(ctx.ownRepository ?? ctx.repositories[0] ?? '');
  const commitKind = [...ctx.manifest.kinds.values()].find((decl) => decl.history === 'commit');
  if (ctx.fillRun !== undefined) rows.push({ label: w.lastFill, value: ctx.fillRun.finishedAt.slice(0, 10), href: FILL_ADDRESS });
  if (commit !== null) rows.push({ label: w.commit, value: commit.slice(0, 7), ...(commitKind === undefined ? {} : { href: entityAddress(`${commitKind.name}:${commit}`) }) });
  const missing = [...milestoneKinds, ...outcomeKinds];
  return standing > 0
    ? block('status', title, { rows })
    : block('status', title, { rows, absent: absent(lang, missing.map((kind) => kindLabel(ctx, kind, lang)), w.statusOf) });
}

// ---- 6. where to start reading -------------------------------------------------------------------------------------

export function overviewReading(ctx: RenderContext, params: Readonly<Record<string, string>>, lang: string | undefined): Block {
  const title = titleOf(params, 'reading', lang);
  const w = words(lang);
  const glossary = [...ctx.manifest.kinds.values()].some((decl) => listingFormOf(ctx.manifest, decl.name) === 'glossary');
  // The page the reader is on is not a place to start reading from: no self-link.
  const links: OverviewItem[] = [
    { label: w.documents, href: DOCS_ADDRESS },
    { label: w.catalogue, href: CATALOGUE_ADDRESS },
    ...(glossary ? [{ label: w.glossary, href: GLOSSARY_ADDRESS }] : []),
    { label: w.problems, href: PROBLEMS_ADDRESS },
    { label: w.fill, href: FILL_ADDRESS },
  ];
  return block('reading', title, { links });
}
