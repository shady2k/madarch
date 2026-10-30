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
import type { Block, PageModel } from '../src/knowledge/model.js';
import type { ViewPayload } from '../src/knowledge/views.js';
import { stateMachinesOf } from '../src/knowledge/state-machines.js';
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
/** The views of every diagrams block of a page, in the page's order. */
const viewsOf = (model: PageModel): ViewPayload[] => model.blocks.flatMap((entry) => (entry.type === 'diagrams' ? entry.views : []));
const ofType = (model: PageModel, type: string): ViewPayload[] => viewsOf(model).filter((view) => view.spec.type === type);
/** A chain as the sequence view draws it: its steps in order (an unordered one is dashed), the participants (a service, a database, the broker). */
interface Chain { steps: { n: number; label: string; kind: string; note?: string; order: 'source' | 'unordered'; href: string | null }[]; lanes: string[]; notes: string[]; title: string; /** The steps the builder found, drawn and folded, and their total: the failure messages say what was left out. */ found: { n: number; label: string; kind: string; note?: string }[]; total: number | null }
const chainOfView = (view: ViewPayload): Chain => ({
  title: view.label,
  steps: view.edges.map((edge) => ({ n: edge.step!, label: edge.label, kind: edge.kind!, ...(edge.note === undefined ? {} : { note: edge.note }), order: edge.dashed ? 'unordered' as const : 'source' as const, href: edge.href ?? null })),
  lanes: view.elements.map((element) => element.label),
  notes: view.notes, found: (view.fullEdges ?? view.edges).map((edge) => ({ n: edge.step!, label: edge.label, kind: edge.kind!, ...(edge.note === undefined ? {} : { note: edge.note }) })), total: view.total ?? null,
});
const chainOf = async (id: string): Promise<Chain> => chainOfView(ofType(await page(id), 'sequence')[0]!);
const labels = (chain: Chain): string[] => chain.steps.map((step) => step.label);
const lanes = (chain: Chain): string[] => chain.lanes;
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
    expect(lanes(chain)).toEqual(expect.arrayContaining(['client', 'orders', 'orders database']));
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
    expect(chain.lanes).toEqual(expect.arrayContaining(['broker', 'orders', 'payments']));
  });

  test('POST /checkout crosses to promotions and orders over HTTP and to payments over gRPC, each call a step into the route or handler that serves it (checkout.sequence)', async () => {
    expect(['checkout.sequence', 'flow.checkout.chain'].every(hasItem)).toBe(true);
    const chain = await chainOf(route('services/checkout/src/api/routes.ts', 'POST:/checkout'));
    const kinds = chain.steps.map((step) => [step.kind, step.label]);
    expect(kinds).toEqual(expect.arrayContaining([['http', 'POST /internal/apply'], ['http', 'POST /orders']]));
    const grpc = chain.steps.find((step) => step.kind === 'grpc');
    expect(grpc, `checkout.sequence: no gRPC step among the ${chain.steps.length} steps the drawn chain holds; the builder found ${chain.total} steps, and its whole chain is: ${JSON.stringify(chain.found, null, 2)}`).toBeDefined();
    expect(grpc!.note).toContain('PaymentsClient.authorize');
    for (const service of ['checkout', 'promotions', 'orders', 'payments']) expect(chain.lanes).toContain(service);
    // The answer key's order of the checkout sequence: promotions, then orders, then payments.
    const at = (kind: string, label?: string): number => chain.steps.findIndex((step) => step.kind === kind && (label === undefined || step.label === label));
    expect(at('http', 'POST /internal/apply')).toBeLessThan(at('http', 'POST /orders'));
    expect(at('http', 'POST /orders')).toBeLessThan(at('grpc'));
  });

  test('a function page reaches the route above it, a domain page the routes of its functions, and a function no route reaches starts at itself', async () => {
    const pay = recordKey('code.symbol', 'services/payments/src/domain/payment-service.ts#PaymentService.pay');
    expect(ofType(await page(pay), 'sequence')[0]!.label).toBe('POST /payments');
    expect(ofType(await page('domain:payment'), 'sequence').map((view) => view.label)).toContain('POST /payments');
    // A function no route reaches has no steps to draw: the empty chain section is left off the page (madarch-m38l.21).
    expect(ofType(await page(recordKey('code.symbol', 'scripts/token.mjs#encode')), 'sequence')).toEqual([]);
  });
});

describe('the diagrams a page leaves to be read on their own', () => {
  test('a page asked for with defer answers a place for each diagram, and the block route draws one by the identity of its name and parameters, so the page answers at once', async () => {
    const pay = recordKey('code.symbol', 'services/payments/src/domain/payment-service.ts#PaymentService.pay');
    const answered = await product.page(pay, 'en', { defer: true });
    if (!answered.ok) throw new Error(answered.message);
    const deferred = answered.page.blocks.filter((entry) => entry.type === 'deferred');
    expect(deferred.map((entry) => entry.block)).toEqual(['graph', 'modules', 'sequence']);
    expect(answered.page.blocks.some((entry) => entry.type === 'diagrams' || entry.type === 'graph')).toBe(false);
    const drawn = await product.block(pay, deferred[2]!.id, 'en');
    if (!drawn.ok) throw new Error(drawn.message);
    expect(drawn.block).toMatchObject({ type: 'diagrams' });
    expect(await product.block(pay, 'sequence-000000000000', 'en')).toMatchObject({ ok: false, status: 404 });
  });
});

describe('the neighbourhood', () => {
  test('a function shows its callers and callees as edges in and out with the relation filter, every node linked to its page', async () => {
    const pay = recordKey('code.symbol', 'services/payments/src/domain/payment-service.ts#PaymentService.pay');
    const hood = block(await page(pay), 'graph').neighborhood;
    expect(hood.center).toBe(pay);
    const callers = hood.edges.filter((edge) => edge.relation === 'code.calls' && edge.to === pay).map((edge) => edge.from);
    expect(callers).toEqual([
      // Public async callback keys use their grammar parameter start. Their
      // independent raw source spans still include the leading async token.
      recordKey('code.symbol', 'services/payments/src/api/routes.ts#paymentRoutes.callback@10:377'),
      recordKey('code.symbol', 'services/payments/src/grpc/server.ts#paymentsHandlers.callback@38:1405'),
    ]);
    const callback = callers[0]!;
    const registered = block(await page(route('services/payments/src/api/routes.ts', 'POST:/payments')), 'graph').neighborhood;
    expect(registered.edges.filter((edge) => edge.relation === 'code.handled-by' && edge.from === registered.center)).toEqual([
      {from: registered.center, to: callback, relation: 'code.handled-by', count: 1},
    ]);
    expect(hood.nodes.find((node) => node.id === callback)?.label).toBe('paymentRoutes callback (line 10)');
    expect(hood.edges.some((edge) => edge.relation === 'code.calls' && edge.from === recordKey('code.symbol', 'services/payments/src/api/routes.ts#paymentRoutes') && edge.to === pay)).toBe(false);
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

describe('reading explicit transition tables only', () => {
  test('ignores transition-looking text in comments and ordinary Go nested maps', async () => {
    expect(await stateMachinesOf('src/order.ts', `/* const transitions = { pending: { paid: 'confirmed' } }; */\nconst permissions = { admin: { scope: 'all' } };`)).toEqual([]);
    expect(await stateMachinesOf('order.go', `var permissions = map[string]map[string]string{\n  "admin": { "scope": "all" },\n}`)).toEqual([]);
  });
});

describe('the drawn views: C4, components, ER, state and deployment, and the hotspot treemap', () => {
  test('the home page draws the context and the containers: four services, their databases and the topics with HTTP, gRPC, SQL and event links (interaction.*, database.*)', async () => {
    const home = await page('product:shop');
    const [context] = ofType(home, 'c4-context');
    expect(context!.elements.map((element) => element.kind)).toEqual(expect.arrayContaining(['person', 'product']));
    // The clients are an assumption: the graph holds the routes and not who calls them.
    expect(context!.edges.find((edge) => edge.from === 'clients')).toMatchObject({ dashed: true });
    const [system] = ofType(home, 'c4-container');
    const labelsOf = (kind: string): string[] => system!.elements.filter((element) => element.kind === kind).map((element) => element.label).sort();
    expect(labelsOf('container')).toEqual(['checkout', 'orders', 'payments', 'promotions']);
    expect(labelsOf('channel')).toEqual(expect.arrayContaining(['payments.events']));
    expect(labelsOf('database')).toEqual(expect.arrayContaining(['orders', 'payments', 'promotions']));
    const has = (from: string, to: string, via: string): boolean => system!.edges.some((edge) => edge.from === `code.service:${from}` && edge.to.includes(to) && edge.label.startsWith(via));
    expect(has('checkout', 'orders', 'HTTP')).toBe(true);
    expect(has('checkout', 'promotions', 'HTTP')).toBe(true);
    expect(has('checkout', 'payments', 'gRPC')).toBe(true);
    expect(system!.edges.some((edge) => edge.label.startsWith('publishes') && edge.from === 'code.service:payments')).toBe(true);
    expect(system!.edges.some((edge) => edge.label.startsWith('consumes') && edge.to === 'code.service:orders')).toBe(true);
    expect(system!.edges.some((edge) => edge.label.startsWith('SQL') && edge.from === 'code.service:orders')).toBe(true);
    // Every graph fact is solid, and a service opens its components, a database its tables.
    expect(system!.edges.every((edge) => !edge.dashed)).toBe(true);
    expect(system!.elements.find((element) => element.id === 'code.service:payments')!.drill).toMatchObject({ spec: { type: 'c4-component', subject: 'code.service:payments' } });
    expect(system!.elements.find((element) => element.kind === 'database')!.drill!.spec.type).toBe('er');
    expect(system!.renderers).toEqual(['likec4', 'mermaid', 'archify']);
    const framed = await product.viewFrame(new URLSearchParams(system!.query), 'likec4');
    expect(framed).toMatchObject({ ok: true, type: 'json' });
    if (framed.ok) {
      const payload = JSON.parse(framed.body) as { ok: boolean; model: { _stage: string; views: Record<string, unknown> }; elementLinks: Record<string, string> };
      expect(payload.model._stage).toBe('layouted');
      expect(payload.model.views.index).toBeDefined();
      expect(Object.keys(payload.elementLinks).length).toBeGreaterThan(0);
    }
    const archify = await product.viewFrame(new URLSearchParams(system!.query), 'archify');
    expect(archify).toMatchObject({ ok: true, type: 'html' });
    if (archify.ok) {
      expect(archify.body).toContain('<svg');
      expect(archify.body).toContain("(full ? 9 : 11)");
      expect(archify.body).toContain("data-node-label");
      expect(archify.body).toContain("data-boundary-label");
      expect(archify.body).toContain("addEventListener('resize', fit)");
      // A reading window scrolls to its chosen content anchor; a non-zero SVG origin is not a zero scroll origin.
      expect(archify.body).toContain('parent.scrollLeft = Math.max(0, -offsetX); parent.scrollTop = Math.max(0, -offsetY)');
      expect(archify.body).toContain("svg.setAttribute('data-reading-window-valid', String(found))");
    }
  });

  test('the deployment view draws the compose services and the Kubernetes deployments, and dashes what is matched by name only', async () => {
    const [deployment] = ofType(await page('product:shop'), 'deployment');
    expect(deployment).toBeDefined();
    const names = deployment!.elements.map((element) => element.label);
    expect(names).toEqual(expect.arrayContaining(['postgres', 'kafka', 'orders', 'docker-compose.yml']));
    expect(deployment!.elements.find((element) => element.label === 'orders' && element.parent !== undefined)).toBeDefined();
    expect(deployment!.edges.some((edge) => !edge.dashed && edge.label === 'depends on')).toBe(true);
    expect(deployment!.edges.filter((edge) => edge.dashed).every((edge) => edge.why !== undefined)).toBe(true);
  });

  test('the payments service shows the import cycle between domain and events as a cycle of components (payments.cycle.*)', async () => {
    expect(['payments.cycle.domain-to-events', 'payments.cycle.events-to-domain'].every(hasItem)).toBe(true);
    const [components] = ofType(await page('code.service:payments'), 'c4-component');
    const domain = recordKey('code.module', 'services/payments/src/domain');
    const events = recordKey('code.module', 'services/payments/src/events');
    expect(components!.elements.filter((element) => element.detail?.includes('cycle')).map((element) => element.id).sort()).toEqual([domain, events]);
    expect(components!.edges.filter((edge) => edge.label === 'cycle').map((edge) => `${edge.from}>${edge.to}`).sort()).toEqual([`${domain}>${events}`, `${events}>${domain}`]);
    expect(components!.elements.some((element) => !element.detail?.includes('cycle'))).toBe(true);
    expect(components!.up).toMatchObject({ spec: { type: 'c4-container' } });
  });

  test('the database page draws its tables with the foreign keys between them and links each table (database.orders)', async () => {
    const [er] = ofType(await page(recordKey('code.database', 'orders')), 'er');
    // Mermaid's ER syntax: an entity per table with a row per column, and one relationship line per foreign key.
    expect(er!.mermaidSource.split('\n')[0]).toBe('erDiagram');
    const entities = [...er!.mermaidSource.matchAll(/^  (\w+) \{$/gm)].map((entity) => entity[1]);
    expect(entities).toEqual(expect.arrayContaining(['customers', 'order_items', 'orders', 'outbox']));
    expect(er!.mermaidSource.match(/^  \w+ \|\|--o\{ \w+ : "[^"]+"$/gm)).toHaveLength(er!.edges.length);
    expect(er!.mermaidSource).toContain(' PK');
    // A foreign key marks its own column and names the relationship it makes.
    expect(er!.mermaidSource).toMatch(/ (FK)$/m);
    expect(er!.mermaidSource).toMatch(/^  \w+ \|\|--o\{ \w+ : "[a-z_]+"$/m);
    expect(er!.elements.map((element) => element.label).sort()).toEqual(expect.arrayContaining(['customers', 'order_items', 'orders', 'outbox']));
    expect(er!.elements.every((element) => element.href !== null)).toBe(true);
    expect(er!.renderers).toEqual(['mermaid']);
  });

  test('the order status machine of the orders domain is read from its transition table: states, events, and the line each is written at', async () => {
    const file = await page(recordKey('code.file', 'services/orders/internal/domain/order.go'));
    const [machine] = ofType(file, 'state');
    expect(machine).toBeDefined();
    expect(machine!.elements.map((element) => element.label)).toEqual(expect.arrayContaining(['pending_payment', 'confirmed', 'cancelled']));
    const moved = machine!.edges.find((edge) => edge.label === 'payment-captured');
    expect(moved).toBeDefined();
    expect(machine!.elements.find((element) => element.id === moved!.to)!.label).toBe('confirmed');
    expect(machine!.elements.every((element) => element.location !== undefined)).toBe(true);
    expect(machine!.edges.every((edge) => !edge.dashed)).toBe(true);
  });

  test('a domain page draws its services (dashed: the agent\'s reading), their data, neighbouring domains and the use cases the text names', async () => {
    const [domain] = ofType(await page('domain:payment'), 'domain');
    expect(domain).toBeDefined();
    expect(domain!.elements.some((element) => element.id === 'code.service:payments')).toBe(true);
    expect(domain!.edges.find((edge) => edge.to === 'code.service:payments')).toMatchObject({ dashed: true });
    expect(domain!.elements.some((element) => element.kind === 'database')).toBe(true);
    expect(domain!.up).toMatchObject({ spec: { type: 'domain-map' } });
  });

  test('a service page is where its treemap lives: the files it holds with their lines and their churn from history, order_service.go its hotspot, its lock file left out and said (hotspot, large-file)', async () => {
    expect(hasItem('hotspot')).toBe(true);
    const treemap = block(await page('code.service:orders'), 'treemap');
    expect(treemap.scope).toBe('services/orders');
    const byPath = new Map(treemap.files.map((file) => [file.path, file]));
    const hot = byPath.get('services/orders/internal/application/order_service.go')!;
    expect(hot.churn).toBe(28);
    expect(hot.lines).toBeGreaterThan(200);
    expect(treemap.maxChurn).toBe(28);
    expect(Math.max(...treemap.files.map((file) => file.churn))).toBe(hot.churn);
    // A service's picture is its own folder: no other service's files are in it.
    expect([...byPath.keys()].every((path) => path.startsWith('services/orders/'))).toBe(true);
    // The lock file the service pins its dependencies with is left out and said.
    expect([...byPath.keys()].some((path) => path.endsWith('go.sum'))).toBe(false);
    expect(treemap.notes.join(' ')).toContain('lock file');
    const pay = block(await page('code.service:payments'), 'treemap');
    expect(pay.files.find((file) => file.path === 'services/payments/src/api/legacy-report.ts')!.lines).toBeGreaterThan(700);
  });
});
