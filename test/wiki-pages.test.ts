import { readdirSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { loadAndCompileModel } from '../src/model/load-and-compile.js';
import type { CompiledModel } from '../src/model/compile.js';
import { wikiPages, type WikiBlock, type WikiCell, type WikiDiagramBlock, type WikiLinkCell, type WikiPage, type WikiTableBlock } from '../src/wiki/pages.js';
import { MERMAID_FOLDER, REFERENCE_SYSTEM } from '../scripts/render-views.js';
import { byCodePoint } from '../src/model/order.js';
import { Repo } from './model-check-repo.js';

/**
 * The wiki's engine-neutral page data (docs/changes/wiki/capabilities/wiki.md,
 * requirement pages): the home page, a page per domain, a page per element
 * that is not a domain, the interfaces page grouped by contract kind, and the
 * zones and data categories pages. The expected pages below are written by
 * hand from the fixture, never produced by the builder and pasted back. The
 * fixtures declare their parts in orders the pages must not echo: every list
 * the pages show comes out sorted, whatever order the model wrote.
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
  '  - id: p1',
  '    provider: payments-api',
  '    contract: http::POST::/refund',
  '  - id: p2',
  '    provider: payments-api',
  '    contract: http::POST::/pay',
  '',
  'relations:',
  '  - id: checkout-pays',
  '    name: Takes payment',
  '    from: checkout',
  '    to: payments-api',
  '    interface: p2',
  '',
].join('\n');

/**
 * A second model, with zones, data categories, topic and data contracts and
 * actions. Deliberately unsorted where order matters, in both directions the
 * pages must not echo: the compiled model hands everything over sorted by
 * id, so ids run against the names (a-z is Zulu, cat-a is Personal data,
 * p1 is the refund contract, r1 is Reads audits), a transfer repeats a
 * category, another carries none, and two elements share the name Mirror
 * to force the id tiebreak. Every list the pages show must come out in
 * code-point order of what the reader sees.
 */
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
  '  - id: cat-a',
  '    name: Personal data',
  '  - id: cat-z',
  '    name: Order data',
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
  '    zones:',
  '      add: [internal]',
  '  - id: a-z',
  '    kind: service',
  '    name: Zulu',
  '    zones:',
  '      add: [internal]',
  '  - id: z-a',
  '    kind: service',
  '    name: Alpha',
  '    zones:',
  '      add: [internal]',
  '  - id: b-mirror',
  '    kind: service',
  '    name: Mirror',
  '  - id: a-mirror',
  '    kind: service',
  '    name: Mirror',
  '',
  'interfaces:',
  '  - id: a-topic',
  '    provider: bus',
  '    contract: topic::orders-placed',
  '  - id: p1',
  '    provider: audit',
  '    contract: http::POST::/refund',
  '  - id: p2',
  '    provider: audit',
  '    contract: http::POST::/pay',
  '',
  'relations:',
  '  - id: call-a',
  '    name: Alpha calls',
  '    from: z-a',
  '    to: bus',
  '    interface: a-topic',
  '    action: send',
  '  - id: call-z',
  '    name: Zulu calls',
  '    from: a-z',
  '    to: bus',
  '    interface: a-topic',
  '    action: send',
  '  - id: orders-relay2',
  '    name: Relay two',
  '    from: orders',
  '    to: b-mirror',
  '  - id: orders-relay1',
  '    name: Relay one',
  '    from: orders',
  '    to: a-mirror',
  '  - id: r1',
  '    name: Reads audits',
  '    from: orders',
  '    to: audit',
  '    interface: p2',
  '    transfers:',
  '      - direction: reverse',
  '        confidentiality: internal',
  '        categories: [cat-a, cat-z, cat-a]',
  '  - id: r2',
  '    name: Publishes orders',
  '    from: orders',
  '    to: bus',
  '    interface: a-topic',
  '    action: send',
  '    transfers:',
  '      - direction: forward',
  '        confidentiality: restricted',
  '        categories: [cat-a]',
  '      - direction: reverse',
  '        confidentiality: internal',
  '        categories: []',
  '',
].join('\n');

function pagesOfModel(yaml: string = MODEL_YAML, views: readonly string[] = []): WikiPage[] {
  const repo = new Repo();
  repo.writeModel('model.yaml', yaml);
  const { model, errors } = loadAndCompileModel(repo.path);
  expect(errors).toEqual([]);
  return wikiPages(model as CompiledModel, views);
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
    expect(paragraphs.some((block) => block.kind === 'paragraph' && block.text === 'The model holds 6 elements, 2 interfaces and 1 relation.')).toBe(true);
    expect(home.blocks).toContainEqual({ kind: 'heading', level: 2, text: 'Elements by kind' });
    expect(home.blocks).toContainEqual({ kind: 'heading', level: 2, text: 'Domains' });

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

  test('the pages come in one order: home, each domain then its elements, the rest after', () => {
    const pages = pagesOfModel();
    expect(pages.map((page) => page.id)).toEqual([
      'home',
      'domain/ordering',
      'element/checkout',
      'element/checkout-cart',
      'element/orders-db',
      'domain/payments',
      'element/payments-api',
      'interfaces',
      'zones',
      'data-categories',
    ]);
  });

  test('a page per zone and per data category sits after its index page, in name order', () => {
    const pages = pagesOfModel(MODEL_WITH_ZONES_YAML);
    expect(pages.map((page) => page.id)).toEqual([
      'home',
      'element/z-a',
      'element/audit',
      'element/customer',
      'element/bus',
      'element/a-mirror',
      'element/b-mirror',
      'element/orders',
      'element/a-z',
      'interfaces',
      'zones',
      'zone/dmz',
      'zone/internal',
      'zone/pci',
      'data-categories',
      'data-category/cat-z',
      'data-category/cat-a',
    ]);
  });

  test('two zones with the same name give two pages and two distinct links', () => {
    const yaml = [
      'version: 1',
      '',
      'zones:',
      '  - id: z1',
      '    kind: network',
      '    name: Same',
      '  - id: z2',
      '    kind: network',
      '    name: Same',
      '',
      'elements:',
      '  - id: e1',
      '    kind: service',
      '    name: One',
      '    zones:',
      '      add: [z1]',
      '  - id: e2',
      '    kind: service',
      '    name: Two',
      '    zones:',
      '      add: [z2]',
      '',
    ].join('\n');
    const pages = pagesOfModel(yaml);
    const first = pageOf(pages, 'zone/z1');
    const second = pageOf(pages, 'zone/z2');
    expect(first.title).toBe('Same');
    expect(second.title).toBe('Same');
    expect(first.nav).toEqual(['Zones']);
    expect(tableOf(first, ['Element', 'Kind']).rows).toEqual([[{ page: 'element/e1', text: 'One' }, 'service']]);
    expect(tableOf(second, ['Element', 'Kind']).rows).toEqual([[{ page: 'element/e2', text: 'Two' }, 'service']]);

    // Each element page links its own zone's page, never a shared heading.
    expect(tableOf(pageOf(pages, 'element/e1'), ['Kind', 'Technology', 'Zones', 'Ancestors']).rows).toEqual([
      ['service', '—', [{ page: 'zone/z1', text: 'Same' }], '—'],
    ]);
    expect(tableOf(pageOf(pages, 'element/e2'), ['Kind', 'Technology', 'Zones', 'Ancestors']).rows).toEqual([
      ['service', '—', [{ page: 'zone/z2', text: 'Same' }], '—'],
    ]);

    // The index lists and links both, name ties broken by id.
    expect(tableOf(pageOf(pages, 'zones'), ['Zone', 'Elements']).rows).toEqual([
      [{ page: 'zone/z1', text: 'Same' }, '1'],
      [{ page: 'zone/z2', text: 'Same' }, '1'],
    ]);
  });

  test('a child domain keeps its own page kind, ordered before its elements, and independents sort by name', () => {
    const yaml = [
      'version: 1',
      '',
      'elements:',
      '  - id: d1',
      '    kind: domain',
      '    name: Outer',
      '  - id: s1',
      '    kind: service',
      '    name: Zed',
      '    parent: d1',
      '  - id: s2',
      '    kind: service',
      '    name: Abc',
      '    parent: d1',
      '  - id: d2',
      '    kind: domain',
      '    name: Inner',
      '    parent: d1',
      '',
    ].join('\n');
    const pages = pagesOfModel(yaml);
    // The walk goes by name: Abc first, then the Inner domain and what it holds, then Zed.
    expect(pages.map((page) => page.id)).toEqual([
      'home',
      'domain/d1',
      'element/s2',
      'domain/d2',
      'element/s1',
      'interfaces',
      'zones',
      'data-categories',
    ]);
    const outer = tableOf(pageOf(pages, 'domain/d1'), ['Element', 'Kind', 'Technology']);
    expect(outer.rows).toEqual([
      [{ page: 'element/s2', text: 'Abc' }, 'service', '—'],
      [{ page: 'domain/d2', text: 'Inner' }, 'domain', '—'],
      [{ page: 'element/s1', text: 'Zed' }, 'service', '—'],
    ]);
    // The home page still lists every domain, child domains included, by name.
    const homeDomains = tableOf(pageOf(pages, 'home'), ['Domain', 'Elements']);
    expect(homeDomains.rows).toEqual([
      [{ page: 'domain/d2', text: 'Inner' }, '0'],
      [{ page: 'domain/d1', text: 'Outer' }, '3'],
    ]);

    // A domain under a person is still a root domain; the independents come out sorted.
    const held = pagesOfModel(
      [
        'version: 1',
        '',
        'elements:',
        '  - id: bus',
        '    kind: broker',
        '    name: Event bus',
        '  - id: customer',
        '    kind: person',
        '    name: Customer',
        '  - id: venture',
        '    kind: domain',
        '    name: Venture',
        '    parent: customer',
        '',
      ].join('\n'),
    );
    expect(held.map((page) => page.id)).toEqual([
      'home',
      'domain/venture',
      'element/customer',
      'element/bus',
      'interfaces',
      'zones',
      'data-categories',
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

    // Payments provides two interfaces, sorted by contract though declared the other way round.
    const payments = pageOf(pages, 'element/payments-api');
    const provides = sectionTable(payments, 'Provides');
    expect(provides.columns).toEqual(['Contract', 'Callers']);
    expect(provides.rows).toEqual([
      [{ page: 'interfaces', anchor: 'http', text: 'http::POST::/pay' }, [{ page: 'element/checkout', text: 'Checkout' }]],
      [{ page: 'interfaces', anchor: 'http', text: 'http::POST::/refund' }, '—'],
    ]);
    const incoming = sectionTable(payments, 'Incoming relations');
    expect(incoming.columns).toEqual(['Other end', 'Name', 'Interface', 'Action', 'Data categories']);
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
    expect(top.some((block) => block.kind === 'paragraph' && block.text === 'The model declares 3 interfaces.')).toBe(true);
    expect([...sectionsOf(interfaces).keys()]).toEqual(['(top)', 'http', 'topic']);

    // Contracts in code-point order though their ids sort the other way.
    const http = sectionTable(interfaces, 'http');
    expect(http.columns).toEqual(['Contract', 'Provider', 'Callers']);
    expect(http.rows).toEqual([
      ['http::POST::/pay', { page: 'element/audit', text: 'Audit' }, [{ page: 'element/orders', text: 'Orders' }]],
      ['http::POST::/refund', { page: 'element/audit', text: 'Audit' }, '—'],
    ]);

    // Callers by name, not by the id order the compiled model hands over.
    const topic = sectionTable(interfaces, 'topic');
    expect(topic.rows).toEqual([
      [
        'topic::orders-placed',
        { page: 'element/bus', text: 'Event bus' },
        [{ page: 'element/z-a', text: 'Alpha' }, { page: 'element/orders', text: 'Orders' }, { page: 'element/a-z', text: 'Zulu' }],
      ],
    ]);
  });

  test('the zones page lists and links every zone, and a page per zone holds its elements', () => {
    const pages = pagesOfModel(MODEL_WITH_ZONES_YAML);
    const zones = pageOf(pages, 'zones');
    expect(zones.title).toBe('Zones');
    expect(zones.nav).toEqual(['Zones']);
    const top = sectionsOf(zones).get('(top)')!;
    expect(top.some((block) => block.kind === 'paragraph' && block.text === 'The model declares 3 zones.')).toBe(true);

    // Every zone linked, in code-point order of the zones' names; an empty zone still lists, with 0.
    expect(tableOf(zones, ['Zone', 'Elements']).rows).toEqual([
      [{ page: 'zone/dmz', text: 'DMZ' }, '1'],
      [{ page: 'zone/internal', text: 'Internal network' }, '4'],
      [{ page: 'zone/pci', text: 'PCI' }, '0'],
    ]);

    // A page per zone: the elements it holds, with kind, each linked, empty zones included.
    const dmz = pageOf(pages, 'zone/dmz');
    expect(dmz.title).toBe('DMZ');
    expect(dmz.nav).toEqual(['Zones']);
    expect(tableOf(dmz, ['Element', 'Kind']).rows).toEqual([[{ page: 'element/audit', text: 'Audit' }, 'service']]);
    const internal = pageOf(pages, 'zone/internal');
    expect(internal.title).toBe('Internal network');
    expect(tableOf(internal, ['Element', 'Kind']).rows).toEqual([
      [{ page: 'element/z-a', text: 'Alpha' }, 'service'],
      [{ page: 'element/bus', text: 'Event bus' }, 'broker'],
      [{ page: 'element/orders', text: 'Orders' }, 'service'],
      [{ page: 'element/a-z', text: 'Zulu' }, 'service'],
    ]);
    expect(tableOf(pageOf(pages, 'zone/pci'), ['Element', 'Kind']).rows).toEqual([]);
  });

  test('the data categories page lists and links every category, and a page per category holds its relations', () => {
    const pages = pagesOfModel(MODEL_WITH_ZONES_YAML);
    const categories = pageOf(pages, 'data-categories');
    expect(categories.title).toBe('Data categories');
    expect(categories.nav).toEqual(['Data categories']);
    const top = sectionsOf(categories).get('(top)')!;
    expect(top.some((block) => block.kind === 'paragraph' && block.text === 'The model declares 2 data categories.')).toBe(true);

    expect(tableOf(categories, ['Data category', 'Relations']).rows).toEqual([
      [{ page: 'data-category/cat-z', text: 'Order data' }, '1'],
      [{ page: 'data-category/cat-a', text: 'Personal data' }, '2'],
    ]);

    // A page per category: the relations that carry it, each end linked.
    const orderData = pageOf(pages, 'data-category/cat-z');
    expect(orderData.title).toBe('Order data');
    expect(orderData.nav).toEqual(['Data categories']);
    expect(tableOf(orderData, ['Relation', 'From', 'To']).rows).toEqual([
      ['Reads audits', { page: 'element/orders', text: 'Orders' }, { page: 'element/audit', text: 'Audit' }],
    ]);
    const personal = pageOf(pages, 'data-category/cat-a');
    expect(personal.title).toBe('Personal data');
    expect(tableOf(personal, ['Relation', 'From', 'To']).rows).toEqual([
      ['Publishes orders', { page: 'element/orders', text: 'Orders' }, { page: 'element/bus', text: 'Event bus' }],
      ['Reads audits', { page: 'element/orders', text: 'Orders' }, { page: 'element/audit', text: 'Audit' }],
    ]);
  });

  test('an element page links its zones, the contracts it calls and the categories its relations carry', () => {
    const pages = pagesOfModel(MODEL_WITH_ZONES_YAML);
    const orders = pageOf(pages, 'element/orders');

    const summary = tableOf(orders, ['Kind', 'Technology', 'Zones', 'Ancestors']);
    expect(summary.rows).toEqual([['service', '—', [{ page: 'zone/internal', text: 'Internal network' }], '—']]);

    const outgoing = sectionTable(orders, 'Outgoing relations');
    expect(outgoing.rows).toEqual([
      [
        { page: 'element/audit', text: 'Audit' },
        'Reads audits',
        { page: 'interfaces', anchor: 'http', text: 'http::POST::/pay' },
        '—',
        [{ page: 'data-category/cat-z', text: 'Order data' }, { page: 'data-category/cat-a', text: 'Personal data' }],
      ],
      [
        { page: 'element/bus', text: 'Event bus' },
        'Publishes orders',
        { page: 'interfaces', anchor: 'topic', text: 'topic::orders-placed' },
        'send',
        [{ page: 'data-category/cat-a', text: 'Personal data' }],
      ],
      [{ page: 'element/a-mirror', text: 'Mirror' }, 'Relay one', '—', '—', '—'],
      [{ page: 'element/b-mirror', text: 'Mirror' }, 'Relay two', '—', '—', '—'],
    ]);
  });

  test('a missing element, interface, zone or category is an error naming it, never a dropped row', () => {
    const relationGhost = emptyModel();
    relationGhost.relations.push(relationOf('r', 'ghost', 'ghost'));
    expect(() => wikiPages(relationGhost, [])).toThrow('relation "r" names element "ghost", which the model does not have');

    const interfaceGhost = emptyModel();
    interfaceGhost.elements.push(elementOf('api', 'service'));
    interfaceGhost.relations.push(relationOf('r', 'api', 'api', { interface: 'ghost' }));
    expect(() => wikiPages(interfaceGhost, [])).toThrow('relation "r" names interface "ghost", which the model does not have');

    const providerGhost = emptyModel();
    providerGhost.interfaces.push({ id: 'i', provider: 'ghost', contract: 'http::X' });
    expect(() => wikiPages(providerGhost, [])).toThrow('interface "i" names element "ghost", which the model does not have');

    const zoneGhost = emptyModel();
    zoneGhost.elements.push(elementOf('api', 'service', { zones: ['ghost'] }));
    expect(() => wikiPages(zoneGhost, [])).toThrow('element "api" names zone "ghost", which the model does not have');

    const ancestorGhost = emptyModel();
    ancestorGhost.elements.push(elementOf('api', 'service', { ancestors: ['ghost'] }));
    expect(() => wikiPages(ancestorGhost, [])).toThrow('element "api" names element "ghost", which the model does not have');

    const categoryGhost = emptyModel();
    categoryGhost.elements.push(elementOf('api', 'service'));
    categoryGhost.relations.push(
      relationOf('r', 'api', 'api', { transfers: [{ direction: 'forward', confidentiality: 'internal', categories: ['ghost'] }] }),
    );
    expect(() => wikiPages(categoryGhost, [])).toThrow('relation "r" carries data category "ghost", which the model does not have');
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
    // The view set the renderer has on file for the reference system (kept
    // current by the views tests): its scopes are the views the pages name.
    const views = readdirSync(MERMAID_FOLDER)
      .filter((file) => file !== '_landscape.md')
      .map((file) => file.replace(/\.md$/, ''))
      .sort(byCodePoint);
    const pages = wikiPages(model as CompiledModel, views);

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
    // Every zone and category linked from its index page, in name order; a page per id behind each.
    expect(tableOf(pageOf(pages, 'zones'), ['Zone', 'Elements']).rows.map((row) => row[0])).toEqual([
      { page: 'zone/dmz', text: 'Demilitarised zone' },
      { page: 'zone/internal', text: 'Internal network' },
      { page: 'zone/pci', text: 'PCI DSS cardholder data environment' },
      { page: 'zone/internet', text: 'Public internet' },
    ]);
    expect(tableOf(pageOf(pages, 'data-categories'), ['Data category', 'Relations']).rows.map((row) => row[0])).toEqual([
      { page: 'data-category/order', text: 'Order data' },
      { page: 'data-category/payment-card', text: 'Payment card data' },
      { page: 'data-category/personal', text: 'Personal data' },
    ]);
    expect(pages.filter((page) => page.id.startsWith('zone/')).map((page) => page.id).sort()).toEqual([
      'zone/dmz',
      'zone/internal',
      'zone/internet',
      'zone/pci',
    ]);
    expect(pages.filter((page) => page.id.startsWith('data-category/')).map((page) => page.id).sort()).toEqual([
      'data-category/order',
      'data-category/payment-card',
      'data-category/personal',
    ]);

    // Scenario element-page: checkout-api's own page.
    const checkout = pageOf(pages, 'element/checkout-api');
    const summary = tableOf(checkout, ['Kind', 'Technology', 'Zones', 'Ancestors']);
    expect(summary.rows).toEqual([
      [
        'service',
        'TypeScript, NestJS',
        [{ page: 'zone/internal', text: 'Internal network' }],
        [{ page: 'domain/ordering', text: 'Ordering' }],
      ],
    ]);
    const outgoing = sectionTable(checkout, 'Outgoing relations');
    expect(outgoing.rows).toContainEqual([{ page: 'domain/payments', text: 'Payments' }, 'takes payment', '—', '—', '—']);

    // The nearest-view rule over the real view set: checkout-api has a view
    // of its own (it holds modules), the checkout-cart module takes the
    // nearest ancestor's, a top-level person and the home page fall back to
    // the landscape.
    const diagramOf = (id: string): WikiDiagramBlock | undefined => {
      const page = pageOf(pages, id);
      return page.blocks.find((block): block is WikiDiagramBlock => block.kind === 'diagram');
    };
    expect(diagramOf('home')).toEqual({ kind: 'diagram' });
    expect(diagramOf('element/checkout-api')).toEqual({ kind: 'diagram', scope: 'checkout-api' });
    expect(diagramOf('element/checkout-cart')).toEqual({ kind: 'diagram', scope: 'checkout-api' });
    expect(diagramOf('element/customer')).toEqual({ kind: 'diagram' });
    expect(diagramOf('domain/ordering')).toEqual({ kind: 'diagram', scope: 'ordering' });
  });
});

describe('wiki page diagrams', () => {
  /** The one diagram block a page carries, refusing a page without exactly one. */
  function diagramOf(page: WikiPage): WikiDiagramBlock {
    const diagrams = page.blocks.filter((block): block is WikiDiagramBlock => block.kind === 'diagram');
    expect(diagrams).toHaveLength(1);
    return diagrams[0]!;
  }

  test('home, domain and element pages each carry one diagram; the other pages carry none', () => {
    const pages = pagesOfModel(MODEL_YAML, ['ordering', 'checkout', 'payments']);
    const home = pageOf(pages, 'home');
    expect(diagramOf(home)).toEqual({ kind: 'diagram' });
    expect(home.blocks.slice(-2)).toEqual([{ kind: 'heading', level: 2, text: 'Landscape' }, { kind: 'diagram' }]);

    const ordering = pageOf(pages, 'domain/ordering');
    expect(diagramOf(ordering)).toEqual({ kind: 'diagram', scope: 'ordering' });
    expect(ordering.blocks[0]).toEqual({ kind: 'paragraph', text: 'The Ordering domain holds 3 elements.' });
    expect(ordering.blocks[1]).toEqual({ kind: 'diagram', scope: 'ordering' });

    // The view of the part itself, then its elements' nearest ancestors.
    expect(diagramOf(pageOf(pages, 'element/checkout'))).toEqual({ kind: 'diagram', scope: 'checkout' });
    expect(diagramOf(pageOf(pages, 'element/checkout-cart'))).toEqual({ kind: 'diagram', scope: 'checkout' });
    expect(diagramOf(pageOf(pages, 'element/orders-db'))).toEqual({ kind: 'diagram', scope: 'ordering' });
    expect(diagramOf(pageOf(pages, 'element/payments-api'))).toEqual({ kind: 'diagram', scope: 'payments' });

    for (const id of ['interfaces', 'zones', 'data-categories']) {
      expect(pageOf(pages, id).blocks.some((block) => block.kind === 'diagram')).toBe(false);
    }

    // A zone or category page carries no diagram either.
    const zoned = pagesOfModel(MODEL_WITH_ZONES_YAML, ['a-z', 'z-a']);
    for (const id of ['zones', 'zone/dmz', 'zone/internal', 'data-categories', 'data-category/cat-a']) {
      expect(pageOf(zoned, id).blocks.some((block) => block.kind === 'diagram')).toBe(false);
    }
  });

  test('the nearest ancestor with a view: a module whose own parent has none', () => {
    // Checkout holds no view here, so its cart takes the Ordering domain's.
    const pages = pagesOfModel(MODEL_YAML, ['ordering']);
    expect(diagramOf(pageOf(pages, 'element/checkout'))).toEqual({ kind: 'diagram', scope: 'ordering' });
    expect(diagramOf(pageOf(pages, 'element/checkout-cart'))).toEqual({ kind: 'diagram', scope: 'ordering' });
    expect(diagramOf(pageOf(pages, 'element/orders-db'))).toEqual({ kind: 'diagram', scope: 'ordering' });
  });

  test('an element with no view in its ancestry falls back to the landscape', () => {
    const pages = pagesOfModel(MODEL_WITH_ZONES_YAML, ['a-z', 'z-a']);
    expect(diagramOf(pageOf(pages, 'element/customer'))).toEqual({ kind: 'diagram' });
    expect(diagramOf(pageOf(pages, 'element/orders'))).toEqual({ kind: 'diagram' });
    expect(diagramOf(pageOf(pages, 'element/z-a'))).toEqual({ kind: 'diagram', scope: 'z-a' });
  });

  test('with no views at all every diagram is the landscape', () => {
    const pages = pagesOfModel();
    expect(diagramOf(pageOf(pages, 'home'))).toEqual({ kind: 'diagram' });
    expect(diagramOf(pageOf(pages, 'domain/ordering'))).toEqual({ kind: 'diagram' });
    expect(diagramOf(pageOf(pages, 'element/checkout-cart'))).toEqual({ kind: 'diagram' });
  });

  test('a child domain without children takes the view of the nearest ancestor that has one', () => {
    const yaml = [
      'version: 1',
      '',
      'elements:',
      '  - id: d1',
      '    kind: domain',
      '    name: Outer',
      '  - id: d2',
      '    kind: domain',
      '    name: Inner',
      '    parent: d1',
      '  - id: s1',
      '    kind: service',
      '    name: Zed',
      '    parent: d1',
      '',
    ].join('\n');
    const pages = pagesOfModel(yaml, ['d1']);
    expect(diagramOf(pageOf(pages, 'domain/d2'))).toEqual({ kind: 'diagram', scope: 'd1' });
  });

  test('a view naming an element the model does not have is an error naming it', () => {
    const repo = new Repo();
    repo.writeModel('model.yaml', MODEL_YAML);
    const { model, errors } = loadAndCompileModel(repo.path);
    expect(errors).toEqual([]);
    expect(() => wikiPages(model as CompiledModel, ['ghost'])).toThrow('the view set names element "ghost", which the model does not have');
  });
});
