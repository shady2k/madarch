import { describe, expect, test } from 'bun:test';
import { loadAndCompileModel } from '../src/model/load-and-compile.js';
import type { CompiledModel } from '../src/model/compile.js';
import { wikiPages, type WikiPage, type WikiTableBlock } from '../src/wiki/pages.js';
import { Repo } from './model-check-repo.js';

/**
 * The wiki's engine-neutral page data (docs/changes/wiki/capabilities/wiki.md,
 * requirement pages, home and domain parts): the home page names every domain
 * and holds the model's counts, and every domain has a page listing its
 * elements with kind and technology. The expected pages below are written by
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

function pagesOfModel(): WikiPage[] {
  const repo = new Repo();
  repo.writeModel('model.yaml', MODEL_YAML);
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

  test('a domain page lists its elements with kind and technology, sorted by name', () => {
    const pages = pagesOfModel();
    const ordering = pageOf(pages, 'domain/ordering');
    expect(ordering.title).toBe('Ordering');
    expect(ordering.nav).toEqual(['Domains']);
    const paragraphs = ordering.blocks.filter((block) => block.kind === 'paragraph');
    expect(paragraphs.some((block) => block.kind === 'paragraph' && block.text === 'The Ordering domain holds 3 elements.')).toBe(true);
    const elements = tableOf(ordering, ['Element', 'Kind', 'Technology']);
    expect(elements.rows).toEqual([
      ['Checkout', 'service', 'TypeScript'],
      ['Cart', 'module', '—'],
      ['Orders database', 'store', '—'],
    ]);

    const payments = pageOf(pages, 'domain/payments');
    const paymentsRows = tableOf(payments, ['Element', 'Kind', 'Technology']);
    expect(paymentsRows.rows).toEqual([['Payments', 'service', 'Go']]);
  });

  test('there is exactly one page per domain and no page besides the home and the domains', () => {
    const pages = pagesOfModel();
    expect(pages.map((page) => page.id).sort()).toEqual(['domain/ordering', 'domain/payments', 'home']);
  });

  test('every link on every page names a page of the same set', () => {
    const pages = pagesOfModel();
    const ids = new Set(pages.map((page) => page.id));
    for (const page of pages) {
      for (const block of page.blocks) {
        if (block.kind !== 'table') continue;
        for (const row of block.rows) {
          for (const cell of row) {
            if (typeof cell !== 'string') expect(ids.has(cell.page)).toBe(true);
          }
        }
      }
    }
  });
});
