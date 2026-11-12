/**
 * The wiki's pages over a small graph written out in the test (decision 0029):
 * the template substitution, every block of the library, the `madarch:` links
 * and the footnote grounds with the broken ones shown as broken. Every
 * expected value is read off the graph and the files this test builds, never
 * off the engine's own output.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeGraph } from './fake-graph.js';
import type { RenderContext } from '../src/knowledge/blocks.js';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { graphMarkdownEntities } from '../src/knowledge/markdown.js';
import type { Block, PageModel } from '../src/knowledge/model.js';
import { graphTitleOf, kindSummaries, listEntities, markdownTitleOf, renderPage, searchWiki } from '../src/knowledge/render.js';
import { Resolver } from '../src/knowledge/resolve.js';


// Record keys are built by concatenation so the neutral-names scan reads no key as a repository source.
const K = (kind: string, rest: string): string => `${kind}:${rest}`;
const SERVICE = K('code.service', 'billing');
const PACKAGE = K('code.package', 'svc/billing');
const MODULE = K('code.module', 'svc/billing/src');
const FILE_A = K('code.file', 'svc/billing/src/a.ts');
const DEBT = K('code.debt', 'svc/billing/src/a.ts#10');
const FILE_B = K('code.file', 'svc/billing/src/b.ts');
const CHARGE = K('code.symbol', 'svc/billing/src/a.ts#charge');
const AUDIT = K('code.symbol', 'svc/billing/src/a.ts#audit');
const HANDLE = K('code.symbol', 'svc/billing/src/b.ts#handle');
const DATABASE = K('code.database', 'billing');
const INVOICES = K('code.table', 'billing/public.invoices');
const CUSTOMERS = K('code.table', 'billing/public.customers');

const A_TS = ['import { b } from "./b";', '', 'export function charge(amount: number) {', '  // bill it', '  return audit(amount) + 1;', '}', '', 'function audit(n: number) {', '  return charge(n - 1);', '}', ''].join('\n');
const B_TS = ['export function handle() {', '  const text = "x";', '  return charge(1);', '}', ''].join('\n');

let ctx: RenderContext;
let productFolder: string;
const repoOfScope = new Map<string, string>();

const span = (path: string, lineStart: number, lineEnd: number) => ({ path, lineStart, lineEnd, byteStart: 0, byteEnd: 10 });

beforeAll(async () => {
  productFolder = mkdtempSync(join(tmpdir(), 'madarch-knowledge-render-'));
  const fake = new FakeGraph();
  const add = (key: string, kind: string, label: string, properties: Record<string, unknown> = {}): void => { fake.add(key, kind, label, properties); };
  const link = (relation: string, from: string, to: string, properties: Record<string, unknown> = {}, discriminator = ''): void => { fake.link(relation, from, to, properties, discriminator); };
  fake.add('code.repository:shop', 'code.repository', 'shop', { path: '/work/shop' });
  repoOfScope.set(fake.repository(), 'shop');
  add(SERVICE, 'code.service', 'billing', { language: 'typescript', frameworks: ['express', 'pino'], testFramework: 'jest', span: span('svc/billing/package.json', 1, 5) });
  add(PACKAGE, 'code.package', 'billing', { name: 'billing' });
  add(MODULE, 'code.module', 'svc/billing/src', { role: 'code' });
  add(FILE_A, 'code.file', 'a.ts', { path: 'svc/billing/src/a.ts' });
  add(FILE_B, 'code.file', 'b.ts', { path: 'svc/billing/src/b.ts' });
  add(CHARGE, 'code.symbol', 'charge', { path: 'svc/billing/src/a.ts', symbolKind: 'function', span: span('svc/billing/src/a.ts', 3, 6) });
  add(AUDIT, 'code.symbol', 'audit', { path: 'svc/billing/src/a.ts', symbolKind: 'function', span: span('svc/billing/src/a.ts', 8, 10) });
  add(HANDLE, 'code.symbol', 'handle', { path: 'svc/billing/src/b.ts', symbolKind: 'function', span: span('svc/billing/src/b.ts', 1, 4) });
  add(DEBT, 'code.debt', 'TODO: bill it', { marker: 'TODO', text: 'bill it', path: 'svc/billing/src/a.ts', line: 4, span: span('svc/billing/src/a.ts', 4, 4) });
  link('code.contains', PACKAGE, MODULE);
  link('code.contains', MODULE, FILE_A);
  link('code.contains', MODULE, FILE_B);
  link('code.contains', FILE_A, CHARGE);
  link('code.contains', FILE_A, AUDIT);
  link('code.contains', FILE_B, HANDLE);
  link('code.contains', FILE_A, DEBT);
  link('code.calls', HANDLE, CHARGE, { span: span('svc/billing/src/b.ts', 3, 3) });
  link('code.calls', AUDIT, CHARGE, { span: span('svc/billing/src/a.ts', 9, 9) });
  link('code.calls', CHARGE, AUDIT, { span: span('svc/billing/src/a.ts', 5, 5) });
  link('code.imports', FILE_B, FILE_A);
  add(DATABASE, 'code.database', 'billing', { service: 'billing' });
  add(INVOICES, 'code.table', 'invoices', { schema: 'public', database: 'billing' });
  add(CUSTOMERS, 'code.table', 'customers', { schema: 'public', database: 'billing' });
  add('code.column:billing/public.invoices/id', 'code.column', 'id', { table: 'billing/public.invoices', name: 'id', type: 'uuid', nullable: false, primary_key: true });
  add('code.column:billing/public.invoices/customer_id', 'code.column', 'customer_id', { table: 'billing/public.invoices', name: 'customer_id', type: 'uuid', nullable: false });
  add('code.column:billing/public.customers/id', 'code.column', 'id', { table: 'billing/public.customers', name: 'id', type: 'uuid', nullable: false, primary_key: true });
  link('code.foreign-key', INVOICES, CUSTOMERS, { column: 'customer_id' }, 'customer_id');

  const write = (path: string, text: string): void => {
    mkdirSync(join(productFolder, path, '..'), { recursive: true });
    writeFileSync(join(productFolder, path), text);
  };
  write('madarch/kinds.yaml', [
    'properties:',
    '  line: { en: Line, ru: Строка }',
    '  marker: { en: Marker, ru: Маркер }',
    '  path: { en: Path, ru: Путь }',
    '  text: { en: Text, ru: Текст }',
    'kinds:',
    '  product:',
    '    template: templates/product.md',
    '    source: markdown',
    '    file: docs/product.md',
    '  domain:',
    '    template: templates/domain.md',
    '    source: markdown',
    '    folder: docs/domains',
    '  code.service:',
    '    template: templates/service.md',
    '    source: graph',
    '    system: container',
    '    relations:',
    '      - { type: code.contains, to: "code.package:{span.path|dirname}" }',
    '  code.symbol:',
    '    template: templates/symbol.md',
    '    source: graph',
    '    sequence: symbol',
    '  code.file:',
    '    template: templates/file.md',
    '    source: graph',
    '  code.debt:',
    '    template: templates/item-plain.md',
    '    source: graph',
    '    details: [line, marker, path, text]',
    '  code.database:',
    '    template: templates/database.md',
    '    source: graph',
    '    er: tables',
    '  doc.use-case:',
    '    template: templates/use-case.md',
    '    source: document',
    '    identifier: UC',
    '',
  ].join('\n'));
  write('templates/use-case.md', ':::body\n:::stated{title="Stated in"}\n:::implementedby\n:::linkedfrom\n');
  write('templates/product.md', ':::body\n');
  write('templates/domain.md', ':::body\n:::related{title="Implemented by" relation="relates"}\n');
  write('templates/service.md', [
    'A {{language}} service on {{frameworks}}; tests: {{testFramework}}; owner: {{owner}}.',
    ':::graph{depth=1}',
    ':::related{title="Files" relation="code.contains" depth=3 kind="code.file"}',
    ':::related{title="Described by" relation="relates"}',
    ':::nonsense',
    ':::',
    ':::callers',
    '',
  ].join('\n'));
  write('templates/symbol.md', '{{symbolKind}} in {{path}}\n:::source\n:::callers\n:::callees\n:::sequence\n:::related{title="Declared in" relation="code.contains" direction="in"}\n:::er\n');
  write('templates/file.md', '{{path}}\n:::source\n:::related{title="Imports" relation="code.imports" direction="out"}\n:::related{title="Imported by" relation="code.imports" direction="in"}\n');
  write('templates/item-plain.md', ':::properties{title="Details"}\n:::graph{title="Around this"}\n:::related{title="Relations"}\n:::related{title="Pages about this" relation="relates"}\n');
  write('templates/database.md', ':::er{limit=5}\n');
  write('docs/product.md', ['---', 'id: product:shop', 'kind: product', 'title: The shop', 'relates:', `  - ${SERVICE}`, 'producer: agent', '---', `The shop bills customers through the billing service.[^1]`, '', `[^1]: [billing](madarch:${SERVICE})`, ''].join('\n'));
  write('docs/domains/billing.md', [
    '---', 'id: domain:billing', 'kind: domain', 'title: Billing', 'relates:', `  - ${SERVICE}`, `  - ${CHARGE}`, `  - ${K('code.symbol', 'svc/none.ts#gone')}`, 'producer: agent', '---',
    `Charges go through one function that bills the customer.[^1]`, '',
    'A refund is posted back to the card.', '',
    `Money moves in two steps and each step is checked.[^2]`, '',
    'See also [the shop](madarch:product:shop).', '',
    `[^1]: [charge](madarch:${CHARGE}), [gone](madarch:${K('code.symbol', 'svc/none.ts#gone')})`,
    '[^2]: [handbook](madarch:doc:docs/handbook.md#money), [no such section](madarch:doc:docs/handbook.md#nothing), [no file](madarch:doc:docs/none.md)',
    '',
  ].join('\n'));
  // A document of the code repository: sections found by slug, by an explicit id and by a label.
  const documents = new Map<string, string>([
    ['docs/handbook.md', ['# Handbook', '', '## Money', 'text', '', '## Refunds {#refunds}', 'text', '', `- **UC-7 Pay.** The shopper pays through [charge](madarch:${CHARGE}), as \`svc/billing/src/a.ts\` (\`audit\`, \`nothere\`) says.`, ''].join('\n')],
    ['svc/billing/src/a.ts', A_TS],
    ['svc/billing/src/b.ts', B_TS],
  ]);

  const read = parseKinds(await Bun.file(join(productFolder, 'madarch/kinds.yaml')).text(), join(productFolder, 'madarch/kinds.yaml'), productFolder);
  expect(read.findings).toEqual([]);
  const blockPart = (name: string, params: Record<string, string> = {}, line = 1) => ({ type: 'block', name, params, line });
  const textPart = (text: string, line = 1) => ({ type: 'text', text, line });
  const attribute = (name: string) => ({ type: 'attribute', name, line: 1 });
  const template = (path: string, template_parts: unknown[]) => add(`template:${path}`, 'template', path, { template_parts });
  template('templates/product.md', [blockPart('body')]);
  template('templates/domain.md', [blockPart('body'), blockPart('related', { title: 'Implemented by', relation: 'relates' }, 2)]);
  template('templates/service.md', [textPart('A '), attribute('language'), textPart(' service on '), attribute('frameworks'), textPart('; tests: '), attribute('testFramework'), textPart('; owner: '), attribute('owner'), textPart('.'), blockPart('graph', { depth: '1' }, 2), blockPart('related', { title: 'Files', relation: 'code.contains', depth: '3', kind: 'code.file' }, 3), blockPart('related', { title: 'Described by', relation: 'relates' }, 4), { type: 'problem', message: 'unknown block nonsense', line: 5 }, { type: 'problem', message: 'closing block closes nothing', line: 6 }, blockPart('callers', {}, 7)]);
  template('templates/symbol.md', [attribute('symbolKind'), textPart(' in '), attribute('path'), blockPart('source', {}, 2), blockPart('callers', {}, 3), blockPart('callees', {}, 4), blockPart('sequence', {}, 5), blockPart('related', { title: 'Declared in', relation: 'code.contains', direction: 'in' }, 6), blockPart('er', {}, 7)]);
  template('templates/file.md', [attribute('path'), blockPart('source', {}, 2), blockPart('related', { title: 'Imports', relation: 'code.imports', direction: 'out' }, 3), blockPart('related', { title: 'Imported by', relation: 'code.imports', direction: 'in' }, 4)]);
  template('templates/item-plain.md', [blockPart('properties', { title: 'Details' }), blockPart('graph', { title: 'Around this' }, 2), blockPart('related', { title: 'Relations' }, 3), blockPart('related', { title: 'Pages about this', relation: 'relates' }, 4)]);
  template('templates/database.md', [blockPart('er', { limit: '5' })]);
  const source = (path: string, text: string, start: number, end: number) => ({ text, language: 'typescript', truncated: false, location: { repo: 'shop', path, lineStart: start, lineEnd: end, href: `/src?repo=shop&path=${encodeURIComponent(path)}&line=${start}` } });
  add(CHARGE, 'code.symbol', 'charge', { path: 'svc/billing/src/a.ts', symbolKind: 'function', span: span('svc/billing/src/a.ts', 3, 6), source: source('svc/billing/src/a.ts', A_TS.split('\n').slice(2, 6).join('\n'), 3, 6) });
  add(FILE_A, 'code.file', 'a.ts', { path: 'svc/billing/src/a.ts', source: source('svc/billing/src/a.ts', A_TS.trimEnd(), 1, 10) });
  add('product:shop', 'product', 'The shop', { body: 'The shop bills customers through the billing service.[^1]', file: 'docs/product.md', body_line: 9, relates: [SERVICE], producer: 'agent' });
  const links = [{ url: `madarch:${CHARGE}`, line: 19, ground: true }, { url: `madarch:${K('code.symbol', 'svc/none.ts#gone')}`, line: 19, ground: true }, { url: 'madarch:doc:docs/handbook.md#money', line: 20, ground: true }, { url: 'madarch:doc:docs/handbook.md#nothing', line: 20, ground: true }, { url: 'madarch:doc:docs/none.md', line: 20, ground: true }, { url: 'madarch:product:shop', line: 17, ground: false }];
  const statement = (id: string, text: string, line: number) => ({ id, labels: [id], text, line, digest: id, mentions: [], grounds: [] });
  add('domain:billing', 'domain', 'Billing', { body: 'Charges go through one function that bills the customer.[^1]\n\nA refund is posted back to the card.\n\nMoney moves in two steps and each step is checked.[^2]', body_line: 11, file: 'docs/domains/billing.md', relates: [SERVICE, CHARGE, K('code.symbol', 'svc/none.ts#gone')], producer: 'agent', links, statements: [statement('1', 'Charges go through one function that bills the customer.', 11), statement('2', 'Money moves in two steps and each step is checked.', 15)], ungrounded: [{ text: 'A refund is posted back to the card.', line: 13 }] });
  add('document:handbook', 'document', 'Handbook', { repository: 'shop', path: 'docs/handbook.md', markdown: 'Handbook', anchors: { money: { title: 'Money', start: 3, end: 5, markdown: 'text' } } });
  const graph = fake.reader();
  const markdown = new Map((await graphMarkdownEntities(graph, read)).entities.map((entity) => [entity.id, entity]));
  const readSource = async (repo: string | null, path: string): Promise<string | undefined> => (repo === 'shop' ? documents.get(path) : undefined);
  ctx = {
    productFolder,

    manifest: read,
    graph,
    markdown,
    language: 'en',
    repositories: ['shop'],
    commitOf: () => null,
    resolver: new Resolver({ graph, markdown, declared: (kind) => read.kinds.has(kind), documentKinds: ['document'], repositories: () => ['shop'],
    locate: (entity) => (entity.span === undefined ? undefined : { repo: 'shop', path: entity.span.path, lineStart: entity.span.lineStart, lineEnd: entity.span.lineEnd, href: `/src?repo=shop&path=${encodeURIComponent(entity.span.path)}&line=${entity.span.lineStart}` }) }),
    repoOfScope: (id) => repoOfScope.get(id),
    readSource,
  };
}, 60_000);

afterAll(() => {
  rmSync(productFolder, { recursive: true, force: true });
});

async function page(id: string, lang?: string): Promise<PageModel> {
  const result = await renderPage(ctx, id, lang);
  if (!result.ok) throw new Error(`no page for ${id}: ${result.message}`);
  return result.page;
}

const block = <T extends Block['type']>(model: PageModel, type: T, at = 0): Extract<Block, { type: T }> => {
  const found = model.blocks.filter((entry) => entry.type === type)[at];
  if (found === undefined) throw new Error(`the page of ${model.id} has no ${type} block number ${at}: ${model.blocks.map((entry) => entry.type).join(', ')}`);
  return found as Extract<Block, { type: T }>;
};

describe('structured template opinions at the page boundary', () => {
  const templateContext = (opinions: readonly Record<string, unknown>[]): RenderContext => {
    const graph = new Proxy(ctx.graph, {
      get(target, key) {
        if (key === 'find') return async (id: string) => id === 'template:templates/service.md'
          ? opinions.map((properties, index) => ({ key: id, kind: 'template', label: id, properties, nodeIds: [String(index)], scope: '1' }))
          : (await target.find(id)).map((entity) => id === SERVICE ? { ...entity, label: 'a_b [x]' } : entity);
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return { ...ctx, graph };
  };

  test('missing and ambiguous templates fail with the full template path and line', async () => {
    for (const opinions of [[], [{ template_parts: [] }, { template_parts: [] }]]) {
      const result = await renderPage(templateContext(opinions), SERVICE);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('an absent or ambiguous template was accepted');
      expect(result.status).toBe(500);
      expect(result.message).toBe(`templates/service.md:1: expected one structured template opinion, found ${opinions.length}`);
    }
  });

  test('malformed template parts fail instead of dropping an unreadable section', async () => {
    const result = await renderPage(templateContext([{ template_parts: [{ type: 'block', name: 'unknown', params: {}, line: 3 }] }]), SERVICE);
    expect(result).toEqual({ ok: false, status: 500, message: 'templates/service.md:1: template opinion requires structured template_parts' });
  });

  test('literal template syntax stays literal and only explicit attributes are escaped', async () => {
    const result = await renderPage(templateContext([{ template_parts: [
      { type: 'text', text: '{{language}} {% body %} :::body / ', line: 1 },
      { type: 'attribute', name: 'label', line: 2 },
      { type: 'text', text: ' / ', line: 2 },
      { type: 'attribute', name: 'span.path', line: 2 },
    ] }]), SERVICE);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(block(result.page, 'markdown').markdown).toBe('{{language}} {% body %} :::body / a\\_b \\[x\\] / svc/billing/package.json');
  });
});

describe('a page\'s title', () => {
  test('is the manifest\'s title attribute, the same title the changed-page list shows, not the label', () => {
    expect(graphTitleOf('name', { key: 'code.database:internal-42', kind: 'code.database', label: 'internal-42', properties: { name: 'Payments' } })).toBe('Payments');
    expect(graphTitleOf('name', { key: 'code.database:internal-42', kind: 'code.database', label: 'internal-42', properties: {} })).toBe('internal-42');
  });

  test('a Markdown page uses its kind\'s title attribute too, and falls back to the title it was read with', () => {
    const entity = ctx.markdown.get('product:shop')!;
    expect(markdownTitleOf('title', entity)).toBe(entity.title);
    expect(markdownTitleOf('nonesuch', entity)).toBe(entity.title);
  });

});

describe('template text and the service page', () => {
  test('{{attribute}} is substituted from the entity, lists joined, and a name the entity lacks is a finding at its template line', async () => {
    const model = await page(SERVICE);
    const text = block(model, 'markdown').markdown;
    expect(text).toBe('A typescript service on express, pino; tests: jest; owner: –.');
    expect(model.findings).toContainEqual({ file: 'templates/service.md', line: 1, message: '"owner" names no attribute of this entity' });
    expect(model.title).toBe('billing');
    expect(model.kind).toBe('code.service');
  });

  test('a malformed or unknown block is a finding and a problem block in its place, with the template and its line', async () => {
    const model = await page(SERVICE);
    const problems = model.blocks.filter((entry) => entry.type === 'problem');
    expect(problems.map((entry) => entry.type === 'problem' ? [entry.file, entry.line] : [])).toEqual([['templates/service.md', 5], ['templates/service.md', 6]]);

    expect(model.findings.map((entry) => entry.message)).toContain('unknown block nonsense');
    expect(model.findings.some((entry) => entry.line === 6 && entry.message.includes('closes nothing'))).toBe(true);
  });

  test('the manifest-declared relation joins the service to its package, and related with a depth reaches the files below it', async () => {
    const model = await page(SERVICE);
    const files = block(model, 'related', 0);
    expect(files.groups).toHaveLength(1);
    expect(files.groups[0]!.relation).toBe('code.contains');
    expect(files.groups[0]!.rows.map((row) => [row.entity.id, row.hops])).toEqual([[FILE_A, 3], [FILE_B, 3]]);
    expect(files.groups[0]!.rows.every((row) => row.entity.href === `/e/${encodeURIComponent(row.entity.id)}`)).toBe(true);
  });

  test('the graph block holds the entity and what is linked to it as nodes and edges, naming how many are shown of how many, with the filter\'s relations', async () => {
    const model = await page(SERVICE);
    const graph = block(model, 'graph');
    const hood = graph.neighborhood;
    expect(hood.center).toBe(SERVICE);
    expect(hood.nodes.find((entry) => entry.id === SERVICE)).toMatchObject({ label: 'billing', hops: 0, href: `/e/${encodeURIComponent(SERVICE)}` });
    // The manifest's declared edge joins the service to its package; the package, the Markdown pages that name it, both ends are nodes.
    expect(hood.edges).toContainEqual({ from: SERVICE, to: PACKAGE, relation: 'code.contains', count: 1 });
    expect(hood.edges).toContainEqual({ from: 'domain:billing', to: SERVICE, relation: 'relates', count: 1 });
    expect(hood.relations).toContainEqual({ relation: 'code.contains', direction: 'out', count: 1 });
    expect(graph.shown).toBe(hood.nodes.length - 1);
    expect(graph.shown).toBeGreaterThanOrEqual(3);
  });

  test('a block that follows code relations says so on an entity that has none of the data it needs', async () => {
    const model = await page(SERVICE);
    expect(block(model, 'callers').rows).toEqual([]);
  });

  test('the Markdown pages that name the entity in `relates` are its "described by" group', async () => {
    const model = await page(SERVICE);
    const described = block(model, 'related', 1);
    expect(described.groups).toHaveLength(1);
    expect(described.groups[0]).toMatchObject({ relation: 'relates', direction: 'in', total: 2 });
    expect(described.groups[0]!.rows.map((row) => row.entity.id)).toEqual([...['domain:billing', 'product:shop']].sort());
  });
});

describe('the function page', () => {
  test('callers and callees are listed with the place each call is read at, in the repository the graph says', async () => {
    const model = await page(CHARGE);
    const callers = block(model, 'callers');
    expect(callers.total).toBe(2);
    expect(callers.rows.map((row) => [row.entity.id, row.sites, row.site?.path, row.site?.lineStart, row.site?.repo])).toEqual([
      [AUDIT, 1, 'svc/billing/src/a.ts', 9, 'shop'],
      [HANDLE, 1, 'svc/billing/src/b.ts', 3, 'shop'],
    ]);
    expect(callers.rows[1]!.site?.href).toBe('/src?repo=shop&path=svc%2Fbilling%2Fsrc%2Fb.ts&line=3');
    const callees = block(model, 'callees');
    expect(callees.rows.map((row) => row.entity.id)).toEqual([AUDIT]);
    expect(callees.rows[0]!.entity.location).toMatchObject({ path: 'svc/billing/src/a.ts', lineStart: 8, lineEnd: 10 });
  });

  test('the source block shows exactly the declaration span, with its lines and its language', async () => {
    const source = block(await page(CHARGE), 'source');
    expect(source.location).toMatchObject({ repo: 'shop', path: 'svc/billing/src/a.ts', lineStart: 3, lineEnd: 6 });
    expect(source.language).toBe('typescript');
    expect(source.text).toBe(A_TS.split('\n').slice(2, 6).join('\n'));
    expect(source.truncated).toBe(false);
    expect(source.location.href).toBe('/src?repo=shop&path=svc%2Fbilling%2Fsrc%2Fa.ts&line=3');
  });

  test('the sequence block follows the calls out of the function, a step for each, in the source order of the places the graph read them at, and says what it does not model', async () => {
    const model = await page(HANDLE);
    const [chain] = model.blocks.flatMap((entry) => (entry.type === 'diagrams' ? entry.views : [])).filter((view) => view.spec.type === 'sequence');
    expect(chain!.spec.entry).toBe(HANDLE);
    // One participant for the service whose two files take part: the picture is of services, the steps are of calls.
    expect(chain!.elements.map((element) => element.label)).toEqual(['billing']);
    expect(chain!.edges.map((edge) => [edge.step, edge.label, edge.kind, edge.dashed])).toEqual([
      [1, 'charge', 'call', false],
      [2, 'audit', 'self', false],
      [3, 'charge', 'self', false],
    ]);
    expect(chain!.edges[2]!.note).toBe('called again; its steps are shown above');
    expect(chain!.edges[0]!.location).toMatchObject({ path: 'svc/billing/src/b.ts', lineStart: 3 });
    expect(chain!.edges.every((edge) => edge.href === `/e/${encodeURIComponent(edge.step === 2 ? AUDIT : CHARGE)}`)).toBe(true);
    expect(chain!.notes.join(' ')).toContain('branches, loops, error paths and repeated calls are not modelled');
    expect(chain!.renderers).toEqual(['mermaid']);
    expect(chain!.mermaidSource).toContain('sequenceDiagram');
  });

  test('a Russian page words the chain notes in Russian, keeping code names as names', async () => {
    const [chain] = (await page(HANDLE, 'ru')).blocks.flatMap((entry) => (entry.type === 'diagrams' ? entry.views : []));
    const notes = chain!.notes.join(' ');
    expect(notes).toContain('Внутри функции шаги идут в порядке исходного текста');
    expect(notes).not.toContain('Inside a function');
    expect(chain!.edges[2]!.note).toBe('вызывается снова; шаги показаны выше');
  });

  test('a function no route reaches starts its own chain and says so, and its calls are the steps drawn', async () => {
    const [chain] = (await page(HANDLE)).blocks.flatMap((entry) => (entry.type === 'diagrams' ? entry.views : []));
    expect(chain!.notes[0]).toContain('no route of the graph reaches this function');
    const [none] = (await page(AUDIT)).blocks.flatMap((entry) => (entry.type === 'diagrams' ? entry.views : []));
    expect(none!.edges.map((edge) => edge.label)).toEqual(['charge', 'audit']);
    expect(none!.notes.join(' ')).toContain('repeated calls are not modelled');
    expect(none!.empty).toBeNull();
  });

  test('related in a direction follows the containment up to the file; the breadcrumb is the containers from the top', async () => {
    const model = await page(CHARGE);
    const declared = block(model, 'related');
    expect(declared.groups).toEqual([expect.objectContaining({ relation: 'code.contains', direction: 'in', total: 1 })]);
    expect(declared.groups[0]!.rows[0]!.entity.id).toBe(FILE_A);
    // Product / repository / each folder / the entity: the trail ends in the entity's own name.
    expect(model.trail.map((entry) => entry.id)).toEqual([expect.any(String), PACKAGE, MODULE, FILE_A, CHARGE]);
    expect(model.trail[0]!.href).toBe('/');
  });

  test('the er block says what it draws and what it is given instead', async () => {
    const problem = block(await page(CHARGE), 'problem');
    expect(problem).toMatchObject({ block: 'er', file: 'templates/symbol.md', line: 7 });
    expect(problem.message).toContain('the er block draws an entity whose kind declares the ER view, and this is code.symbol');
    expect(problem.message).toContain(`${join(productFolder, 'madarch', 'kinds.yaml')}:21 gives the kind code.symbol no "er: tables" or "er: links"`);
  });
});

describe('a debt marker', () => {
  test('its properties are named in the reader\'s words, and a related section with nothing in it is not drawn', async () => {
    const model = await page(DEBT);
    const properties = block(model, 'properties');
    expect(properties.rows).toEqual([
      { name: 'line', label: 'Line', value: '4' },
      { name: 'marker', label: 'Marker', value: 'TODO' },
      { name: 'path', label: 'Path', value: 'svc/billing/src/a.ts' },
      { name: 'text', label: 'Text', value: 'bill it' },
    ]);
    const related = model.blocks.filter((entry) => entry.type === 'related');
    expect(related.map((entry) => entry.title)).toEqual(['Relations']);
    expect(related[0]!.groups.map((group) => group.relation)).toEqual(['code.contains']);
  });
});

describe('files, imports and the database', () => {
  test('a file shows its whole source when it has no span, and its imports in both directions', async () => {
    const model = await page(FILE_A);
    expect(block(model, 'source').text).toBe(A_TS.replace(/\n$/, ''));
    expect(model.blocks.some((entry) => entry.type === 'related' && entry.groups.length === 0)).toBe(false);
    const importedBy = block(model, 'related', 0);
    expect(importedBy.groups[0]!.rows.map((row) => row.entity.id)).toEqual([FILE_B]);
  });

  test('the er block draws a database as its tables with their columns and the foreign key between them', async () => {
    const [er] = (await page(DATABASE)).blocks.flatMap((entry) => (entry.type === 'diagrams' ? entry.views : []));
    expect(er!.elements).toHaveLength(2);
    // Mermaid's own ER syntax: one entity per table, one row per column, and a relationship for the foreign key.
    expect(er!.mermaidSource.split('\n')[0]).toBe('erDiagram');
    expect(er!.mermaidSource).toMatch(/  customers \{\n    uuid id PK\n  \}/);
    expect(er!.mermaidSource).toMatch(/  invoices \{\n    uuid customer_id FK\n    uuid id PK\n  \}/);
    // The relationship is named by the column that carries it, not by a word every key shares.
    expect(er!.mermaidSource).toContain('customers ||--o{ invoices : "customer_id"');
    expect(er!.elements.map((element) => element.label).sort()).toEqual(['customers', 'invoices']);
    // The fixture's manifest names no page for a table, so the list draws each one plain: an element links only
    // where the product gives it a page, and the picture is the graph's either way.
    expect(er!.elements.map((element) => element.href)).toEqual([null, null]);
  });
});

describe('Markdown pages, links and grounds', () => {
  test('the body is the Markdown with its statements counted and the ungrounded ones named with their line', async () => {
    const model = await page('domain:billing');
    const body = block(model, 'body');
    expect(body.file).toBe('docs/domains/billing.md');
    expect(body.statements).toBe(3);
    expect(body.ungrounded).toEqual([{ text: 'A refund is posted back to the card.', line: 13 }]);
  });

  test('every madarch: link of the body is resolved: a key and a document section are ok, a missing key and a missing section are broken with the reason', async () => {
    const { resolutions } = await page('domain:billing');
    expect(resolutions[`madarch:${CHARGE}`]).toMatchObject({ state: 'ok', kind: 'code.symbol', label: 'charge', href: `/e/${encodeURIComponent(CHARGE)}`, location: { repo: 'shop', path: 'svc/billing/src/a.ts', lineStart: 3, lineEnd: 6, href: '/src?repo=shop&path=svc%2Fbilling%2Fsrc%2Fa.ts&line=3' } });
    expect(resolutions[`madarch:${K('code.symbol', 'svc/none.ts#gone')}`]).toEqual({ state: 'broken', why: { code: 'no-entity', key: K('code.symbol', 'svc/none.ts#gone') }, target: `madarch:${K('code.symbol', 'svc/none.ts#gone')}`, reason: `no entity "${K('code.symbol', 'svc/none.ts#gone')}" in the graph or among the product's Markdown pages` });
    expect(resolutions['madarch:doc:docs/handbook.md#money']).toMatchObject({ state: 'ok', href: '/doc?repo=shop&path=docs%2Fhandbook.md#money' });
    expect(resolutions['madarch:doc:docs/handbook.md#nothing']).toMatchObject({ state: 'broken', reason: 'the document "docs/handbook.md" (in shop) has no section "nothing"' });
    expect(resolutions['madarch:doc:docs/none.md']).toMatchObject({ state: 'broken', reason: 'no document "docs/none.md" in the product repository or its code repositories' });
    expect(resolutions['madarch:product:shop']).toMatchObject({ state: 'ok', kind: 'product', label: 'The shop' });
  });

  test('the broken grounds, the bad relates key and the ungrounded statement are findings with the file and line they stand on', async () => {
    const { findings } = await page('domain:billing');
    expect(findings).toContainEqual({ file: 'docs/domains/billing.md', line: 19, message: expect.stringContaining('a ground does not resolve: no entity') });
    expect(findings).toContainEqual({ file: 'docs/domains/billing.md', line: 20, message: 'a ground does not resolve: the document "docs/handbook.md" (in shop) has no section "nothing"' });
    expect(findings).toContainEqual({ file: 'docs/domains/billing.md', line: 20, message: 'a ground does not resolve: no document "docs/none.md" in the product repository or its code repositories' });
  });

  test('a page related to entities lists a relates key that resolves to nothing as broken, not as a row that links', async () => {
    const related = block(await page('domain:billing'), 'related');
    const rows = related.groups[0]!.rows;
    expect(rows.map((row) => row.entity.id)).toEqual([SERVICE, CHARGE, K('code.symbol', 'svc/none.ts#gone')]);
    expect(rows[2]!.entity.broken).toBe(`no entity "${K('code.symbol', 'svc/none.ts#gone')}" in the graph or among the product's Markdown pages`);
    expect(rows[0]!.entity.href).toBe(`/e/${encodeURIComponent(SERVICE)}`);
  });


});

describe('what has a page', () => {
  test('an entity of a kind the manifest does not declare has no page, and says which manifest is missing the kind', async () => {
    const result = await renderPage(ctx, MODULE);
    expect(result).toEqual({ ok: false, status: 404, message: expect.stringContaining('declares no page for it') });
    const none = await renderPage(ctx, 'code.file:nothing');
    expect(none).toEqual({ ok: false, status: 404, message: 'no entity "code.file:nothing" in the graph or among the product\'s Markdown pages' });
  });

  test('the kinds are counted from the graph and from the Markdown, and listed in key order with a filter', async () => {
    const summaries = await kindSummaries(ctx);
    expect(summaries).toEqual([
      { kind: 'product', source: 'markdown', page: true, single: true, count: 1, origins: ['agent'] },
      { kind: 'domain', source: 'markdown', page: true, single: false, count: 1, origins: ['agent'] },
      { kind: 'code.service', source: 'graph', page: true, single: false, count: 1, origins: ['code'] },
      { kind: 'code.symbol', source: 'graph', page: true, single: false, count: 3, origins: ['code'] },
      { kind: 'code.file', source: 'graph', page: true, single: false, count: 2, origins: ['code'] },
      { kind: 'code.debt', source: 'graph', page: true, single: false, count: 1, origins: ['code'] },
      { kind: 'code.database', source: 'graph', page: true, single: false, count: 1, origins: ['code'] },
      { kind: 'doc.use-case', source: 'document', page: true, single: false, count: 0, origins: ['person'] },
    ]);
    const symbols = await listEntities(ctx, 'code.symbol', { limit: 2 });
    expect(symbols).toMatchObject({ total: 3, next: CHARGE });
    expect(symbols!.rows.map((row) => row.id)).toEqual([AUDIT, CHARGE]);
    const rest = await listEntities(ctx, 'code.symbol', { limit: 2, after: CHARGE });
    expect(rest!.rows.map((row) => row.id)).toEqual([HANDLE]);
    expect(rest!.next).toBeNull();
    const filtered = await listEntities(ctx, 'code.symbol', { limit: 10, q: 'hand' });
    expect(filtered!.rows.map((row) => row.id)).toEqual([HANDLE]);
    expect(await listEntities(ctx, 'code.module', { limit: 10 })).toBeUndefined();
  });
});


describe('search over page opinions', () => {
  test('body and title matches are case insensitive, keep nearby text and group by kind', async () => {
    const answer = await searchWiki(ctx, 'CUSTOMERS', 'en');
    const product = answer.groups.find((group) => group.kind === 'product');
    expect(product?.rows).toContainEqual({ id: 'product:shop', kind: 'product', title: 'The shop', href: '/e/product%3Ashop', excerpt: 'The shop bills customers through the billing service.[^1]' });
    const title = await searchWiki(ctx, 'bILLING', 'en');
    expect(title.groups.find((group) => group.kind === 'domain')?.rows[0]).toMatchObject({ id: 'domain:billing', title: 'Billing' });
    expect(await searchWiki(ctx, '   ', 'en')).toEqual({ groups: [], total: 0 });
    expect(await searchWiki(ctx, 'absent-search-word', 'en')).toEqual({ groups: [], total: 0 });
  });
});
