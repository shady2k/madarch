import { describe, expect, test } from 'bun:test';
import { loadAndCompileModel } from '../src/model/load-and-compile.js';
import type { CompiledModel } from '../src/model/compile.js';
import { wikiPages, type WikiBlock, type WikiCell, type WikiLinkCell, type WikiPage, type WikiTableBlock } from '../src/wiki/pages.js';
import { REFERENCE_SYSTEM } from '../scripts/render-views.js';
import { Repo } from './model-check-repo.js';

/**
 * The wiki's engine-neutral page data (docs/changes/wiki/capabilities/wiki.md,
 * requirement pages): the home page, a page per domain, a page per element
 * that is not a domain, the interfaces page grouped by contract kind, and the
 * zones and data categories pages. The expected pages below are written by
 * hand from the fixture, never produced by the builder and pasted back.
 */

const MODEL_YAML = [
  'version: 1',
  '',
  'elements:',
  '  - id: ordering',
  '    kind: domain',
  '    name: Ordering',
  '  - id: payments',
  '    kind: domain',
  '    name: Payments',
  '  - id: checkout',
  '    kind: service',
  '    name: Checkout',
  '    parent: ordering',
  '    technology: TypeScript',
  '  - id: checkout-cart',
  '    kind: module',
  '    name: Cart',
  '    parent: checkout',
  '  - id: orders-db',
  '    kind: store',
  '    name: Orders database',
  '    parent: ordering',
  '  - id: payments-api',
  '    kind: service',
  '    name: Payments',
  '    parent: payments',
  '    technology: Go',
  '',
  'interfaces:',
  '  - id: pay-api',
  '    provider: payments-api',
  '    contract: http::POST::/pay',
  '',
  'relations:',
  '  - id: checkout-pays',
  '    name: Takes payment',
  '    from: checkout',
  '    to: payments-api',
  '    interface: pay-api',
  '',
].join('\n');

/** A second model, with zones, a data category, a topic interface and an action. */
const MODEL_WITH_ZONES_YAML = [
  'version: 1',
  '',
  'zones:',
  '  - id: internal',
  '    kind: network',
  '    name: Internal network',
  '  - id: dmz',
  '    kind: network',
  '    name: DMZ',
  '  - id: pci',
  '    kind: regulatory',
  '    name: PCI',
  '',
  'categories:',
  '  - id: personal',
  '    name: Personal data',
  '',
  'elements:',
  '  - id: customer',
  '    kind: person',
  '    name: Customer',
  '  - id: orders',
  '    kind: service',
  '    name: Orders',
  '    zones:',
  '      add: [internal]',
  '  - id: audit',
  '    kind: service',
  '    name: Audit',
  '    zones:',
  '      add: [dmz]',
  '  - id: bus',
  '    kind: broker',
  '    name: Event bus',
  '',
  'interfaces:',
  '  - id: topic-orders',
  '    provider: bus',
  '    contract: topic::orders-placed',
  '  - id: audit-api',
  '    provider: audit',
  '    contract: http::GET::/audit',
  '',
  'relations:',
  '  - id: orders-publishes',
  '    name: Publishes orders',
  '    from: orders',
  '    to: bus',
  '    interface: topic-orders',
  '    action: send',
  '    transfers:',
  '      - direction: forward',
  '        confidentiality: restricted',
  '        categories: [personal]',
  '',
].join('\n');

function pagesOfModel(yaml: string = MODEL_YAML): WikiPage[] {
  const repo = new Repo();
  repo.writeModel('model.yaml', yaml);
  const { model, errors } = loadAndCompileModel(repo.path);
  expect(errors).toEqual([]);
  return wikiPages(model as CompiledModel);
}

function pageOf(pages: readonly WikiPage[], id: string): WikiPage {
  const page = pages.find((candidate) => candidate.id === id);
  expect(page).toBeDefined();
  return page!;
}

function tablesOf(page: WikiPage): WikiTableBlock[] {
  return page.blocks.filter((block): block is WikiTableBlock => block.kind === 'table');
}

/** The page's table that carries `columns`, in block order. */
function tableOf(page: WikiPage, columns: readonly string[]): WikiTableBlock {
  const table = tablesOf(page).find((candidate) => candidate.columns.join('|') === columns.join('|'));
  expect(table).toBeDefined();
  return table!;
}

/**
 * The page's blocks under each heading, top-level paragraph blocks under
 * `"(top)"` — how a test reads a page that holds several same-shaped tables.
 */
function sectionsOf(page: WikiPage): Map<string, WikiBlock[]> {
  const sections = new Map<string, WikiBlock[]>([['(top)', []]]);
  let current = '(top)';
  for (const block of page.blocks) {
    if (block.kind === 'heading') {
      current = block.text;
      sections.set(current, []);
    } else {
      sections.get(current)!.push(block);
    }
  }
  return sections;
}

/** The table inside the section named `heading`, which must hold exactly one. */
function sectionTable(page: WikiPage, heading: string): WikiTableBlock {
  const blocks = sectionsOf(page).get(heading);
  expect(blocks).toBeDefined();
  const tables = blocks!.filter((block): block is WikiTableBlock => block.kind === 'table');
  expect(tables.length).toBe(1);
  return tables[0]!;
}

/** Every link a cell carries: none in a text cell, the array's members in a link-array cell. */
function linksOf(cell: WikiCell): readonly WikiLinkCell[] {
  if (typeof cell === 'string') return [];
  return 'length' in cell ? [...cell] : [cell];
}

/** A minimal compiled model a test can break on purpose: no inputs at all. */
function emptyModel(): CompiledModel {
  return {
    schemaVersion: 1,
    elements: [],
    interfaces: [],
    relations: [],
    categories: [],
    zones: [],
    environments: [],
    states: [],
  };
}

function elementOf(id: string, kind: CompiledModel['elements'][number]['kind'], extra: Record<string, unknown> = {}): CompiledModel['elements'][number] {
  return { id, kind, ancestors: [], zones: [], zonesByEnvironment: {}, environments: ['*'], states: [], ...extra };
}

function relationOf(id: string, from: string, to: string, extra: Record<string, unknown> = {}): CompiledModel['relations'][number] {
  return { id, from, to, interaction: false, environments: ['*'], states: [], ...extra };
}

describe('wiki page data', () => {
  test('the home page holds the model counts, the elements by kind and every domain as a link', () => {
    const pages = pagesOfModel();
    const home = pageOf(pages, 'home');
    expect(home.title).toBe('Home');
    expect(home.nav).toEqual([]);
    const paragraphs = home.blocks.filter((block) => block.kind === 'paragraph');
    expect(paragraphs.some((block) => block.kind === 'paragraph' && block.text === 'The model holds 6 elements, 1 interface and 1 relation.')).toBe(true);

    const byKind = tableOf(home, ['Kind', 'Elements']);
    expect(byKind.rows).toEqual([
      ['domain', '2'],
      ['module', '1'],
      ['service', '2'],
      ['store', '1'],
    ]);

    const domains = tableOf(home, ['Domain', 'Elements']);
    expect(domains.rows).toEqual([
      [{ page: 'domain/ordering', text: 'Ordering' }, '3'],
      [{ page: 'domain/payments', text: 'Payments' }, '1'],
    ]);
  });

  test('a domain page links its elements, listed with kind and technology, sorted by name', () => {
    const pages = pagesOfModel();
    const ordering = pageOf(pages, 'domain/ordering');
    expect(ordering.title).toBe('Ordering');
    expect(ordering.nav).toEqual(['Domains']);
    const paragraphs = ordering.blocks.filter((block) => block.kind === 'paragraph');
    expect(paragraphs.some((block) => block.kind === 'paragraph' && block.text === 'The Ordering domain holds 3 elements.')).toBe(true);
    const elements = tableOf(ordering, ['Element', 'Kind', 'Technology']);
    expect(elements.rows).toEqual([
      [{ page: 'element/checkout', text: 'Checkout' }, 'service', 'TypeScript'],
      [{ page: 'element/checkout-cart', text: 'Cart' }, 'module', '—'],
      [{ page: 'element/orders-db', text: 'Orders database' }, 'store', '—'],
    ]);

    const payments = pageOf(pages, 'domain/payments');
    const paymentsRows = tableOf(payments, ['Element', 'Kind', 'Technology']);
    expect(paymentsRows.rows).toEqual([[{ page: 'element/payments-api', text: 'Payments' }, 'service', 'Go']]);
  });

  test('there is a page per domain, a page per non-domain element, and the interfaces, zones and data categories pages', () => {
    const pages = pagesOfModel();
    expect(pages.map((page) => page.id).sort()).toEqual([
      'data-categories',
      'domain/ordering',
      'domain/payments',
      'element/checkout',
      'element/checkout-cart',
      'element/orders-db',
      'element/payments-api',
      'home',
      'interfaces',
      'zones',
    ]);
  });

  test('an element page names its kind, technology, zones and ancestor chain, and links them', () => {
    const pages = pagesOfModel();
    const checkout = pageOf(pages, 'element/checkout');
    expect(checkout.title).toBe('Checkout');
    expect(checkout.nav).toEqual(['Domains', 'Ordering']);
    const summary = tableOf(checkout, ['Kind', 'Technology', 'Zones', 'Ancestors']);
    expect(summary.rows).toEqual([['service', 'TypeScript', '—', [{ page: 'domain/ordering', text: 'Ordering' }]]]);

    // A deeper element: the whole ancestor chain, root first.
    const cart = pageOf(pages, 'element/checkout-cart');
    expect(cart.nav).toEqual(['Domains', 'Ordering']);
    const cartSummary = tableOf(cart, ['Kind', 'Technology', 'Zones', 'Ancestors']);
    expect(cartSummary.rows).toEqual([
      ['module', '—', '—', [{ page: 'domain/ordering', text: 'Ordering' }, { page: 'element/checkout', text: 'Checkout' }]],
    ]);
  });

  test('an element page lists the interfaces it provides with their callers, and its incoming and outgoing relations', () => {
    const pages = pagesOfModel();

    // Checkout provides nothing; it calls Payments.
    const checkout = pageOf(pages, 'element/checkout');
    expect(sectionsOf(checkout).has('Provides')).toBe(false);
    const outgoing = sectionTable(checkout, 'Outgoing relations');
    expect(outgoing.columns).toEqual(['Other end', 'Name', 'Interface', 'Action', 'Data categories']);
    expect(outgoing.rows).toEqual([[{ page: 'element/payments-api', text: 'Payments' }, 'Takes payment', { page: 'interfaces', anchor: 'http', text: 'http::POST::/pay' }, '—', '—']]);
    expect(sectionsOf(checkout).has('Incoming relations')).toBe(false);

    // Payments provides the pay API; Checkout is its caller.
    const payments = pageOf(pages, 'element/payments-api');
    const provides = sectionTable(payments, 'Provides');
    expect(provides.columns).toEqual(['Contract', 'Callers']);
    expect(provides.rows).toEqual([['http::POST::/pay', [{ page: 'element/checkout', text: 'Checkout' }]]]);
    const incoming = sectionTable(payments, 'Incoming relations');
    expect(incoming.rows).toEqual([
      [
        { page: 'element/checkout', text: 'Checkout' },
        'Takes payment',
        { page: 'interfaces', anchor: 'http', text: 'http::POST::/pay' },
        '—',
        '—',
      ],
    ]);
    expect(sectionsOf(payments).has('Outgoing relations')).toBe(false);
  });

  test('elements with no domain sit under Partners and people in the navigation', () => {
    const pages = pagesOfModel(MODEL_WITH_ZONES_YAML);
    const customer = pageOf(pages, 'element/customer');
    expect(customer.nav).toEqual(['Partners and people']);
    const bus = pageOf(pages, 'element/bus');
    expect(bus.nav).toEqual(['Partners and people']);
  });

  test('the interfaces page groups contracts by their kind, each with provider and callers', () => {
    const pages = pagesOfModel(MODEL_WITH_ZONES_YAML);
    const interfaces = pageOf(pages, 'interfaces');
    expect(interfaces.title).toBe('Interfaces');
    expect(interfaces.nav).toEqual(['Interfaces']);
    const top = sectionsOf(interfaces).get('(top)')!;
    expect(top.some((block) => block.kind === 'paragraph' && block.text === 'The model declares 2 interfaces.')).toBe(true);

    const http = sectionTable(interfaces, 'http');
    expect(http.columns).toEqual(['Contract', 'Provider', 'Callers']);
    expect(http.rows).toEqual([['http::GET::/audit', { page: 'element/audit', text: 'Audit' }, '—']]);

    const topic = sectionTable(interfaces, 'topic');
    expect(topic.rows).toEqual([['topic::orders-placed', { page: 'element/bus', text: 'Event bus' }, [{ page: 'element/orders', text: 'Orders' }]]]);
  });

  test('the zones page has a section per zone listing its elements, empty zones included', () => {
    const pages = pagesOfModel(MODEL_WITH_ZONES_YAML);
    const zones = pageOf(pages, 'zones');
    expect(zones.title).toBe('Zones');
    expect(zones.nav).toEqual(['Zones']);
    const top = sectionsOf(zones).get('(top)')!;
    expect(top.some((block) => block.kind === 'paragraph' && block.text === 'The model declares 3 zones.')).toBe(true);

    // Sections in code-point order of the zones' names; a zone with no elements still lists under its heading.
    expect([...sectionsOf(zones).keys()].filter((key) => key !== '(top)')).toEqual(['DMZ', 'Internal network', 'PCI']);
    const dmz = sectionTable(zones, 'DMZ');
    expect(dmz.columns).toEqual(['Element', 'Kind']);
    expect(dmz.rows).toEqual([[{ page: 'element/audit', text: 'Audit' }, 'service']]);
    const internal = sectionTable(zones, 'Internal network');
    expect(internal.rows).toEqual([[{ page: 'element/orders', text: 'Orders' }, 'service']]);
    expect(sectionTable(zones, 'PCI').rows).toEqual([]);
  });

  test('the data categories page has a section per category listing the relations that carry it', () => {
    const pages = pagesOfModel(MODEL_WITH_ZONES_YAML);
    const categories = pageOf(pages, 'data-categories');
    expect(categories.title).toBe('Data categories');
    expect(categories.nav).toEqual(['Data categories']);
    const top = sectionsOf(categories).get('(top)')!;
    expect(top.some((block) => block.kind === 'paragraph' && block.text === 'The model declares 1 data category.')).toBe(true);

    const personal = sectionTable(categories, 'Personal data');
    expect(personal.columns).toEqual(['Relation', 'From', 'To']);
    expect(personal.rows).toEqual([['Publishes orders', { page: 'element/orders', text: 'Orders' }, { page: 'element/bus', text: 'Event bus' }]]);
  });

  test('an element page links its zones, the contracts it calls and the categories its relations carry', () => {
    const pages = pagesOfModel(MODEL_WITH_ZONES_YAML);
    const orders = pageOf(pages, 'element/orders');

    const summary = tableOf(orders, ['Kind', 'Technology', 'Zones', 'Ancestors']);
    expect(summary.rows).toEqual([['service', '—', [{ page: 'zones', anchor: 'Internal network', text: 'Internal network' }], '—']]);

    const outgoing = sectionTable(orders, 'Outgoing relations');
    expect(outgoing.rows).toEqual([
      [
        { page: 'element/bus', text: 'Event bus' },
        'Publishes orders',
        { page: 'interfaces', anchor: 'topic', text: 'topic::orders-placed' },
        'send',
        [{ page: 'data-categories', anchor: 'Personal data', text: 'Personal data' }],
      ],
    ]);
  });

  test('a missing element, interface, zone or category is an error naming it, never a dropped row', () => {
    const relationGhost = emptyModel();
    relationGhost.relations.push(relationOf('r', 'ghost', 'ghost'));
    expect(() => wikiPages(relationGhost)).toThrow('relation "r" names element "ghost", which the model does not have');

    const interfaceGhost = emptyModel();
    interfaceGhost.elements.push(elementOf('api', 'service'));
    interfaceGhost.relations.push(relationOf('r', 'api', 'api', { interface: 'ghost' }));
    expect(() => wikiPages(interfaceGhost)).toThrow('relation "r" names interface "ghost", which the model does not have');

    const providerGhost = emptyModel();
    providerGhost.interfaces.push({ id: 'i', provider: 'ghost', contract: 'http::X' });
    expect(() => wikiPages(providerGhost)).toThrow('interface "i" names element "ghost", which the model does not have');

    const zoneGhost = emptyModel();
    zoneGhost.elements.push(elementOf('api', 'service', { zones: ['ghost'] }));
    expect(() => wikiPages(zoneGhost)).toThrow('element "api" names zone "ghost", which the model does not have');

    const categoryGhost = emptyModel();
    categoryGhost.elements.push(elementOf('api', 'service'));
    categoryGhost.relations.push(
      relationOf('r', 'api', 'api', { transfers: [{ direction: 'forward', confidentiality: 'internal', categories: ['ghost'] }] }),
    );
    expect(() => wikiPages(categoryGhost)).toThrow('relation "r" carries data category "ghost", which the model does not have');
  });

  test('the same model gives the same pages twice', () => {
    expect(JSON.stringify(pagesOfModel())).toBe(JSON.stringify(pagesOfModel()));
  });

  test('every link on every page names a page of the same set', () => {
    const pages = pagesOfModel(MODEL_WITH_ZONES_YAML);
    const ids = new Set(pages.map((page) => page.id));
    for (const page of pages) {
      for (const block of page.blocks) {
        if (block.kind !== 'table') continue;
        for (const row of block.rows) {
          for (const cell of row) {
            for (const link of linksOf(cell)) expect(ids.has(link.page)).toBe(true);
          }
        }
      }
    }
  });

  test('the reference system: a page per non-domain element, contracts grouped by kind, zones and categories', () => {
    const { model, errors } = loadAndCompileModel(REFERENCE_SYSTEM);
    expect(errors).toEqual([]);
    const pages = wikiPages(model as CompiledModel);

    const elementPages = pages.filter((page) => page.id.startsWith('element/'));
    expect(elementPages.length).toBe(64);

    const interfaces = pageOf(pages, 'interfaces');
    const http = sectionTable(interfaces, 'http');
    const grpc = sectionTable(interfaces, 'grpc');
    const topic = sectionTable(interfaces, 'topic');
    const data = sectionTable(interfaces, 'data');
    expect([http.rows.length, grpc.rows.length, topic.rows.length, data.rows.length]).toEqual([27, 12, 11, 1]);
    // Each contract row names its provider and every caller as a link.
    expect(http.columns).toEqual(['Contract', 'Provider', 'Callers']);
    for (const row of [...http.rows, ...grpc.rows, ...topic.rows, ...data.rows]) {
      for (const link of linksOf(row[1]!)) expect(link.page).toMatch(/^(element|domain)\//);
      for (const link of linksOf(row[2]!)) expect(link.page).toMatch(/^(element|domain)\//);
    }

    const zones = pageOf(pages, 'zones');
    expect([...sectionsOf(zones).keys()].filter((key) => key !== '(top)')).toEqual(['Demilitarised zone', 'Internal network', 'PCI DSS cardholder data environment', 'Public internet']);
    const categories = pageOf(pages, 'data-categories');
    expect([...sectionsOf(categories).keys()].filter((key) => key !== '(top)')).toEqual(['Order data', 'Payment card data', 'Personal data']);

    // Scenario element-page: checkout-api's own page.
    const checkout = pageOf(pages, 'element/checkout-api');
    const summary = tableOf(checkout, ['Kind', 'Technology', 'Zones', 'Ancestors']);
    expect(summary.rows).toEqual([
      [
        'service',
        'TypeScript, NestJS',
        [{ page: 'zones', anchor: 'Internal network', text: 'Internal network' }],
        [{ page: 'domain/ordering', text: 'Ordering' }],
      ],
    ]);
    const outgoing = sectionTable(checkout, 'Outgoing relations');
    expect(outgoing.rows).toContainEqual([{ page: 'domain/payments', text: 'Payments' }, 'takes payment', '—', '—', '—']);
  });
});
