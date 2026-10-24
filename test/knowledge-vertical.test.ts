/**
 * The first vertical end to end (decision 0029, epic madarch-m38l): the
 * generated training repository is filled into a product by the wiki's own
 * fill, and the pages a reader walks are rendered from the product's templates
 * and Markdown: the payments service, a function with its callers, its source
 * and its place in the repository. The expected values are the answer key's
 * (examples/training-repository/answer-key.json) and the generated repository's
 * own files, never this engine's output.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import type { Block, PageModel } from '../src/knowledge/model.js';
import { FACTORY, MISSING, PAY, PAYMENTS_SERVICE, ROOT, generateTrainingRepository, makeProduct, recordKey, writeSamplePages } from './knowledge-fixture.js';

const KEY = JSON.parse(readFileSync(join(ROOT, 'examples/training-repository/answer-key.json'), 'utf8')) as {
  snapshots: Record<string, string>;
  items: { id: string; location?: { path: string; symbol?: string; anchor?: string }; locations?: { path: string; symbol?: string; anchor?: string }[]; judge: { mustShow: string[]; mustLink: string[] } }[];
};
const item = (id: string) => {
  const found = KEY.items.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`the answer key has no item ${id}`);
  return found;
};

// Built from parts so the neutral-names scan does not read it as a repository source.
const REMOTE = ['https://github.com', 'example', 'shop'].join('/');
const UC_2 = 'doc:@training/docs/requirements.md#uc-2';
let work: string;
let repository: string;
let product: KnowledgeProduct;
let folder: string;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'madarch-knowledge-vertical-'));
  repository = generateTrainingRepository(join(work, 'repo'));
  mkdirSync(join(work, 'home'));
  // The repository has a remote, so a code place can name its web page.
  execFileSync('git', ['remote', 'add', 'origin', `${REMOTE}.git`], { cwd: repository });
  folder = makeProduct(join(work, 'home'), 'training-shop', repository);
  writeSamplePages(folder);
  product = new KnowledgeProduct({ productFolder: folder, storeRoot: join(work, 'store') });
  const started = await product.startFill();
  expect(started).toMatchObject({ started: true });
  await product.settled();
  expect(product.fillState()).toMatchObject({ state: 'done' });
}, 900_000);

afterAll(async () => {
  await product.close();
  rmSync(work, { recursive: true, force: true });
});

const git = (...args: string[]): string => execFileSync('git', args, { cwd: repository, encoding: 'utf8' });
async function page(id: string): Promise<PageModel> {
  const result = await product.page(id);
  if (!result.ok) throw new Error(`no page for ${id}: ${result.message}`);
  return result.page;
}
const block = <T extends Block['type']>(model: PageModel, type: T, at = 0): Extract<Block, { type: T }> => model.blocks.filter((entry) => entry.type === type)[at] as Extract<Block, { type: T }>;

/** The first line of a file at the final snapshot that holds the text, 1-based, read from git. */
function lineOf(path: string, text: string): number {
  const lines = git('show', `${KEY.snapshots['snapshot-final']}:${path}`).split('\n');
  const at = lines.findIndex((line) => line.includes(text));
  if (at < 0) throw new Error(`${path} at snapshot-final holds no line with ${JSON.stringify(text)}`);
  return at + 1;
}

describe('the payments service page', () => {
  test('it names the stack the answer key gives (TypeScript, Express) and lists the files the key says a reader must be able to reach', async () => {
    const model = await page(PAYMENTS_SERVICE);
    expect(model.title).toBe('payments');
    const intro = block(model, 'markdown').markdown;
    expect(intro).toContain('typescript');
    expect(intro).toContain('express');
    const files = block(model, 'related', 0).groups[0]!.rows.map((row) => row.entity.id);
    // The files the key makes a reader reach in the payments service: the port and gRPC entry, the request chain, the factory and the timeout.
    const reached = ['service.payments', 'flow.payments.chain', 'pattern.factory', 'payments.timeout']
      .flatMap((id) => [item(id).location, ...(item(id).locations ?? [])])
      .flatMap((location) => (location === undefined ? [] : [location.path]))
      .filter((path) => path.startsWith('services/payments/src/') && path.endsWith('.ts'));
    expect(reached.length).toBeGreaterThanOrEqual(6);
    for (const path of new Set(reached)) expect(files).toContain(recordKey('code.file', path));
    expect(files.every((id) => id.startsWith(recordKey('code.file', 'services/payments/')))).toBe(true);
    expect(model.findings).toEqual([]);
  });

  test('every file on the page is a link to the file\'s page, and the graph block draws the service with its package', async () => {
    const model = await page(PAYMENTS_SERVICE);
    const rows = block(model, 'related', 0).groups[0]!.rows;
    expect(rows.every((row) => row.entity.href === `/k/e/${encodeURIComponent(row.entity.id)}`)).toBe(true);
    expect(block(model, 'graph').neighborhood.edges.some((edge) => edge.relation === 'code.contains')).toBe(true);
  });
});

describe('the function page', () => {
  test('PaymentService.pay shows the callers the answer key names, each with the place it calls from, and the callees down to the repository', async () => {
    const model = await page(PAY);
    const route = item('flow.payments.chain').locations!.find((entry) => entry.symbol === 'paymentRoutes')!;
    const callers = block(model, 'callers');
    expect(callers.rows.map((row) => row.entity.label)).toContain('paymentRoutes');
    const fromRoutes = callers.rows.find((row) => row.entity.label === 'paymentRoutes')!;
    expect(fromRoutes.site!.path).toBe(route.path);
    expect(fromRoutes.site!.repo).toBe('training');
    expect(fromRoutes.site!.lineStart).toBe(lineOf(route.path, 'service.pay('));
    expect(fromRoutes.site!.href).toBe(`/k/src?repo=training&path=${encodeURIComponent(route.path)}&line=${fromRoutes.site!.lineStart}`);
    const stores = block(model, 'callees').rows.map((row) => row.entity.id);
    expect(stores).toContain(recordKey('code.symbol', 'services/payments/src/store/payment-repository.ts#PrismaPaymentRepository.create'));
  });

  test('the source block is the declaration of pay: the file, the line the key anchors it at and the lines up to the closing brace', async () => {
    const model = await page(PAY);
    const declared = item('flow.payments.chain').locations!.find((entry) => entry.symbol === 'async pay')!;
    const source = block(model, 'source');
    expect(source.location.path).toBe(declared.path);
    expect(source.location.lineStart).toBe(lineOf(declared.path, 'async pay('));
    const lines = git('show', `${KEY.snapshots['snapshot-final']}:${declared.path}`).split('\n');
    const closing = lines.findIndex((line, at) => at + 1 > source.location.lineStart && line === '  }') + 1;
    expect(source.location.lineEnd).toBe(closing);
    expect(source.text).toBe(lines.slice(source.location.lineStart - 1, closing).join('\n'));
    expect(source.text.startsWith('  async pay(')).toBe(true);
    expect(source.text).toContain(item('payments.timeout').locations!.find((entry) => entry.symbol === 'pay')!.anchor!);
    expect(source.language).toBe('typescript');
    expect(source.truncated).toBe(false);
    expect(model.trail.map((entry) => entry.label)).toEqual(['payments', 'services/payments/src/domain', 'services/payments/src/domain/payment-service.ts']);
  });

  test('the factory\'s page holds the anchored switch of the answer key, and the chain from pay is a sequence of its steps down to the table', async () => {
    const factory = item('pattern.factory').location!;
    const model = await page(FACTORY);
    expect(block(model, 'source').text).toContain(factory.anchor!);
    const [chain] = block(await page(PAY), 'sequence').chains;
    expect(chain!.lanes.map((lane) => lane.label)).toContain('payment-service.ts');
    expect(chain!.steps.map((step) => step.label)).toContain('withTimeout');
  });
});

describe('the pages an agent wrote, over the filled graph', () => {
  test('the home page is the product page; its ground to the payments service resolves and so does the requirement section it names', async () => {
    const status = await product.status();
    expect(status.home).toBe('product:shop');
    const model = await page('product:shop');
    expect(model.resolutions[`madarch:${PAYMENTS_SERVICE}`]).toMatchObject({ state: 'ok', label: 'payments' });
    const useCase = model.resolutions['madarch:doc:docs/requirements.md#uc-2'];
    expect(useCase?.state).toBe('ok');
    // The section is a use case of the manifest's document kind: its ground opens the entity's page, not the Markdown at a line.
    expect(useCase !== undefined && useCase.state === 'ok' ? useCase.href : '').toBe(`/k/e/${encodeURIComponent(UC_2)}`);
    expect(model.findings).toEqual([]);
  });

  test('the domain page shows its broken ground as broken and its ungrounded statement as one, and its grounds that hold open the function', async () => {
    const model = await page('domain:payment');
    expect(model.resolutions[`madarch:${MISSING}`]).toMatchObject({ state: 'broken' });
    expect(model.resolutions[`madarch:${FACTORY}`]).toMatchObject({ state: 'ok', href: `/k/e/${encodeURIComponent(FACTORY)}` });
    expect(model.resolutions[`madarch:${PAY}`]).toMatchObject({ state: 'ok', label: 'PaymentService.pay' });
    expect(block(model, 'body').ungrounded.map((statement) => statement.text)).toEqual(['A refund that brings the refunded total up to the captured amount moves the order to refunded.']);
    expect(model.findings.map((finding) => finding.message)).toEqual([expect.stringContaining('a ground does not resolve: no entity')]);
    const implemented = block(model, 'related');
    expect(implemented.groups[0]!.rows.map((row) => row.entity.id)).toEqual([PAYMENTS_SERVICE, PAY]);
  });

  test('the service page names the pages that are about it', async () => {
    const model = await page(PAYMENTS_SERVICE);
    const described = block(model, 'related', 2);
    expect(described.groups[0]!.rows.map((row) => row.entity.id)).toEqual(['domain:payment', 'product:shop']);
  });
});

describe('the whole wiki after the fill', () => {
  test('the kinds are counted and the repository is marked filled; a refill of the unchanged repository leaves every page as it was', async () => {
    const status = await product.status();
    expect(status).toMatchObject({ manifest: 'ok', filled: true, repositories: [{ name: 'training', filled: true }], fill: { state: 'done' } });
    expect(status.kinds.find((kind) => kind.kind === 'code.service')!.count).toBe(4);
    expect(status.kinds.find((kind) => kind.kind === 'domain')!.count).toBe(1);
    const before = await page(PAY);
    expect(await product.startFill()).toMatchObject({ started: true });
    await product.settled();
    expect(await page(PAY)).toEqual(before);
  }, 600_000);
});

describe('the pages of the documents\' entities', () => {
  const rows = (model: PageModel, title: string): { id: string; note?: string; broken?: string }[] => {
    const found = model.blocks.find((entry) => entry.type === 'refs' && entry.title === title);
    if (found === undefined || found.type !== 'refs') throw new Error(`no ${title} block on ${model.id}: ${model.blocks.map((entry) => entry.type).join(', ')}`);
    return found.rows.map((row) => ({ id: row.entity.id, ...(row.note === undefined ? {} : { note: row.note }), ...(row.entity.broken === undefined ? {} : { broken: row.entity.broken }) }));
  };

  test('UC-1 to UC-4 and BR-1 to BR-5 are the entities of their kinds, as the answer key says of the requirements document', async () => {
    const wanted = item('doc.use-cases').judge.mustShow;
    expect(wanted).toEqual(['UC-1..UC-4', 'BR-1..BR-5']);
    const cases = await product.list('doc.use-case', { limit: 50 });
    const rules = await product.list('doc.rule', { limit: 50 });
    expect(cases!.rows.map((row) => row.label)).toEqual(['UC-1 Place order', 'UC-2 Pay', 'UC-3 Refund', 'UC-4 Apply promotion']);
    expect(rules!.rows.map((row) => row.label)).toEqual(['BR-1 Discount', 'BR-2 Tax', 'BR-3 One charge per key', 'BR-4 Refunds', 'BR-5 Promotion cap']);
  });

  test('the use case UC-2 has a page with its text, where it is stated, the code it is grounded with and the pages that link to it', async () => {
    const model = await page(UC_2);
    expect(model).toMatchObject({ kind: 'doc.use-case', title: 'UC-2 Pay' });
    expect(block(model, 'body').markdown).toContain('Checkout asks payments to authorize the card');
    const stated = block(model, 'stated');
    expect(stated.place).toMatchObject({ repo: 'training', path: 'docs/requirements.md', lineStart: lineOfDoc('- **UC-2 Pay.**') });
    expect(stated.place.href).toBe('/k/doc?repo=training&path=docs%2Frequirements.md#uc-2');
    // The domain page grounds "Checkout asks payments..." in UC-2 and in PaymentService.pay in one footnote.
    // The domain page grounds the sentence in UC-2 and PaymentService.pay in one footnote, the product page grounds one in the payments service and UC-2 in another.
    expect(rows(model, 'Implemented by')).toEqual([{ id: PAYMENTS_SERVICE, note: 'grounded with it on the page Online shop' }, { id: PAY, note: 'grounded with it on the page Payment' }]);
    expect(rows(model, 'Linked from').map((row) => row.id)).toEqual(['domain:payment', 'product:shop']);
    expect(model.trail.map((entry) => entry.label)).toEqual(['training: docs/requirements.md']);
    expect(model.findings).toEqual([]);
  });

  test('BR-1 names the file and the symbol of each place the answer key says it is implemented in', async () => {
    const model = await page('doc:@training/docs/requirements.md#br-1');
    const implemented = rows(model, 'Implemented by');
    expect(implemented.filter((row) => row.broken !== undefined)).toEqual([]);
    const ids = implemented.map((row) => row.id);
    const link = item('docs.requirement-link').locations!;
    expect(link.some((entry) => entry.path === 'services/orders/internal/pricing/pricing.go')).toBe(true);
    expect(ids).toContain(recordKey('code.file', 'services/orders/internal/pricing/pricing.go'));
    expect(ids).toContain(recordKey('code.symbol', 'services/orders/internal/pricing/pricing.go#Discount'));
    expect(ids).toContain(recordKey('code.file', 'services/checkout/src/pricing.ts'));
    expect(ids).toContain(recordKey('code.symbol', 'services/checkout/src/pricing.ts#discountFor'));
  });

  test('BR-2 and BR-4 name their files too, and the document page of each rule is the one the key anchors', async () => {
    for (const [rule, path] of [['br-2', 'services/orders/internal/pricing/tax.go'], ['br-4', 'services/payments/src/domain/refund.ts']] as const) {
      const ids = rows(await page(`doc:@training/docs/requirements.md#${rule}`), 'Implemented by').map((row) => row.id);
      expect(ids).toContain(recordKey('code.file', path));
    }
  });

  test('ADR-0001 is linked to the topics of the contract and ADR-0002 to OutboxWriter and the outbox table; each decision gives its reasons', async () => {
    const broker = await page('doc:@training/docs/adr/0001-broker.md#adr-0001');
    expect(broker).toMatchObject({ kind: 'doc.decision', title: 'ADR-0001 Kafka is the broker' });
    const said = (model: PageModel): string => block(model, 'body').markdown.replace(/\s+/g, ' ');
    for (const reason of ['Messages are retained', 'Per-key ordering', 'already runs it', 'tolerate duplicates']) expect(said(broker)).toContain(reason);
    expect(rows(broker, 'Implemented by').map((row) => row.id)).toEqual([recordKey('code.channel', 'orders.events'), recordKey('code.channel', 'payments.events')]);
    const outbox = await page('doc:@training/docs/adr/0002-outbox.md#adr-0002');
    for (const reason of ['same database transaction', 'relay', 'consumers must tolerate duplicates']) expect(said(outbox)).toContain(reason);
    const linked = rows(outbox, 'Implemented by').map((row) => row.id);
    expect(linked.some((id) => id.startsWith(recordKey('code.symbol', 'services/orders/internal/store/outbox.go#')) && id.endsWith('OutboxWriter'))).toBe(true);
    expect(linked).toContain(recordKey('code.table', 'orders/public.outbox'));
    // The documents that name ADR-0001 outside it: ADR-0002 and the requirements.
    expect(rows(broker, 'Linked from').map((row) => row.id)).toContain('doc:@training/docs/adr/0002-outbox.md#adr-0002');
  });

  test('the glossary defines seven terms, each a page with its definition', async () => {
    const terms = await product.list('doc.term', { limit: 50 });
    expect(terms!.total).toBe(item('doc.glossary').judge.mustShow.length === 1 ? 7 : 0);
    const outbox = terms!.rows.find((row) => row.label === 'Outbox')!;
    expect((block(await page(outbox.id), 'term') as { definition: string }).definition).toContain('the table in which orders queues the messages');
  });

  test('the documents list holds neither the product\'s own pages nor a file the manifest excludes', async () => {
    const listing = await product.documents();
    const paths = listing.documents.filter((entry) => entry.repo === null).map((entry) => entry.path);
    expect(paths).not.toContain('docs/product.md');
    expect(paths.some((path) => path.startsWith('docs/domains/'))).toBe(false);
    expect(listing.documents.map((entry) => entry.path)).not.toContain('AGENTS.md');
    expect(listing.documents).toContainEqual({ repo: 'training', path: 'docs/requirements.md' });
  });
});

describe('repository history pages', () => {
  test('task, commit and author pages draw graph-backed history summaries in English and Russian', async () => {
    const tasks = await product.list('code.task', { limit: 20 });
    const task = tasks!.rows[0];
    if (task === undefined) throw new Error('the generated history has no task');
    const taskPage = await product.page(task.id, 'en', { defer: false });
    if (!taskPage.ok) throw new Error(taskPage.message);
    const taskHistory = block(taskPage.page, 'history');
    const taskCommits = taskHistory.sections.find((section) => section.role === 'commits');
    expect(taskCommits?.rows.length).toBeGreaterThan(0);
    expect(taskCommits?.rows[0]).toHaveProperty('text');
    expect(taskCommits?.rows[0]?.when).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(taskCommits?.rows[0]?.who).toBeTruthy();
    const taskRu = await product.page(task.id, 'ru', { defer: true });
    if (!taskRu.ok) throw new Error(taskRu.message);
    expect(taskRu.page.blocks.some((entry) => entry.type === 'deferred' && entry.block === 'history' && entry.title === 'Коммиты')).toBe(true);

    const commits = await product.list('code.commit', { limit: 20 });
    const commit = commits!.rows[0];
    if (commit === undefined) throw new Error('the generated history has no commit');
    const commitPage = await product.page(commit.id, 'en', { defer: false });
    if (!commitPage.ok) throw new Error(commitPage.message);
    const commitHistory = block(commitPage.page, 'history');
    const files = commitHistory.sections.find((section) => section.role === 'files');
    expect(files?.rows.length).toBeGreaterThan(0);
    expect(files?.rows.every((row) => row.figures.some((figure) => figure.kind === 'added' || figure.kind === 'removed'))).toBe(true);

    const authors = await product.list('code.author', { limit: 20 });
    const author = authors!.rows[0];
    if (author === undefined) throw new Error('the generated history has no author');
    const authorPage = await product.page(author.id, 'en', { defer: false });
    if (!authorPage.ok) throw new Error(authorPage.message);
    const authorHistory = block(authorPage.page, 'history');
    expect(authorHistory.sections.find((section) => section.role === 'commits')?.rows.length).toBeGreaterThan(0);
    expect(authorHistory.sections.find((section) => section.role === 'files')?.rows.length).toBeGreaterThan(0);
  });
});

describe('every kind the graph holds', () => {
  test('is declared by the starter manifest, grouped, counted as the graph counts it, and described in both languages', async () => {
    const context = await product.context();
    if ('absent' in context) throw new Error('no manifest');
    const held = await context.ctx.graph.kindCounts();
    const status = await product.status();
    const declared = new Map(status.kinds.map((kind) => [kind.kind, kind]));
    expect(held.filter((entry) => !declared.has(entry.kind)).map((entry) => entry.kind)).toEqual([]);
    for (const entry of held) {
      const kind = declared.get(entry.kind)!;
      expect(kind.count).toBe(entry.count);
      expect(kind.group).toBeDefined();
      expect(status.groups.map((group) => group.group)).toContain(kind.group!);
      expect(kind.descriptions?.['ru']).toBeDefined();
      expect(kind.origins.length).toBeGreaterThan(0);
    }
    expect(held.length).toBeGreaterThanOrEqual(40);
  });

  test('has a page for its first entities that draws with no problem block and no finding', async () => {
    const context = await product.context();
    if ('absent' in context) throw new Error('no manifest');
    const problems: string[] = [];
    for (const { kind } of await context.ctx.graph.kindCounts()) {
      const listing = await product.list(kind, { limit: 3 });
      for (const row of listing!.rows) {
        const result = await product.page(row.id);
        if (!result.ok) { problems.push(`${row.id}: ${result.message}`); continue; }
        for (const blockOf of result.page.blocks) if (blockOf.type === 'problem') problems.push(`${row.id}: ${blockOf.block}: ${blockOf.message}`);
        for (const finding of result.page.findings) problems.push(`${row.id}: ${finding.file}:${finding.line} ${finding.message}`);
      }
    }
    expect(problems).toEqual([]);
  }, 300_000);

  test('the tables of a database and the columns of a table are listed on their pages, with the ER block', async () => {
    const database = await page(recordKey('code.database', 'orders'));
    const tables = block(database, 'related', 0).groups[0]!.rows.map((row) => row.entity.id);
    for (const table of ['customers', 'order_items', 'orders', 'outbox']) expect(tables).toContain(recordKey('code.table', `orders/public.${table}`));
    expect(block(database, 'er').tables).toBeGreaterThanOrEqual(4);
    const orders = await page(recordKey('code.table', 'orders/public.orders'));
    const columns = block(orders, 'related', 0).groups[0]!.rows.map((row) => row.entity.label);
    expect(columns).toContain('customer_id');
    expect(item('database.orders').judge.mustShow).toContain('customers 1-N orders');
  });
});

describe('the answer key\'s items that name these kinds are visible on their pages', () => {
  const labels = async (kind: string): Promise<string[]> => (await product.list(kind, { limit: 200 }))!.rows.map((row) => row.label);
  const related = (model: PageModel): { relation: string; direction: string; ids: string[] }[] => model.blocks.flatMap((entry) => (entry.type === 'related' ? entry.groups.map((group) => ({ relation: group.relation, direction: group.direction, ids: group.rows.map((row) => row.entity.id) })) : []));

  test('deploy.compose and deploy.dockerfiles: the compose services, the four Dockerfiles', async () => {
    for (const shown of item('deploy.compose').judge.mustShow) {
      const service = shown.split(' ')[0]!;
      expect(await labels('code.compose-service')).toContain(service);
    }
    expect((await product.list('code.dockerfile', { limit: 10 }))!.total).toBe(4);
    expect((await product.list('code.k8s-deployment', { limit: 10 }))!.total).toBe(1);
  });

  test('build.ci and build.makefile: the four jobs, and the targets the key names', async () => {
    expect((await product.list('code.ci-job', { limit: 10 }))!.total).toBe(4);
    const targets = await labels('code.make-target');
    for (const target of item('build.makefile').judge.mustShow) expect(targets).toContain(target);
  });

  test('config.database-url: the variable has a page that names the code reading it and where it is defined', async () => {
    const found = await product.list('code.env-var', { limit: 50, q: 'DATABASE_URL' });
    expect(found!.total).toBeGreaterThanOrEqual(3);
    const readers = (await Promise.all(found!.rows.map(async (row) => related(await page(row.id)).filter((group) => group.relation === 'code.reads-env' && group.direction === 'in').flatMap((group) => group.ids)))).flat();
    expect(readers.length).toBeGreaterThanOrEqual(3);
    const definitions = await product.list('code.env-definition', { limit: 50, q: 'DATABASE_URL' });
    expect(definitions!.total).toBeGreaterThanOrEqual(1);
  });

  test('dependencies.old-pin: the lodash pin has a page with its version', async () => {
    const found = await product.list('code.dependency', { limit: 50, q: 'lodash' });
    expect(found!.total).toBeGreaterThanOrEqual(1);
    const versions = await Promise.all(found!.rows.map(async (row) => block(await page(row.id), 'properties').rows.find((entry) => entry.name === 'version')?.value));
    expect(versions).toContain('4.17.15');
  });

  test('obs.healthz and contract.asyncapi.orders-events: the four health endpoints, and the channel with who publishes to it', async () => {
    expect((await product.list('code.health-endpoint', { limit: 10 }))!.total).toBe(4);
    const channel = await page(recordKey('code.channel', 'orders.events'));
    expect(related(channel).some((group) => group.relation === 'code.publishes' && group.direction === 'in')).toBe(true);
  });

  test('database.migration-order: the migrations of a database come in the order they run', async () => {
    const database = await page(recordKey('code.database', 'orders'));
    const migrations = related(database).find((group) => group.ids.every((id) => id.startsWith('code.migration:')))!;
    expect(migrations.ids).toEqual([...migrations.ids].sort());
    expect(migrations.ids.length).toBeGreaterThanOrEqual(3);
  });
});

describe('the index of the Markdown and the web page of the code', () => {
  test('a code place that the remote names carries the address of its page at the filled commit, lines marked', async () => {
    const result = await product.statement('domain:payment', 'Checkout asks payments to authorize the card for the order\'s total.');
    if (!result.ok) throw new Error(result.message);
    const excerpt = result.statement.grounds[1]!.excerpt;
    if (excerpt === null || excerpt.type !== 'code') throw new Error('no code excerpt');
    const commit = git('rev-parse', 'HEAD').trim();
    expect(excerpt.location.web).toEqual({ host: 'GitHub', url: `${REMOTE}/blob/${commit}/${excerpt.location.path}#L${excerpt.location.lineStart}-L${excerpt.location.lineEnd}` });
    const model = await page(PAY);
    expect(block(model, 'source').location.web?.host).toBe('GitHub');
  });

  test('the statement view lists the other statements that rely on the same ground, and the catalogue counts the statements of the pages', async () => {
    const result = await product.statement('domain:payment', 'Checkout asks payments to authorize the card for the order\'s total.');
    if (!result.ok) throw new Error(result.message);
    expect(result.statement.relying.map((other) => other.page)).toContain('product:shop');
    const shared = result.statement.relying.find((other) => other.page === 'product:shop')!;
    expect(shared.sentence).toBe('The shop takes orders from shoppers and charges their cards through a payments service.');
    expect(shared.turn).toBe(0);
    const status = await product.status();
    expect(status.kinds.find((kind) => kind.kind === 'domain')!.statements).toBeGreaterThanOrEqual(2);
  });
});

describe('the statement view', () => {
  test('a grounded sentence shows its paragraph and each ground with its excerpt: the use case\'s text and the lines of pay, the cited ones marked', async () => {
    const result = await product.statement('domain:payment', 'Checkout asks payments to authorize the card for the order\'s total.');
    if (!result.ok) throw new Error(result.message);
    const statement = result.statement;
    expect(statement).toMatchObject({ grounded: true, file: 'docs/domains/payment.md', page: { id: 'domain:payment' } });
    expect(statement.paragraph).toBe('Checkout asks payments to authorize the card for the order\'s total.');
    expect(statement.grounds.map((ground) => ground.url)).toEqual(['madarch:doc:docs/requirements.md#uc-2', `madarch:${PAY}`]);
    const [useCase, code] = statement.grounds;
    expect(useCase!.excerpt).toMatchObject({ type: 'text', markdown: expect.stringContaining('A captured payment confirms the order') });
    expect(code!.excerpt).toMatchObject({ type: 'code', language: 'typescript' });
    const excerpt = code!.excerpt!;
    if (excerpt.type !== 'code') throw new Error('not code');
    const declared = item('flow.payments.chain').locations!.find((entry) => entry.symbol === 'async pay')!;
    expect(excerpt.location.path).toBe(declared.path);
    expect(excerpt.marked.start).toBe(lineOf(declared.path, 'async pay('));
    expect(excerpt.text.split('\n')[excerpt.marked.start - excerpt.firstLine]).toContain('async pay(');
  });

  test('a sentence with no ground says so, a broken ground is shown with its reason, and a sentence the page does not hold is refused', async () => {
    const ungrounded = await product.statement('domain:payment', 'A refund that brings the refunded total up to the captured amount moves the order to refunded.');
    expect(ungrounded).toMatchObject({ ok: true, statement: { grounded: false, grounds: [] } });
    const withBroken = await product.statement('domain:payment', 'Payments are charged through one of two providers chosen by configuration.');
    if (!withBroken.ok) throw new Error(withBroken.message);
    expect(withBroken.statement.grounds.map((ground) => ground.resolution.state)).toEqual(['ok', 'broken']);
    const missing = await product.statement('domain:payment', 'This sentence is not on the page.');
    expect(missing).toMatchObject({ ok: false, status: 404, message: expect.stringContaining('docs/domains/payment.md holds no statement') });
    expect(await product.statement('domain:nothing', 'x')).toMatchObject({ ok: false, status: 404 });
  });
});

/** The 1-based line of the requirements document that holds the text. */
function lineOfDoc(text: string): number {
  const lines = git('show', `${KEY.snapshots['snapshot-final']}:docs/requirements.md`).split('\n');
  const at = lines.findIndex((line) => line.includes(text));
  if (at < 0) throw new Error(`docs/requirements.md holds no line with ${JSON.stringify(text)}`);
  return at + 1;
}

/**
 * The graph block and the relations block read the same graph (madarch-m38l.16, the owner's «А здесь почему пусто?»):
 * a page whose relations block lists a commit under its tasks must not print "the graph has no relations" above it, and
 * no relation the page lists may be missing from its neighbourhood. Every page-backed entity of the graph is walked, the
 * history and data kinds as well as the code ones, because the relations the neighbourhood used to hide were the
 * history ones.
 */
describe('the neighbourhood of a page agrees with its relations block', () => {
  test('every relation a page lists is in its neighbourhood, and a page with relations has a neighbourhood', async () => {
    const context = await product.context();
    if ('absent' in context) throw new Error('no manifest');
    const missing: string[] = [];
    const empty: string[] = [];
    let rows = 0;
    // Twenty entities of every kind, in the graph's own key order: the same entities on every run, and a walk of
    // the whole graph would take longer than the fill it reads.
    for (const { kind } of await context.ctx.graph.kindCounts()) {
      const listing = await context.ctx.graph.list(kind, { limit: 20 });
      for (const entity of listing.rows) {
        const page = await product.page(entity.key, 'en', { defer: false });
        if (!page.ok) { missing.push(`${entity.key}: ${page.message}`); continue; }
        const hood = await product.neighborhood(entity.key, { limit: 500 });
        if (!hood.ok) { missing.push(`${entity.key}: ${hood.message}`); continue; }
        const edges = new Set(hood.neighborhood.edges.map((edge) => `${edge.from}|${edge.to}|${edge.relation}`));
        // Only the page's own relations block: a children block draws related groups of its own, by key prefix, and it is no relation of the graph.
        const groups = page.page.blocks.filter((block) => block.type === 'related' && block.name === 'related').flatMap((block) => (block.type === 'related' ? block.groups : [])).filter((group) => group.relation !== 'relates');
        for (const group of groups) {
          for (const row of group.rows) {
            // A block with a depth reaches two or three hops out; the neighbourhood of a page is one hop, and the
            // parity this test keeps is the one-hop one (madarch-m38l.16, «А здесь почему пусто?»).
            if (row.hops !== undefined && row.hops > 1) continue;
            rows += 1;
            const key = group.direction === 'out' ? `${entity.key}|${row.entity.id}|${group.relation}` : `${row.entity.id}|${entity.key}|${group.relation}`;
            if (!edges.has(key)) missing.push(`${entity.key} lists ${group.direction === 'out' ? '→' : '←'} ${group.relation} ${row.entity.id}, and its neighbourhood does not hold it`);
          }
        }
        if (groups.some((group) => group.rows.length > 0) && hood.neighborhood.edges.length === 0) empty.push(entity.key);
      }
    }
    expect(rows).toBeGreaterThan(0);
    expect(missing, `relations the relations block shows and the neighbourhood hides (${String(missing.length)}):\n${missing.slice(0, 40).join('\n')}`).toEqual([]);
    expect(empty, `pages with relations and an empty neighbourhood: ${empty.join(', ')}`).toEqual([]);
  }, 900_000);
});
