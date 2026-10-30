/**
 * The committed walk over a wiki's pages (madarch-j6ho.1): a clean fixture
 * passes, and a fixture that plants one violation of a class fails on exactly
 * that class — the empty section, the raw key, the text in another language,
 * the raw id and the node with no evidence. The walk speaks HTTP to a stub
 * server that answers the product's JSON routes, so enumeration, pagination
 * and the languages a page is asked in are the real ones.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Block, EntityRef, PageModel } from '../src/knowledge/model.js';
import {
  FINDING_CLASSES, compareToBaseline, foreignText, formatBaseline, formatReport, idTokens, inspectCatalogue,
  inspectDocument, inspectPage, jsonValue, parseArguments, parseBaseline, passagesOf, productEndpoint,
  relationIsKey, walkWiki, type WalkResult,
} from '../scripts/wiki-walk.js';

const KIND_SERVICE = 'code.service';
const KIND_PRODUCT = 'product';

/** The stub's status: two kinds, both labelled in the two interface languages. */
const STATUS = {
  product: { name: 'fixture', id: 'fixture' },
  manifest: 'ok',
  manifestFile: 'madarch/kinds.yaml',
  language: 'en',
  seeded: [],
  findings: [],
  kinds: [
    { kind: KIND_SERVICE, source: 'graph', count: 2, origins: ['code'], single: false, labels: { en: { one: 'Service', many: 'Services' }, ru: { one: 'Сервис', many: 'Сервисы' } } },
    { kind: KIND_PRODUCT, source: 'markdown', count: 1, origins: ['agent'], single: true, labels: { en: { one: 'Product', many: 'Products' }, ru: { one: 'Продукт', many: 'Продукты' } } },
  ],
  groups: [{ group: 'code', labels: { en: 'Code', ru: 'Код' } }],
  repositories: [],
  filled: true,
  incomplete: false,
  fill: { state: 'done' },
  writer: { state: 'idle', agent: null, units: [] },
  bounds: {},
  chosenAgent: null,
  home: null,
  roles: {},
  loop: {},
  starterOffers: 0,
};

const ROWS: Record<string, EntityRef[]> = {
  [KIND_SERVICE]: [
    { id: 'code.service:orders', kind: KIND_SERVICE, label: 'orders', href: '/products/fixture/k/e/code.service%3Aorders' },
    { id: 'code.service:payments', kind: KIND_SERVICE, label: 'payments', href: '/products/fixture/k/e/code.service%3Apayments' },
  ],
  [KIND_PRODUCT]: [
    { id: 'product:shop', kind: KIND_PRODUCT, label: 'Shop', href: '/products/fixture/k/e/product%3Ashop' },
  ],
};

const word = (language: string, en: string, ru: string): string => (language === 'ru' ? ru : en);

/** The blocks of a page that breaks no class, in the interface language the page is asked in. */
function cleanBlocks(language: string): Block[] {
  return [
    { type: 'body', markdown: 'The orders service takes an order and charges the card when the shop confirms it.', file: 'docs/orders.md', statements: 1, ungrounded: [] },
    { type: 'properties', title: word(language, 'Details', 'Сведения'), rows: [{ name: 'language', value: 'go', nameKey: 'language' }] },
    {
      type: 'related', title: word(language, 'Relations', 'Связи'),
      groups: [{ relation: 'code.depends-on', direction: 'out', total: 1, rows: [{ entity: ROWS[KIND_SERVICE]![1]!, count: 1 }] }],
    },
    {
      type: 'graph', title: word(language, 'Around this', 'Вокруг этого'), depth: 1, shown: 1, total: 1,
      neighborhood: {
        center: 'code.service:orders',
        nodes: [
          { id: 'code.service:orders', kind: KIND_SERVICE, label: 'orders', href: '/products/fixture/k/e/code.service%3Aorders', hops: 0 },
          { id: 'code.service:payments', kind: KIND_SERVICE, label: 'payments', href: '/products/fixture/k/e/code.service%3Apayments', hops: 1 },
        ],
        edges: [{ from: 'code.service:orders', to: 'code.service:payments', relation: 'code.depends-on', count: 1 }],
        more: [],
        relations: [{ relation: 'code.depends-on', direction: 'out', count: 1 }],
      },
    },
    {
      type: 'refs', title: word(language, 'Pages about this', 'Страницы об этом'), total: 1,
      rows: [{ entity: ROWS[KIND_SERVICE]![1]!, note: 'named', noteKey: 'named' }],
    },
    {
      type: 'treemap', title: word(language, 'Files', 'Файлы'), scope: 'orders', maxChurn: 1, total: 1, notes: [],
      files: [{ id: 'code.file:services/orders/main.go', path: 'services/orders/main.go', href: null, lines: 40, churn: 1 }],
    },
    {
      type: 'history', title: word(language, 'Observed contributions', 'Наблюдаемые изменения'),
      sections: [{ role: 'commits', total: 1, rows: [{ text: 'initial commit', figures: [] }] }], notes: [],
    },
    {
      type: 'diagrams', title: word(language, 'Diagram', 'Диаграмма'), renderer: 'likec4',
      views: [{
        spec: { type: 'c4-context', subject: 'code.service:orders' },
        title: word(language, 'Context', 'Контекст'), label: word(language, 'Context', 'Контекст'),
        elements: [{ id: 'code.service:orders', label: 'orders', kind: 'container', href: '/products/fixture/k/e/code.service%3Aorders', dashed: false }],
        edges: [], notes: [], empty: null, marker: null,
        renderers: ['likec4'], mermaidSource: '', query: 'type=c4-context&subject=code.service%3Aorders',
      }],
    },
    { type: 'source', title: word(language, 'Source', 'Исходный текст'), language: 'go', text: 'package main', truncated: false, location: { repo: null, path: 'services/orders/main.go', lineStart: 1, lineEnd: 1, href: '/source' } },
    {
      type: 'definition', title: word(language, 'Contract', 'Контракт'), format: 'openapi', contract: 'orders',
      members: [{ anchor: 'op-list', label: 'listOrders', href: null }], membersTotal: 1, membersShown: 1, memberCuts: [],
      spec: { text: 'openapi: 3.0.0', lines: 1 },
    },
    { type: 'term', title: word(language, 'Term', 'Термин'), definition: 'An order is a request to buy something from the shop.', synonyms: ['purchase'], code: [], usedIn: null, ambiguous: null },
  ];
}

/** A page of the fixture, clean unless `overrides` plants something. */
function page(id: string, kind: string, language: string, overrides: { blocks?: (blocks: Block[]) => Block[]; title?: string; notes?: string[] } = {}): PageModel {
  const blocks = cleanBlocks(language);
  return {
    id, kind, title: overrides.title ?? 'Orders', trail: [], blocks: overrides.blocks === undefined ? blocks : overrides.blocks(blocks),
    resolutions: {}, findings: [], notes: overrides.notes ?? [],
  };
}

type Pages = Map<string, PageModel>;

/** The pages of the fixture, for both interface languages. */
function fixturePages(): Pages {
  const pages: Pages = new Map();
  for (const language of ['en', 'ru']) {
    for (const [kind, rows] of Object.entries(ROWS)) {
      for (const row of rows) pages.set(`${row.id}|${language}`, page(row.id, kind, language));
    }
  }
  return pages;
}

interface Stub {
  url: string;
  /** The page id whose answer is a 500, when one is. */
  fail?: string;
  /** The document listing's answer, when the walk needs one other than an empty listing. */
  documents?: unknown;
  pages: Pages;
  stop: () => void;
}

function startStub(options: { pages: Pages; fail?: string; documents?: unknown }): Stub {
  const stub: Stub = {
    url: '', pages: options.pages, stop: () => {},
    ...(options.fail === undefined ? {} : { fail: options.fail }),
    ...(options.documents === undefined ? {} : { documents: options.documents }),
  };
  const server = Bun.serve({
    port: 0,
    fetch(request): Response {
      const url = new URL(request.url);
      const base = '/products/fixture';
      if (!url.pathname.startsWith(base)) return new Response('not found', { status: 404 });
      const route = url.pathname.slice(base.length);
      if (route === '/api/k/status') return Response.json(STATUS);
      if (route === '/api/k/questions') return Response.json({ rows: [], open: 0, answered: 0, closed: 0, problems: [] });
      if (route === '/api/k/documents') return Response.json(stub.documents ?? { documents: [], truncated: [] });
      if (route === '/api/k/entities') {
        const kind = url.searchParams.get('kind') ?? '';
        const rows = ROWS[kind];
        if (rows === undefined) return new Response(`no kind ${kind}`, { status: 404 });
        return Response.json({ kind, total: rows.length, rows, next: null });
      }
      if (route === '/api/k/page') {
        const id = url.searchParams.get('id') ?? '';
        if (stub.fail === id) return new Response('the store is busy', { status: 500 });
        const language = url.searchParams.get('lang') ?? 'en';
        const found = stub.pages.get(`${id}|${language}`);
        if (found === undefined) return new Response(`no page ${id} in ${language}`, { status: 404 });
        return Response.json(found);
      }
      return new Response(`no route ${route}`, { status: 404 });
    },
  });
  stub.url = server.url.origin;
  stub.stop = () => { void server.stop(true); };
  return stub;
}

let stub: Stub;
let result: WalkResult;

beforeAll(async () => {
  stub = startStub({ pages: fixturePages() });
  result = await walkWiki({ endpoint: productEndpoint(stub.url, 'fixture'), product: 'fixture' });
});

afterAll(() => stub.stop());

describe('the walk over a clean fixture', () => {
  test('reads every page in every language the manifest declares, and documents, and finds nothing', () => {
    expect(result.findings).toEqual([]);
    expect(result.languages).toEqual(['en', 'ru']);
    expect(result.pages).toBe(3);
    expect(result.pagesRead).toBe(6);
    expect(result.kindLists).toBe(2);
    expect(result.rowsRead).toBe(3);
    expect(result.documentsRead).toBe(0);
    expect(result.language).toBe('en');
  });

  test('the report says what was read and what was found, and writes no finding', () => {
    const report = formatReport(result, 50);
    expect(report).toContain('wiki-walk: fixture');
    expect(report).toContain('read 3 entity pages (6 renders)');
    expect(report).toContain('findings: 0');
  });
});

/** Walk a fixture with one plant on one page and return the result. */
async function planted(edit: (blocks: Block[], language: string) => Block[], target = 'code.service:orders', extra: { notes?: string[] } = {}): Promise<WalkResult> {
  const pages = fixturePages();
  for (const language of ['en', 'ru']) {
    const id = target;
    const kind = id.startsWith('product:') ? KIND_PRODUCT : KIND_SERVICE;
    pages.set(`${id}|${language}`, page(id, kind, language, { blocks: (blocks) => edit(blocks, language), ...(extra.notes === undefined ? {} : { notes: extra.notes }) }));
  }
  const plantedStub = startStub({ pages });
  try {
    return await walkWiki({ endpoint: productEndpoint(plantedStub.url, 'fixture'), product: 'fixture' });
  } finally {
    plantedStub.stop();
  }
}

describe('one violation of a class is found as exactly that class', () => {
  test('an empty section', async () => {
    const found = await planted((blocks, language) => [...blocks, { type: 'callers', title: word(language, 'Callers', 'Вызывающие'), total: 0, rows: [] }]);
    expect(new Set(found.findings.map((finding) => finding.class))).toEqual(new Set(['empty-section']));
    expect(found.findings.every((finding) => finding.page === 'code.service:orders')).toBe(true);
    expect(found.findings[0]!.section).toBe('Callers');
    expect(found.findings[0]!.field).toBe('blocks[11].rows');
  });

  test('a raw key: a property name the app cannot translate', async () => {
    const found = await planted((blocks) => blocks.map((block) => block.type === 'properties' ? { ...block, rows: [{ name: 'packageName', value: 'orders' }] } : block));
    expect(new Set(found.findings.map((finding) => finding.class))).toEqual(new Set(['raw-key']));
    expect(found.findings[0]!.value).toBe('packageName');
    expect(found.findings[0]!.field).toBe('blocks[1].rows[0].name');
  });

  test('a raw key: a value the extractor serialized as JSON', async () => {
    const found = await planted((blocks) => blocks.map((block) => block.type === 'properties' ? { ...block, rows: [{ name: 'language', value: '{"parsed":true}', nameKey: 'language' }] } : block));
    expect(new Set(found.findings.map((finding) => finding.class))).toEqual(new Set(['raw-key']));
    expect(found.findings[0]!.message).toContain('serialized JSON');
  });

  test('text outside the wiki language', async () => {
    const found = await planted((blocks) => [...blocks, { type: 'markdown', markdown: 'Служба заказов принимает заказ и списывает деньги с карты.' }]);
    expect(new Set(found.findings.map((finding) => finding.class))).toEqual(new Set(['foreign-language']));
    expect(found.findings[0]!.message).toContain('the wiki speaks en');
  });

  test('the engine words outside the interface language', async () => {
    const found = await planted((blocks) => blocks.map((block) => block.type === 'treemap' ? { ...block, notes: ['1 file is not drawn.'] } : block));
    // Only the Russian render shows English engine text; the page's own text stays English in both.
    expect(new Set(found.findings.map((finding) => finding.class))).toEqual(new Set(['foreign-language']));
    expect(found.findings.every((finding) => finding.language === 'ru')).toBe(true);
  });

  test('a raw id in text', async () => {
    const found = await planted((blocks) => blocks.map((block) => block.type === 'body' ? { ...block, markdown: 'The payments service (code.service:payments) charges the card when the order ships.' } : block));
    expect(new Set(found.findings.map((finding) => finding.class))).toEqual(new Set(['raw-id']));
    expect(found.findings[0]!.value).toBe('code.service:payments');
  });

  test('a node with no evidence', async () => {
    const found = await planted((blocks) => blocks.map((block) => block.type === 'graph' ? { ...block, neighborhood: { ...block.neighborhood, nodes: block.neighborhood.nodes.map((node) => node.id === 'code.service:payments' ? { ...node, href: null } : node) } } : block));
    expect(new Set(found.findings.map((finding) => finding.class))).toEqual(new Set(['node-without-evidence']));
    expect(found.findings[0]!.value).toBe('code.service:payments');
  });

  test('a diagram node with no evidence', async () => {
    const found = await planted((blocks) => blocks.map((block) => block.type === 'diagrams'
      ? { ...block, views: block.views.map((view) => ({ ...view, elements: view.elements.map((element) => ({ ...element, href: null })) })) }
      : block));
    expect(new Set(found.findings.map((finding) => finding.class))).toEqual(new Set(['node-without-evidence']));
  });
});

describe('the walk fails instead of reporting fewer pages', () => {
  test('a page the server refuses fails the walk with its address', async () => {
    const broken = startStub({ pages: fixturePages(), fail: 'code.service:payments' });
    try {
      await expect(walkWiki({ endpoint: productEndpoint(broken.url, 'fixture'), product: 'fixture' })).rejects.toThrow('HTTP 500');
    } finally {
      broken.stop();
    }
  });

  test('a catalogue that names more rows than it answers fails the walk', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request): Response {
        const url = new URL(request.url);
        if (url.pathname.endsWith('/api/k/status')) return Response.json(STATUS);
        if (url.pathname.endsWith('/api/k/questions')) return Response.json({ rows: [], open: 0, answered: 0, closed: 0, problems: [] });
        if (url.pathname.endsWith('/api/k/entities')) return Response.json({ kind: KIND_SERVICE, total: 3, rows: ROWS[KIND_SERVICE], next: null });
        return new Response('no', { status: 404 });
      },
    });
    try {
      await expect(walkWiki({ endpoint: productEndpoint(server.url.origin, 'fixture'), product: 'fixture' })).rejects.toThrow('names 3 rows and answered 2');
    } finally {
      void server.stop(true);
    }
  });
});

describe('the pieces the walk judges with', () => {
  test('a language is judged by its script, then by the detector', () => {
    expect(foreignText('Служба заказов принимает заказ и списывает деньги с карты.', 'en', 'prose')).not.toBeNull();
    expect(foreignText('The orders service takes an order and charges the card when the shop confirms it.', 'ru', 'prose')).not.toBeNull();
    expect(foreignText('The orders service takes an order and charges the card when the shop confirms it.', 'en', 'prose')).toBeNull();
    expect(foreignText('Bestellungen werden hier gespeichert und jeden Tag geprüft.', 'en', 'prose')).not.toBeNull();
    expect(foreignText('Kubernetes', 'en', 'label')).toBeNull();
    expect(foreignText('Details', 'ru', 'label')).not.toBeNull();
    // A sentence that changes script is two spans: the Russian one is judged
    // even where the English one holds the majority of the letters.
    expect(foreignText('Заказ готов. Payment has failed.', 'en', 'prose')).not.toBeNull();
    expect(foreignText('Заказ готов. Payment has failed.', 'ru', 'prose')).not.toBeNull();
    // A heading is structure: a short one is judged by its script.
    expect(foreignText('Обзор', 'en', 'label')).not.toBeNull();
    // A one-word span is a name, not prose, whatever its script.
    expect(foreignText('Kubernetes', 'ru', 'prose')).toBeNull();
    // A short string, a path and a bare name are not sentences: no judgment.
    expect(foreignText('orders', 'ru', 'prose')).toBeNull();
    expect(foreignText('services/orders/internal/domain/order.go:55-69', 'ru', 'prose')).toBeNull();
  });

  test('an id is a declared namespace, a colon and a remainder, at a boundary', () => {
    const namespaces = new Set(['code.service', 'question', 'madarch']);
    expect(idTokens('See question:why-orders, and code.service:payments.', namespaces)).toEqual(['question:why-orders', 'code.service:payments']);
    expect(idTokens('the xcode.service:payments word', namespaces)).toEqual([]);
    expect(idTokens('question:', namespaces)).toEqual([]);
  });

  test('a relation is a key when the app cannot turn it into words', () => {
    expect(relationIsKey('code.depends-on')).toBe(false);
    expect(relationIsKey('code.depends_on')).toBe(true);
    expect(relationIsKey('engine:discusses', false)).toBe(true);
    expect(relationIsKey('engine:discusses', true)).toBe(false);
    expect(relationIsKey('code.publishedBy')).toBe(true);
  });

  test('serialized JSON is recognised', () => {
    expect(jsonValue('{"parsed":true}')).toBe(true);
    expect(jsonValue('[1,2]')).toBe(true);
    expect(jsonValue('true')).toBe(true);
    expect(jsonValue('go')).toBe(false);
    expect(jsonValue('2026-10-01')).toBe(false);
  });

  test('markdown passages are the prose a reader sees: no code span, no link address', () => {
    const passages = passagesOf('# Title\n\nThe `code.service:payments` id in [a link](https://example.test/code.service:payments) is text.\n\n```\ncode.service:payments\n```\n');
    expect(passages.map((passage) => passage.text)).toEqual(['Title', 'The id in a link is text.']);
    expect(passages[1]!.line).toBe(3);
    expect(passages[0]!.heading).toBe(true);
    expect(passages[1]!.heading).toBeUndefined();
  });

  test('the command line reads its addresses and refuses what it cannot do', () => {
    expect(parseArguments(['--url', 'http://127.0.0.1:4291', '--product', 'shop'])).toEqual({ endpoint: 'http://127.0.0.1:4291/products/shop', product: 'shop', concurrency: 4, maxFindings: 50 });
    expect(parseArguments(['--url', 'http://127.0.0.1:4291/products/shop', '--product', 'shop', '--lang', 'en,ru'])).toMatchObject({ endpoint: 'http://127.0.0.1:4291/products/shop', languages: ['en', 'ru'] });
    expect(() => parseArguments(['--product', 'shop'])).toThrow('--url is required');
    expect(() => parseArguments(['--url', 'http://x', '--product', 'shop', '--concurrency', '0'])).toThrow('at least 1');
  });

  test('a document shows a raw id but is not judged for its language', () => {
    const findings = inspectDocument({
      repo: null, path: 'docs/orders.md', title: 'Orders',
      markdown: 'Служба заказов принимает заказ и списывает деньги. See question:why-orders.',
      resolutions: {}, anchors: {}, commit: null, planned: [],
    }, { product: 'fixture', language: 'en', userLanguage: 'en', ids: new Set(), namespaces: new Set(['question']) });
    expect(findings.map((finding) => finding.class)).toEqual(['raw-id']);
    expect(findings[0]!.value).toBe('question:why-orders');
  });

  test('every class of the milestone is named', () => {
    expect([...FINDING_CLASSES]).toEqual(['empty-section', 'raw-key', 'foreign-language', 'raw-id', 'node-without-evidence']);
  });
});

/** A guide block as the writer emits it: the page draws `data.markdown`. */
const guide = (markdown: string): Block => ({ type: 'guide', data: { markdown } } as unknown as Block);

/** One option set for a page judged on its own, without a server. */
const inspectOptions = (language = 'en', ids: ReadonlySet<string> = new Set(), namespaces: ReadonlySet<string> = new Set(['code.service', 'code.file']), product = language) => ({
  product: 'fixture', language: product, userLanguage: language, ids, namespaces,
});

describe('the shapes a reader meets are read, not skipped', () => {
  test('a truncated document listing fails the walk instead of reading part of it', async () => {
    const server = startStub({ pages: fixturePages(), documents: { documents: [], truncated: [{ repo: 'shop', total: 1000, shown: 0 }] } });
    try {
      await expect(walkWiki({ endpoint: productEndpoint(server.url, 'fixture'), product: 'fixture' }))
        .rejects.toThrow('the listing omits documents of "shop" (0 of 1000 listed)');
    } finally {
      server.stop();
    }
  });

  test('a guide body is read in the language the page was asked in', async () => {
    const found = await planted((blocks) => [...blocks, guide('Начните с заказа: служба заказов принимает его и подтверждает.')]);
    expect(new Set(found.findings.map((finding) => finding.class))).toEqual(new Set(['foreign-language']));
    // The guide is localized to the requested interface language, so only the
    // English render shows Russian text.
    expect(found.findings.every((finding) => finding.language === 'en')).toBe(true);
    expect(found.findings.every((finding) => finding.field === 'blocks[11].data.markdown:1')).toBe(true);
  });

  test('a guide body is read for ids', async () => {
    const found = await planted((blocks) => [...blocks, guide('code.service:orders')]);
    expect(new Set(found.findings.map((finding) => finding.class))).toEqual(new Set(['raw-id']));
    expect(found.findings.map((finding) => finding.value)).toEqual(['code.service:orders', 'code.service:orders']);
  });

  test("a page's own text is judged in the product's language, not the interface language", () => {
    const english: PageModel = {
      id: 'code.service:orders', kind: 'code.service', title: 'Orders', trail: [],
      blocks: [{ type: 'body', markdown: 'The orders service takes an order and charges the card when the shop confirms it.', file: 'docs/orders.md', statements: 1, ungrounded: [] }],
      resolutions: {}, findings: [], notes: [],
    };
    // The reader asked for Russian; the product writes English. The text is the product's, so it is read as English.
    expect(inspectPage(english, inspectOptions('ru', new Set(), new Set(['code.service']), 'en'))).toEqual([]);
    // The same page holding Russian text is foreign whichever language the reader asked in: the check follows the
    // text's provenance, not the kind of the page and not the language of the answer.
    const russian: PageModel = { ...english, blocks: [{ ...english.blocks[0]!, markdown: 'Служба заказов принимает заказ и списывает деньги с карты.' } as PageModel['blocks'][number]] };
    expect(inspectPage(russian, inspectOptions('en', new Set(), new Set(['code.service']), 'en')).map((finding) => finding.class)).toEqual(['foreign-language']);
    expect(inspectPage(russian, inspectOptions('ru', new Set(), new Set(['code.service']), 'en')).map((finding) => finding.class)).toEqual(['foreign-language']);
  });

  test("a template's own words follow the interface language, not the product's", () => {
    const page: PageModel = {
      id: 'code.service:orders', kind: 'code.service', title: 'Orders', trail: [],
      blocks: [{ type: 'markdown', markdown: 'Служба заказов принимает заказ и списывает деньги с карты.' }],
      resolutions: {}, findings: [], notes: [],
    };
    // The template draws its sentence in the language the reader asked for: the product's own language says nothing
    // about the engine's words, so the Russian render is clean and the English render is the foreign one.
    expect(inspectPage(page, inspectOptions('ru', new Set(), new Set(['code.service']), 'en'))).toEqual([]);
    expect(inspectPage(page, inspectOptions('en', new Set(), new Set(['code.service']), 'en')).map((finding) => finding.class)).toEqual(['foreign-language']);
  });

  test('a term definition is Markdown: a code span is code, not a raw id', async () => {
    const found = await planted((blocks) => blocks.map((block) => block.type === 'term' ? { ...block, definition: 'Use `code.service:orders` for checkout.' } : block));
    expect(found.findings).toEqual([]);
  });

  test('a synonym is a name, not a sentence in another language', () => {
    const findings = inspectPage({
      id: 'term:order', kind: 'term', title: 'Заказ', trail: [],
      blocks: [{ type: 'term', title: 'Термин', definition: 'Заказ — это просьба купить что-нибудь в магазине.', synonyms: ['Kubernetes'], code: [], usedIn: null, ambiguous: null }],
      resolutions: {}, findings: [], notes: [],
    }, inspectOptions('ru'));
    expect(findings).toEqual([]);
  });

  test('a short heading is judged by its script', async () => {
    const found = await planted((blocks) => blocks.map((block) => block.type === 'body' ? { ...block, markdown: '# Обзор\n\nThe orders service takes an order and charges the card.' } : block));
    expect(new Set(found.findings.map((finding) => finding.class))).toEqual(new Set(['foreign-language']));
    expect(found.findings.every((finding) => finding.field === 'blocks[0].body.markdown:1')).toBe(true);
  });

  test('a sentence that changes language is judged span by span', async () => {
    const found = await planted((blocks) => blocks.map((block) => block.type === 'body' ? { ...block, markdown: 'Заказ готов. Payment has failed.' } : block));
    expect(new Set(found.findings.map((finding) => finding.class))).toEqual(new Set(['foreign-language']));
    expect(found.findings.every((finding) => finding.value.includes('Заказ готов.'))).toBe(true);
  });

  test('a diagram view is empty on its own, not only when every view is', async () => {
    const found = await planted((blocks, language) => blocks.map((block) => block.type === 'diagrams'
      ? {
        ...block,
        views: [...block.views, {
          ...block.views[0]!, title: word(language, 'Deployment', 'Развёртывание'), label: word(language, 'Deployment', 'Развёртывание'),
          elements: [], edges: [], notes: [], empty: null, mermaidSource: '',
        }],
      }
      : block));
    expect(new Set(found.findings.map((finding) => finding.class))).toEqual(new Set(['empty-section']));
    expect(found.findings.length).toBe(2);
    expect(found.findings.every((finding) => finding.field === 'blocks[7].views[1]')).toBe(true);
  });

  test('a drawn diagram edge label is read for ids', async () => {
    const found = await planted((blocks) => blocks.map((block) => block.type === 'diagrams'
      ? { ...block, views: block.views.map((view) => ({ ...view, edges: [{ from: 'code.service:orders', to: 'code.service:payments', label: 'code.service:orders', dashed: false }] })) }
      : block));
    expect(new Set(found.findings.map((finding) => finding.class))).toEqual(new Set(['raw-id']));
    expect(found.findings.map((finding) => finding.value)).toEqual(['code.service:orders', 'code.service:orders']);
    expect(found.findings.every((finding) => finding.field === 'blocks[7].views[0].edges[0].label')).toBe(true);
  });

  test('a diagram edge explanation is read in the interface language', async () => {
    const found = await planted((blocks) => blocks.map((block) => block.type === 'diagrams'
      ? { ...block, views: block.views.map((view) => ({ ...view, edges: [{ from: 'code.service:orders', to: 'code.service:payments', label: 'depends on', dashed: true, why: 'the graph holds no order for this step' }] })) }
      : block));
    expect(new Set(found.findings.map((finding) => finding.class))).toEqual(new Set(['foreign-language']));
    expect(found.findings.every((finding) => finding.language === 'ru' && finding.field === 'blocks[7].views[0].edges[0].why')).toBe(true);
  });

  test('a view label is the subject name, never judged as prose', async () => {
    // The label names the view's subject (a route, a container, a folder); a
    // route label on the Russian render is not English prose.
    const found = await planted((blocks) => blocks.map((block) => block.type === 'diagrams'
      ? { ...block, views: block.views.map((view) => ({ ...view, label: 'GET /reports/legacy' })) }
      : block));
    expect(found.findings).toEqual([]);
  });

  test('a diagram detail is a value: read for ids, never judged as prose', async () => {
    const found = await planted((blocks) => blocks.map((block) => block.type === 'diagrams'
      ? {
        ...block,
        views: block.views.map((view) => ({
          ...view,
          elements: [
            ...view.elements,
            { id: 'code.dependency:kafka', label: 'kafka', kind: 'image', detail: 'apache/kafka:3.7.0 · ports 9092:9092', href: null, dashed: true },
            { id: 'code.service:payments', label: 'payments', kind: 'image', detail: 'code.service:payments', href: null, dashed: true },
          ],
        })),
      }
      : block));
    expect(new Set(found.findings.map((finding) => finding.class))).toEqual(new Set(['raw-id']));
    expect(found.findings.map((finding) => finding.value)).toEqual(['code.service:payments', 'code.service:payments']);
    expect(found.findings.every((finding) => finding.field === 'blocks[7].views[0].elements[2].detail')).toBe(true);
  });

  test('a self-loop is a fact, not an empty neighbourhood', async () => {
    const found = await planted((blocks) => blocks.map((block) => block.type === 'graph'
      ? {
        ...block,
        neighborhood: {
          ...block.neighborhood,
          nodes: [block.neighborhood.nodes[0]!],
          edges: [{ from: 'code.service:orders', to: 'code.service:orders', relation: 'code.depends-on', count: 1 }],
          more: [],
        },
      }
      : block));
    expect(found.findings).toEqual([]);
  });
});

describe('a label is the entity own name, and punctuation ends an id', () => {
  test('a file whose name is also its id is not a raw id', () => {
    // The input the review cites: the entity's id and its visible label are
    // both the file's path.
    const rows = [{ id: 'src/main.ts', kind: 'code.file', label: 'src/main.ts', href: '/products/fixture/k/e/src%2Fmain.ts' }];
    const options = inspectOptions('en', new Set(['src/main.ts']));
    expect(inspectCatalogue('code.file', rows, options)).toEqual([]);
    const findings = inspectPage({
      id: 'src/main.ts', kind: 'code.file', title: 'src/main.ts', trail: [],
      blocks: [{ type: 'related', title: 'Relations', groups: [{ relation: 'code.depends-on', direction: 'out', total: 1, rows: [{ entity: rows[0]!, count: 1 }] }] }],
      resolutions: {}, findings: [], notes: [],
    }, options);
    expect(findings).toEqual([]);
  });

  test('an em dash ends the token before an id', () => {
    const namespaces = new Set(['code.service', 'question']);
    expect(idTokens('See—code.service:orders', namespaces)).toEqual(['code.service:orders']);
    expect(idTokens('See code.service:orders', namespaces)).toEqual(['code.service:orders']);
    expect(idTokens('question:why—code.service:orders', namespaces)).toEqual(['question:why', 'code.service:orders']);
  });
});

describe('the ratchet holds the counts', () => {
  const counts = (over: Partial<Record<string, number>> = {}): WalkResult['byClass'] => Object.fromEntries(FINDING_CLASSES.map((name) => [name, over[name] ?? 0])) as WalkResult['byClass'];
  const walked = (over: Partial<Record<string, number>> = {}): WalkResult => ({ byClass: counts(over) } as WalkResult);

  test('a class above its baseline is a regression, a class below it a baseline to lower', () => {
    const above = compareToBaseline(walked({ 'raw-key': 3 }), { counts: { 'raw-key': 2 } });
    expect(above.regressions).toEqual([{ class: 'raw-key', baseline: 2, count: 3 }]);
    expect(above.drops).toEqual([]);
    const below = compareToBaseline(walked({ 'raw-key': 1 }), { counts: { 'raw-key': 2 } });
    expect(below.regressions).toEqual([]);
    expect(below.drops).toEqual([{ class: 'raw-key', baseline: 2, count: 1 }]);
  });

  test('a class the baseline does not name may not appear at all', () => {
    const check = compareToBaseline(walked({ 'raw-id': 1 }), { counts: {} });
    expect(check.regressions).toEqual([{ class: 'raw-id', baseline: 0, count: 1 }]);
  });

  test('a baseline names the classes the walk judges and counts only', () => {
    expect(parseBaseline('{"counts":{"raw-key":7}}', 'base.json')).toEqual({ counts: { 'raw-key': 7 } });
    expect(() => parseBaseline('{"counts":{"noise":1}}', 'base.json')).toThrow('base.json: the baseline names the class "noise"');
    expect(() => parseBaseline('{"counts":{"raw-key":-1}}', 'base.json')).toThrow('must be a count');
    expect(() => parseBaseline('[]', 'base.json')).toThrow('not a JSON object');
    expect(() => parseBaseline('nope', 'base.json')).toThrow('is not JSON');
  });

  test('the ratchet says what grew and what fell', () => {
    expect(formatBaseline({ regressions: [{ class: 'raw-key', baseline: 2, count: 3 }], drops: [] })).toContain('above the baseline, so the walk fails');
    expect(formatBaseline({ regressions: [], drops: [{ class: 'raw-key', baseline: 2, count: 1 }] })).toContain('may be lowered');
    expect(formatBaseline({ regressions: [], drops: [] })).toContain('every class is at its baseline');
  });

  test('the command line takes a baseline', () => {
    expect(parseArguments(['--url', 'http://127.0.0.1:4291', '--product', 'shop', '--baseline', 'scripts/wiki-walk-baseline.json']))
      .toMatchObject({ baseline: 'scripts/wiki-walk-baseline.json' });
  });
});
