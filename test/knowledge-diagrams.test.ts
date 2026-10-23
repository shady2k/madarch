/**
 * The diagram blocks over the generated training repository, filled by the wiki's own fill (madarch-m38l.9, decision
 * 0029). The expected values are the answer key's (examples/training-repository/answer-key.json: the flow.*, checkout.*,
 * outbox.*, modules.*, payments.cycle.*, database.*, interaction.* and hotspot items) and the generated repository's own
 * files, never the engine's output.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import type { Block, Chain, PageModel } from '../src/knowledge/model.js';
import { ROOT, generateTrainingRepository, makeProduct, recordKey, writeSamplePages } from './knowledge-fixture.js';

const KEY = JSON.parse(readFileSync(join(ROOT, 'examples/training-repository/answer-key.json'), 'utf8')) as { items: { id: string }[] };
const hasItem = (id: string): boolean => KEY.items.some((entry) => entry.id === id);

let work: string;
let product: KnowledgeProduct;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'madarch-knowledge-diagrams-'));
  const repository = generateTrainingRepository(join(work, 'repo'));
  mkdirSync(join(work, 'home'));
  const folder = makeProduct(join(work, 'home'), 'training-shop', repository);
  writeSamplePages(folder);
  product = new KnowledgeProduct({ productFolder: folder, storeRoot: join(work, 'store') });
  expect(await product.startFill()).toMatchObject({ started: true });
  await product.settled();
  expect(product.fillState()).toMatchObject({ state: 'done' });
}, 900_000);

afterAll(async () => {
  await product.close();
  rmSync(work, { recursive: true, force: true });
});

async function page(id: string): Promise<PageModel> {
  const result = await product.page(id);
  if (!result.ok) throw new Error(`no page for ${id}: ${result.message}`);
  return result.page;
}
const block = <T extends Block['type']>(model: PageModel, type: T, at = 0): Extract<Block, { type: T }> => {
  const found = model.blocks.filter((entry) => entry.type === type)[at];
  if (found === undefined) throw new Error(`the page of ${model.id} has no ${type} block number ${at}: ${model.blocks.map((entry) => entry.type).join(', ')}`);
  return found as Extract<Block, { type: T }>;
};
const chainOf = async (id: string): Promise<Chain> => block(await page(id), 'sequence').chains[0]!;
const labels = (chain: Chain): string[] => chain.steps.map((step) => step.label);
const lanes = (chain: Chain): string[] => chain.lanes.map((lane) => lane.label);
const route = (path: string, signature: string): string => recordKey('code.route', `${path}#${signature}`);

describe('the end-to-end chains match the answer key\'s flows', () => {
  test('POST /orders: route, middleware, handler, use case, domain, repository, tables and the outbox (flow.orders.*)', async () => {
    expect(['flow.orders.route', 'flow.orders.middleware', 'flow.orders.handler', 'flow.orders.service', 'flow.orders.domain', 'flow.orders.repository', 'flow.orders.table'].every(hasItem)).toBe(true);
    const chain = await chainOf(route('services/orders/internal/api/router.go', 'POST:/orders'));
    const steps = labels(chain);
    expect(chain.steps[0]).toMatchObject({ kind: 'route', label: 'POST /orders' });
    expect(chain.steps[0]!.note).toContain('RequireAuth');
    expect(chain.steps[0]!.note).toContain('RequestLogger');
    // The order of the layers is the order of the answer key's items: handler, then the use case, then the domain's constructor, then the repository.
    const at = (label: string): number => steps.findIndex((step) => step === label || step.endsWith(`.${label}`));
    expect(at('Create')).toBeGreaterThan(0);
    expect(at('Place')).toBeGreaterThan(at('Create'));
    expect(at('NewOrder')).toBeGreaterThan(at('Place'));
    expect(steps.findIndex((step) => step === 'OrderRepository.Create')).toBeGreaterThan(at('NewOrder'));
    expect(steps).toEqual(expect.arrayContaining(['writes orders', 'writes order_items', 'writes outbox']));
    expect(lanes(chain)).toEqual(expect.arrayContaining(['router.go', 'handlers.go', 'order_service.go', 'order.go', 'order_repository.go', 'orders']));
    expect(chain.steps.every((step) => step.href !== undefined)).toBe(true);
  });

  test('the outbox row is read later by the relay that publishes it, and the graph holds no order for that: the step is unordered (outbox.chain)', async () => {
    expect(hasItem('outbox.chain')).toBe(true);
    const chain = await chainOf(route('services/orders/internal/api/router.go', 'POST:/orders'));
    const unordered = chain.steps.filter((step) => step.order === 'unordered');
    expect(unordered.length).toBeGreaterThan(0);
    expect(unordered.some((step) => step.note?.includes('reads outbox'))).toBe(true);
    // Everything before the first unordered step is ordered, and the unordered ones come last.
    const firstUnordered = chain.steps.findIndex((step) => step.order === 'unordered');
    expect(chain.steps.slice(firstUnordered).every((step) => step.order === 'unordered')).toBe(true);
    expect(chain.notes.join(' ')).toContain('holds no order');
  });

  test('POST /payments: route, handler, PaymentService.pay, repository and table, then the topic and its consumer in orders (flow.payments.chain, interaction.*)', async () => {
    expect(['flow.payments.chain', 'interaction.payments-events', 'interaction.orders-consumes-payments'].every(hasItem)).toBe(true);
    const chain = await chainOf(route('services/payments/src/api/routes.ts', 'POST:/payments'));
    const steps = labels(chain);
    expect(steps[0]).toBe('POST /payments');
    expect(steps).toEqual(expect.arrayContaining(['PaymentService.pay', 'writes payments', 'publishes payments.events']));
    expect(steps.indexOf('PaymentService.pay')).toBeLessThan(steps.indexOf('writes payments'));
    expect(steps.indexOf('writes payments')).toBeLessThan(steps.indexOf('publishes payments.events'));
    const consumer = chain.steps.find((step) => step.kind === 'consume' && step.note?.includes('payments.events'));
    expect(consumer).toBeDefined();
    expect(consumer!.order).toBe('unordered');
    expect(chain.lanes.find((lane) => lane.label === 'payments.events')!.group).toBe('broker');
    expect(chain.lanes.some((lane) => lane.group === 'orders')).toBe(true);
  });

  test('POST /checkout crosses to promotions and orders over HTTP and to payments over gRPC, each call a step into the route or handler that serves it (checkout.sequence)', async () => {
    expect(['checkout.sequence', 'flow.checkout.chain'].every(hasItem)).toBe(true);
    const chain = await chainOf(route('services/checkout/src/api/routes.ts', 'POST:/checkout'));
    const kinds = chain.steps.map((step) => [step.kind, step.label]);
    expect(kinds).toEqual(expect.arrayContaining([['http', 'POST /internal/apply'], ['http', 'POST /orders']]));
    const grpc = chain.steps.find((step) => step.kind === 'grpc');
    expect(grpc).toBeDefined();
    expect(grpc!.note).toContain('PaymentsClient.authorize');
    const groups = chain.lanes.map((lane) => lane.group);
    for (const service of ['checkout', 'promotions', 'orders', 'payments']) expect(groups).toContain(service);
    // The answer key's order of the checkout sequence: promotions, then orders, then payments.
    const at = (kind: string, label?: string): number => chain.steps.findIndex((step) => step.kind === kind && (label === undefined || step.label === label));
    expect(at('http', 'POST /internal/apply')).toBeLessThan(at('http', 'POST /orders'));
    expect(at('http', 'POST /orders')).toBeLessThan(at('grpc'));
  });

  test('a function page reaches the route above it, a domain page the routes of its functions, and a function no route reaches starts at itself', async () => {
    const pay = recordKey('code.symbol', 'services/payments/src/domain/payment-service.ts#PaymentService.pay');
    const fromFunction = block(await page(pay), 'sequence');
    expect(fromFunction.chains[0]!.entry!.label).toBe('POST /payments');
    const fromDomain = block(await page('domain:payment'), 'sequence');
    expect(fromDomain.scenario).toBe('Payment');
    expect(fromDomain.chains.map((chain) => chain.entry!.label)).toContain('POST /payments');
    const lonely = block(await page(recordKey('code.symbol', 'scripts/token.mjs#encode')), 'sequence');
    expect(lonely.chains[0]?.notes[0] ?? lonely.notes[0] ?? 'no chain').toMatch(/no route of the graph reaches this function|no chain/);
  });
});

describe('the diagrams a page leaves to be read on their own', () => {
  test('a page asked for with defer answers a place for each diagram, and the block route draws one by its template line, so the page answers at once', async () => {
    const pay = recordKey('code.symbol', 'services/payments/src/domain/payment-service.ts#PaymentService.pay');
    const answered = await product.page(pay, 'en', { defer: true });
    if (!answered.ok) throw new Error(answered.message);
    const deferred = answered.page.blocks.filter((entry) => entry.type === 'deferred');
    expect(deferred.map((entry) => entry.block)).toEqual(['graph', 'sequence']);
    expect(answered.page.blocks.some((entry) => entry.type === 'sequence' || entry.type === 'graph')).toBe(false);
    const drawn = await product.block(pay, deferred[1]!.line, 'en');
    if (!drawn.ok) throw new Error(drawn.message);
    expect(drawn.block).toMatchObject({ type: 'sequence' });
    expect(await product.block(pay, 9999, 'en')).toMatchObject({ ok: false, status: 404 });
  });
});

describe('the neighbourhood', () => {
  test('a function shows its callers and callees as edges in and out with the relation filter, every node linked to its page', async () => {
    const pay = recordKey('code.symbol', 'services/payments/src/domain/payment-service.ts#PaymentService.pay');
    const hood = block(await page(pay), 'graph').neighborhood;
    expect(hood.center).toBe(pay);
    const callers = hood.edges.filter((edge) => edge.relation === 'code.calls' && edge.to === pay).map((edge) => edge.from);
    expect(callers.map((id) => id.split('#')[1])).toEqual(expect.arrayContaining(['paymentRoutes', 'paymentsHandlers']));
    expect(hood.edges.some((edge) => edge.relation === 'code.calls' && edge.from === pay)).toBe(true);
    expect(hood.relations).toContainEqual(expect.objectContaining({ relation: 'code.calls', direction: 'in', count: 2 }));
    expect(hood.nodes.filter((node) => node.href === null && node.kind === 'code.symbol')).toEqual([]);
  });

  test('a service shows the services it calls and is called by, its database and its topic, from the links between services', async () => {
    const hood = block(await page('code.service:payments'), 'graph').neighborhood;
    const rel = (relation: string, direction: 'in' | 'out') => hood.relations.find((entry) => entry.relation === relation && entry.direction === direction);
    expect(rel('calls-grpc', 'in')).toBeDefined();
    expect(rel('uses-database', 'out')).toBeDefined();
    expect(rel('publishes', 'out')).toBeDefined();
    expect(hood.nodes.map((node) => node.label)).toEqual(expect.arrayContaining(['checkout', 'payments.events']));
  });

  test('a route shows the handler it hands the request to, a table the code that reads and writes it', async () => {
    const orders = block(await page(route('services/orders/internal/api/router.go', 'POST:/orders')), 'graph').neighborhood;
    expect(orders.edges.some((edge) => edge.relation === 'handled-by' && edge.to.endsWith('#OrderHandlers.Create'))).toBe(true);
    const table = block(await page(recordKey('code.table', 'orders/public.orders')), 'graph').neighborhood;
    expect(table.relations.map((entry) => entry.relation)).toEqual(expect.arrayContaining(['code.reads-table', 'code.writes-table', 'code.foreign-key']));
  });

  test('the route a diagram opens answers one hop of a node, optionally one relation, with what it left out counted', async () => {
    const pay = recordKey('code.symbol', 'services/payments/src/domain/payment-service.ts#PaymentService.pay');
    const all = await product.neighborhood(pay, { limit: 3 });
    if (!all.ok) throw new Error(all.message);
    expect(all.neighborhood.nodes.length).toBeGreaterThan(1);
    expect(all.neighborhood.more.length).toBeGreaterThan(0);
    const calls = await product.neighborhood(pay, { relation: 'code.calls', direction: 'out', limit: 100 });
    if (!calls.ok) throw new Error(calls.message);
    expect(calls.neighborhood.more).toEqual([]);
    expect(calls.neighborhood.edges.every((edge) => edge.relation === 'code.calls' && edge.from === pay)).toBe(true);
    expect(await product.neighborhood('code.symbol:nothing#here', { limit: 3 })).toMatchObject({ ok: false, status: 404 });
  });
});

describe('the system, module, ER and hotspot views', () => {
  test('the home page draws the four services, their databases and the topics with HTTP, gRPC, SQL and event links (interaction.*, database.*)', async () => {
    const system = block(await page('product:shop'), 'system');
    const labelsOf = (kind: string): string[] => system.nodes.filter((node) => node.kind === kind).map((node) => node.label).sort();
    expect(labelsOf('service')).toEqual(['checkout', 'orders', 'payments', 'promotions']);
    expect(labelsOf('topic')).toEqual(expect.arrayContaining(['payments.events']));
    expect(labelsOf('database')).toEqual(expect.arrayContaining(['orders', 'payments', 'promotions']));
    const has = (from: string, to: string, via: string): boolean => system.edges.some((edge) => edge.from === `code.service:${from}` && edge.to.includes(to) && edge.via === via);
    expect(has('checkout', 'orders', 'http')).toBe(true);
    expect(has('checkout', 'promotions', 'http')).toBe(true);
    expect(has('checkout', 'payments', 'grpc')).toBe(true);
    expect(system.edges.some((edge) => edge.via === 'publishes' && edge.from === 'code.service:payments')).toBe(true);
    expect(system.edges.some((edge) => edge.via === 'consumes' && edge.to === 'code.service:orders')).toBe(true);
    expect(system.edges.some((edge) => edge.via === 'sql' && edge.from === 'code.service:orders')).toBe(true);
  });

  test('the payments service shows the import cycle between domain and events as a cycle of modules (payments.cycle.*)', async () => {
    expect(['payments.cycle.domain-to-events', 'payments.cycle.events-to-domain'].every(hasItem)).toBe(true);
    const modules = block(await page('code.service:payments'), 'modules');
    const domain = recordKey('code.module', 'services/payments/src/domain');
    const events = recordKey('code.module', 'services/payments/src/events');
    expect(modules.cycles).toEqual([[domain, events]]);
    expect(modules.nodes.filter((node) => node.cycle).map((node) => node.id).sort()).toEqual([domain, events]);
    expect(modules.edges.filter((edge) => edge.cycle).map((edge) => `${edge.from}>${edge.to}`).sort()).toEqual([`${domain}>${events}`, `${events}>${domain}`]);
    expect(modules.nodes.some((node) => !node.cycle)).toBe(true);
  });

  test('the database page draws its tables with the foreign keys between them and links each table (database.orders)', async () => {
    const er = block(await page(recordKey('code.database', 'orders')), 'er');
    expect(er.mermaid).toContain('customers');
    expect(er.mermaid).toContain('}o--||');
    expect(er.links.map((link) => link.label).sort()).toEqual(expect.arrayContaining(['customers', 'order_items', 'orders', 'outbox']));
    expect(er.links.every((link) => link.href !== null)).toBe(true);
  });

  test('the treemap gives the files their lines and their churn from history: order_service.go is the hotspot, lock files are left out and said (hotspot, large-file)', async () => {
    expect(hasItem('hotspot')).toBe(true);
    const treemap = block(await page('product:shop'), 'treemap');
    const byPath = new Map(treemap.files.map((file) => [file.path, file]));
    const hot = byPath.get('services/orders/internal/application/order_service.go')!;
    expect(hot.churn).toBe(28);
    expect(treemap.maxChurn).toBe(28);
    expect(Math.max(...treemap.files.map((file) => file.churn))).toBe(hot.churn);
    expect(byPath.get('services/payments/src/api/legacy-report.ts')!.lines).toBeGreaterThan(700);
    expect([...byPath.keys()].some((path) => path.endsWith('package-lock.json'))).toBe(false);
    expect(treemap.notes.join(' ')).toContain('lock file');
    expect(treemap.total).toBe(115);
  });
});
