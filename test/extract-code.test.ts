/**
 * The code-structure extractor (src/extract/code) against the training
 * repository (madarch-o0eq.6). One generation of the repository feeds every
 * case; the expected values come from examples/training-repository/answer-key.json
 * (an item's locations, anchors and judge.mustShow), never from the extractor's
 * output. Each case's name carries the id of the key item it asserts. The
 * areas are modules, architecture, flow, exports, pattern, tests, payments.cycle
 * and dead-export; entrypoints.* and the contracts of the same files belong to
 * the contracts extractor.
 */
import {beforeAll, describe, expect, test} from 'bun:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp, readFile, readdir, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {extractCode} from '../src/extract/code/index.js';
import {
  fileKey,
  KIND_CYCLE,
  KIND_MODULE,
  KIND_PACKAGE,
  KIND_SYMBOL,
  KIND_TEST_CASE,
  moduleKey,
  packageKey,
  REL_CALLS,
  REL_CONTAINS,
  REL_CYCLE_MEMBER,
  REL_DEPENDS_ON,
  REL_IMPLEMENTS,
  REL_IMPORTS,
  REL_INHERITS,
  REL_OCCURRENCE,
  REL_REFERENCES,
  REL_TESTS,
  symbolKey,
} from '../src/extract/code/keys.js';
import {extractDataModel} from '../src/extract/data-model/extract.js';
import {extractContracts} from '../src/extract/contracts/index.js';
import {extractOperations, OPERATIONS_PRODUCER} from '../src/extract/operations/index.js';
import type {ExtractedEdge, ExtractedNode, Extraction, TreeReader} from '../src/extract/records.js';

const testFolder = path.dirname(fileURLToPath(import.meta.url));
const checkoutRoot = path.resolve(testFolder, '..');
const key: AnswerKey = JSON.parse(await readFile(path.join(checkoutRoot, 'examples/training-repository/answer-key.json'), 'utf8'));

interface Location {
  snapshot: string;
  path: string;
  symbol?: string;
  anchor?: string;
}
interface AnswerKeyItem {
  id: string;
  locations?: readonly Location[];
  location?: Location;
  expectedWikiStatement: string;
  evidenceClass: string;
  judge: {mustShow: readonly string[]; mustNotClaim?: readonly string[]};
}
interface AnswerKey {
  items: AnswerKeyItem[];
}

/** The answer-key item of one case; the test fails when the id is not in the key. */
function item(id: string): AnswerKeyItem {
  const found = key.items.find((entry) => entry.id === id);
  if (!found) throw new Error(`answer-key.json holds no item ${id}`);
  return found;
}

function locationsOf(id: string): Location[] {
  const found = item(id);
  return [...(found.locations ?? []), ...(found.location ? [found.location] : [])];
}

/**
 * The qualified name a key location's `symbol` text declares: `func (h *Handler)
 * apply` is `Handler.apply`, `class PaymentService` is `PaymentService`,
 * `type Strategy interface` is `Strategy`; a bare identifier is itself.
 */
function declared(symbol: string): string {
  const method = /^func \(\w+ \*?(\w+)\) (\w+)/.exec(symbol);
  if (method) return `${method[1]}.${method[2]}`;
  const named = /^(?:export )?(?:abstract )?(?:async )?(?:function|func|class|interface|type|const|let|var) (\w+)/.exec(symbol);
  if (named) return named[1]!;
  return symbol;
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function folderReader(dir: string): Promise<TreeReader> {
  const walk = async (prefix: string): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await readdir(prefix ? path.join(dir, prefix) : dir)) {
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if ((await stat(path.join(dir, rel))).isDirectory()) {
        if (entry !== '.git' && entry !== 'node_modules') out.push(...(await walk(rel)));
      } else out.push(rel);
    }
    return out;
  };
  const paths = (await walk('')).sort(byCodePoint);
  const bytes = new Map<string, Uint8Array>();
  for (const p of paths) bytes.set(p, new Uint8Array(await readFile(path.join(dir, p))));
  return {
    paths,
    read(p: string): Uint8Array {
      const held = bytes.get(p);
      if (held === undefined) throw new Error(`no such path in the tree: ${p}`);
      return held;
    },
  };
}

let tree: TreeReader;
let ex: Extraction;
let again: Extraction;
let dataModel: Extraction;
let contracts: Extraction;
let operations: Extraction;

beforeAll(async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'madarch-o0eq6-'));
  const generated = path.join(scratch, 'training-repository');
  execFileSync('node', [path.join(checkoutRoot, 'examples/training-repository/generate.mjs'), generated], {
    cwd: checkoutRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  tree = await folderReader(generated);
  await rm(scratch, {recursive: true, force: true});
  ex = await extractCode(tree);
  again = await extractCode(tree);
  dataModel = await extractDataModel(tree);
  contracts = await extractContracts(tree, ex);
  operations = extractOperations(tree);
}, 280_000);

// ---- lookups ---------------------------------------------------------------

const nodeByKey = (): Map<string, ExtractedNode> => new Map(ex.nodes.map((n) => [n.key, n]));

function node(k: string): ExtractedNode {
  const found = nodeByKey().get(k);
  if (!found) {
    const prefix = k.slice(0, k.indexOf('#') >= 0 ? k.indexOf('#') + 1 : k.length);
    const near = ex.nodes.filter((n) => n.key.startsWith(prefix)).map((n) => n.key);
    throw new Error(`no node ${k}; the extractor holds near it: ${near.join(', ') || '(none)'}`);
  }
  return found;
}

function sym(file: string, name: string): string {
  return symbolKey(file, name);
}

function edges(type: string, from?: string, to?: string): ExtractedEdge[] {
  return ex.edges.filter((e) => e.type === type && (from === undefined || e.from === from) && (to === undefined || e.to === to));
}

function has(type: string, from: string, to: string): boolean {
  return edges(type, from, to).length > 0;
}

/** Fails with the edges that leave `from` when the pair is absent. */
function expectEdge(type: string, from: string, to: string): ExtractedEdge {
  const found = edges(type, from, to);
  if (found.length === 0) {
    const out = edges(type, from).map((e) => e.to);
    throw new Error(`no ${type} edge ${from} -> ${to}; ${type} edges from it go to: ${out.join(', ') || '(none)'}`);
  }
  return found[0]!;
}

/** Follow the actual registered inline owner, never invent a call from its factory. */
function inlineRouteHandler(file: string, path: string, factory: string): string {
  const route = `code.route:${file}#POST:${path}`;
  const handlers = contracts.edges.filter((edge) => edge.type === 'code.handled-by' && edge.from === route);
  expect(handlers, route).toHaveLength(1);
  const handler = handlers[0]!.to;
  const callback = node(handler);
  expect(callback.properties['inline'], handler).toBe(true);
  expect(callback.properties['qualifiedName'], handler).toStartWith(`${factory}.callback@`);
  const registrations = contracts.edges.filter((edge) => edge.type === REL_REFERENCES && edge.from === sym(file, factory) && edge.to === handler);
  expect(registrations, route).toHaveLength(1);
  expect(registrations[0]!.properties['role']).toBe('callback-registration');
  expect(registrations[0]!.span).toEqual(callback.span);
  return handler;
}

const dirOf = (p: string): string => p.slice(0, p.lastIndexOf('/'));

const ORDERS = 'services/orders/internal';
const ROUTER = `${ORDERS}/api/router.go`;
const HANDLERS = `${ORDERS}/api/handlers.go`;
const SERVICE = `${ORDERS}/application/order_service.go`;
const DOMAIN = `${ORDERS}/domain/order.go`;
const REPOSITORY = `${ORDERS}/store/order_repository.go`;
const PAYMENTS = 'services/payments/src';
const CHECKOUT = 'services/checkout/src';

// ---- modules ---------------------------------------------------------------

describe('modules', () => {
  test('modules.orders: one module per Go package, api -> application -> domain, store implements OrderStore, relay and consumer are separate loops', () => {
    const locations = locationsOf('modules.orders');
    expect(locations.length).toBe(9);
    for (const location of locations) {
      const folder = dirOf(location.path);
      const module = node(moduleKey(folder));
      expect(module.kind).toBe(KIND_MODULE);
      expect(module.properties['packageName']).toBe(location.symbol!.replace(/^package /, ''));
      expectEdge(REL_CONTAINS, moduleKey(folder), fileKey(location.path));
    }
    const dependsOn = (from: string, to: string): boolean => has(REL_DEPENDS_ON, moduleKey(`${ORDERS}/${from}`), moduleKey(`${ORDERS}/${to}`));
    expect(dependsOn('api', 'application')).toBe(true);
    expect(dependsOn('api', 'domain')).toBe(true);
    expect(dependsOn('application', 'domain')).toBe(true);
    expect(dependsOn('application', 'pricing')).toBe(true);
    expect(dependsOn('store', 'application')).toBe(true);
    // The layering runs one way: nothing below the api reaches back up to it.
    expect(dependsOn('domain', 'api')).toBe(false);
    expect(dependsOn('application', 'api')).toBe(false);
    expect(has(REL_IMPLEMENTS, sym(REPOSITORY, 'OrderRepository'), sym(SERVICE, 'OrderStore'))).toBe(true);
    // relay and consumer are loops started by the process entry point: only cmd imports them.
    for (const loop of ['relay', 'consumer']) {
      const importers = edges(REL_DEPENDS_ON, undefined, moduleKey(`${ORDERS}/${loop}`)).map((e) => e.from);
      expect(importers).toEqual([moduleKey('services/orders/cmd/orders')]);
    }
    // config and logging are shared leaves: other modules depend on them and they depend on no module of the service.
    for (const shared of ['config', 'logging']) {
      expect(edges(REL_DEPENDS_ON, undefined, moduleKey(`${ORDERS}/${shared}`)).length).toBeGreaterThan(0);
      expect(edges(REL_DEPENDS_ON, moduleKey(`${ORDERS}/${shared}`)), shared).toEqual([]);
    }
    expect(edges(REL_DEPENDS_ON, undefined, moduleKey(`${ORDERS}/logging`)).length).toBeGreaterThan(1);
  });

  test('modules.payments: the folders api, domain, events, providers, store, grpc and the resilience file hold the named symbols', () => {
    const locations = locationsOf('modules.payments');
    expect(locations.length).toBe(8);
    for (const location of locations) {
      const name = declared(location.symbol!);
      const symbolNode = node(sym(location.path, name));
      expect(symbolNode.kind).toBe(KIND_SYMBOL);
      expectEdge(REL_CONTAINS, fileKey(location.path), symbolNode.key);
      expect(node(moduleKey(dirOf(location.path))).kind).toBe(KIND_MODULE);
    }
    for (const folder of ['api', 'domain', 'events', 'providers', 'store', 'grpc']) {
      expect(node(moduleKey(`${PAYMENTS}/${folder}`)).properties['language']).toBe('typescript');
    }
    expect(has(REL_CONTAINS, moduleKey(PAYMENTS), fileKey(`${PAYMENTS}/resilience.ts`))).toBe(true);
    // api calls into domain; the providers sit behind the PaymentProvider interface the domain depends on.
    expect(has(REL_DEPENDS_ON, moduleKey(`${PAYMENTS}/api`), moduleKey(`${PAYMENTS}/domain`))).toBe(true);
    expect(has(REL_DEPENDS_ON, moduleKey(`${PAYMENTS}/domain`), moduleKey(`${PAYMENTS}/providers`))).toBe(true);
    expect(has(REL_DEPENDS_ON, moduleKey(`${PAYMENTS}/domain`), moduleKey(`${PAYMENTS}/store`))).toBe(true);
  });

  test('modules.promotions: discount, store and api hold the Strategy, FindActive and the apply handler', () => {
    const locations = locationsOf('modules.promotions');
    expect(locations.length).toBe(3);
    const wanted = ['Strategy', 'Repository.FindActive', 'Handler.apply'];
    locations.forEach((location, index) => {
      expect(declared(location.symbol!) === wanted[index] || location.symbol === 'FindActive').toBe(true);
    });
    expect(node(sym('services/promotions/internal/discount/strategy.go', 'Strategy')).properties['symbolKind']).toBe('interface');
    expect(node(sym('services/promotions/internal/store/promotions.go', 'Repository.FindActive')).kind).toBe(KIND_SYMBOL);
    expect(node(sym('services/promotions/internal/api/handler.go', 'Handler.apply')).kind).toBe(KIND_SYMBOL);
    for (const folder of ['discount', 'store', 'api']) {
      expect(node(moduleKey(`services/promotions/internal/${folder}`)).properties['packageName']).toBe(folder);
    }
    expect(has(REL_DEPENDS_ON, moduleKey('services/promotions/internal/api'), moduleKey('services/promotions/internal/discount'))).toBe(true);
    expect(has(REL_DEPENDS_ON, moduleKey('services/promotions/internal/api'), moduleKey('services/promotions/internal/store'))).toBe(true);
  });

  test('modules.checkout: CheckoutService, one client per downstream service and the pricing preview, with the files that hold them', () => {
    const locations = locationsOf('modules.checkout');
    expect(locations.length).toBe(5);
    for (const location of locations) {
      expect(node(sym(location.path, declared(location.symbol!))).kind).toBe(KIND_SYMBOL);
    }
    const service = fileKey(`${CHECKOUT}/checkout-service.ts`);
    for (const client of ['orders-client', 'payments-client', 'promotions-client', 'pricing']) {
      expectEdge(REL_IMPORTS, service, fileKey(`${CHECKOUT}/${client}.ts`));
    }
  });

  test('every module and every package of the training repository is a record, and the root packages are the four services', () => {
    const packages = ex.nodes.filter((n) => n.kind === KIND_PACKAGE && n.properties['external'] !== true).map((n) => n.key);
    // External imports are now records too, not additional repository roots.
    const external = ex.nodes.filter((n) => n.kind === KIND_PACKAGE && n.properties['external'] === true);
    const expectedImports = [
      ...['context', 'crypto/rand', 'database/sql', 'encoding/csv', 'encoding/hex', 'encoding/json', 'errors', 'fmt', 'log/slog', 'net/http', 'os', 'os/signal', 'path/filepath', 'sort', 'strconv', 'strings', 'sync', 'sync/atomic', 'syscall', 'testing', 'time'].map((name) => `code.package:import/go/${name}`),
      ...['node:crypto', 'node:http', 'node:net', 'node:path'].map((name) => `code.package:import/node/${name}`),
    ];
    expect(external.map((n) => n.key)).toEqual(expectedImports);
    expect(ex.nodes.filter((n) => n.kind === KIND_PACKAGE)).toHaveLength(29);
    for (const imported of external) {
      expect(imported.properties['standardLibrary'], imported.key).toBe(true);
      expect(imported.properties['versionStatus'], imported.key).toBe('not-applicable');
      expect(imported.span?.path, imported.key).toBeDefined();
      expect(edges(REL_IMPORTS, undefined, imported.key).length, imported.key).toBeGreaterThan(0);
    }
    expect(packages).toEqual(
      ['checkout', 'orders', 'payments', 'promotions'].map((name) => packageKey(`services/${name}`)),
    );
    // Every module of a service has exactly one package holding it; a folder outside every service (the scripts) has none.
    for (const module of ex.nodes.filter((n) => n.kind === KIND_MODULE)) {
      const holders = edges(REL_CONTAINS, undefined, module.key).map((e) => e.from);
      expect(holders.length, module.key).toBe(module.key.startsWith('code.module:services/') ? 1 : 0);
    }
  });
});

// ---- architecture ------------------------------------------------------------

describe('architecture', () => {
  test('architecture.composition-root: orders run() and payments main() construct the collaborators once and inject them', () => {
    const locations = locationsOf('architecture.composition-root');
    expect(locations.map((l) => l.path)).toEqual(['services/orders/cmd/orders/main.go', 'services/payments/src/index.ts']);
    const run = sym(locations[0]!.path, declared(locations[0]!.symbol!));
    const main = sym(locations[1]!.path, declared(locations[1]!.symbol!));
    expect(run.endsWith('#run')).toBe(true);
    expect(main.endsWith('#main')).toBe(true);
    // run(): configuration, storage, the application service, the handlers and the router.
    for (const callee of [
      sym(`${ORDERS}/config/config.go`, 'Load'),
      sym(`${ORDERS}/store/db.go`, 'Open'),
      sym(`${ORDERS}/store/order_repository.go`, 'NewOrderRepository'),
      sym(`${ORDERS}/store/outbox.go`, 'NewOutboxWriter'),
      sym(SERVICE, 'NewService'),
      sym(HANDLERS, 'NewOrderHandlers'),
      sym(ROUTER, 'NewRouter'),
    ]) {
      expectEdge(REL_CALLS, run, callee);
    }
    // main(): the repository, the provider factory, the service and both servers.
    expectEdge(REL_CALLS, main, sym(`${PAYMENTS}/app.ts`, 'createApp'));
    expectEdge(REL_CALLS, main, sym(`${PAYMENTS}/grpc/server.ts`, 'startGrpcServer'));
    expectEdge(REL_CALLS, main, sym(`${PAYMENTS}/config.ts`, 'loadConfig'));
    expectEdge(REL_CALLS, main, sym(`${PAYMENTS}/providers/factory.ts`, 'PaymentClientFactory.create'));
    for (const constructed of ['store/payment-repository.ts#PrismaPaymentRepository', 'domain/payment-service.ts#PaymentService', 'events/publishers.ts#KafkaEventSink']) {
      const [file, name] = constructed.split('#');
      expect(has(REL_REFERENCES, main, sym(`${PAYMENTS}/${file}`, name!)) || has(REL_CALLS, main, sym(`${PAYMENTS}/${file}`, name!))).toBe(true);
    }
    expect(node(run).properties['entryPoint']).toBeUndefined();
    expect(node(sym('services/orders/cmd/orders/main.go', 'main')).properties['entryPoint']).toBe('main');
  });
});

// ---- flow ----------------------------------------------------------------------

describe('flow', () => {
  test('flow.orders.route: NewRouter registers POST /orders in the auth group and references OrderHandlers.Create', () => {
    const location = locationsOf('flow.orders.route')[0]!;
    expect(location.anchor).toContain('deps.Orders.Create');
    const edge = expectEdge(REL_REFERENCES, sym(location.path, location.symbol!), sym(HANDLERS, 'OrderHandlers.Create'));
    expect(edge.span?.path).toBe(location.path);
    // The auth group is the chain RequireAuth builds: authed is bound by a call of Chain over RequireAuth.
    expectEdge(REL_CALLS, sym(ROUTER, 'NewRouter'), sym(`${ORDERS}/api/middleware.go`, 'Chain'));
    expectEdge(REL_CALLS, sym(ROUTER, 'NewRouter'), sym(`${ORDERS}/api/middleware.go`, 'RequireAuth'));
  });

  test('flow.orders.middleware: the global chain RequestLogger, RecoverPanics, Metrics.Count and RequireAuth are referenced from NewRouter', () => {
    const router = sym(ROUTER, 'NewRouter');
    const middleware = `${ORDERS}/api/middleware.go`;
    expectEdge(REL_CALLS, router, sym(middleware, 'RequestLogger'));
    expectEdge(REL_CALLS, router, sym(middleware, 'RecoverPanics'));
    expectEdge(REL_REFERENCES, router, sym(`${ORDERS}/api/metrics.go`, 'Metrics.Count'));
    expectEdge(REL_CALLS, router, sym(middleware, 'RequireAuth'));
    expect(node(sym(middleware, 'RequireAuth')).kind).toBe(KIND_SYMBOL);
    // The order in the chain is the order of the call sites in the return statement.
    const sites = ['RequestLogger', 'RecoverPanics']
      .map((name) => expectEdge(REL_CALLS, router, sym(middleware, name)).span!.byteStart);
    expect(sites[0]!).toBeLessThan(sites[1]!);
  });

  test('flow.orders.handler: OrderHandlers.Create builds application.PlaceOrder and calls the OrderService interface Place', () => {
    const create = sym(HANDLERS, 'OrderHandlers.Create');
    expect(locationsOf('flow.orders.handler')[0]!.anchor).toBe('h.svc.Place(r.Context(), cmd)');
    expectEdge(REL_CALLS, create, sym(HANDLERS, 'OrderService.Place'));
    expectEdge(REL_REFERENCES, create, sym(SERVICE, 'PlaceOrder'));
    expectEdge(REL_CALLS, create, sym(`${ORDERS}/api/middleware.go`, 'ClaimsFromContext'));
  });

  test('flow.orders.service: Service.Place validates, prices, builds the Order and stores it through OrderStore.Create', () => {
    const place = sym(SERVICE, 'Service.Place');
    const created = expectEdge(REL_CALLS, place, sym(SERVICE, 'OrderStore.Create'));
    expect(created.span?.path).toBe(SERVICE);
    expectEdge(REL_CALLS, place, sym(DOMAIN, 'ValidateItems'));
    expectEdge(REL_CALLS, place, sym(`${ORDERS}/pricing/pricing.go`, 'Discount'));
    expectEdge(REL_CALLS, place, sym(`${ORDERS}/pricing/pricing.go`, 'LineTotal'));
    expectEdge(REL_CALLS, place, sym(DOMAIN, 'NewOrder'));
    expectEdge(REL_CALLS, place, sym(SERVICE, 'OrderStore.FindByRequestID'));
    expectEdge(REL_CALLS, place, sym(SERVICE, 'OrderStore.CustomerExists'));
    // The handler's interface method reaches the one implementation.
    expect(edges(REL_CALLS, sym(HANDLERS, 'OrderHandlers.Create'), place)[0]?.properties['via']).toBe('interface');
  });

  test('flow.orders.domain: NewOrder creates the Order and Apply moves it only through Transition and the transitions table', () => {
    const locations = locationsOf('flow.orders.domain');
    expect(locations.map((l) => declared(l.symbol!))).toEqual(['NewOrder', 'Order.Apply']);
    for (const location of locations) expect(node(sym(location.path, declared(location.symbol!))).kind).toBe(KIND_SYMBOL);
    expectEdge(REL_CALLS, sym(DOMAIN, 'Order.Apply'), sym(DOMAIN, 'Transition'));
    expectEdge(REL_REFERENCES, sym(DOMAIN, 'Transition'), sym(DOMAIN, 'transitions'));
    // The aggregate is moved by Apply from the use case Service.Apply (Cancel, Ship and the payment events go through it),
    // and created by NewOrder from Place.
    expectEdge(REL_CALLS, sym(SERVICE, 'Service.Apply'), sym(DOMAIN, 'Order.Apply'));
    for (const caller of ['Service.Cancel', 'Service.Ship', 'Service.ApplyPaymentEvent']) expectEdge(REL_CALLS, sym(SERVICE, caller), sym(SERVICE, 'Service.Apply'));
    expectEdge(REL_CALLS, sym(SERVICE, 'Service.Place'), sym(DOMAIN, 'NewOrder'));
    expect(has(REL_REFERENCES, sym(DOMAIN, 'Order.Apply'), sym(DOMAIN, 'transitions'))).toBe(false);
  });

  test('flow.orders.repository: OrderRepository.Create inserts the order and its lines and writes the outbox', () => {
    const location = locationsOf('flow.orders.repository')[0]!;
    const create = sym(location.path, declared(location.symbol!));
    expect(create).toBe(sym(REPOSITORY, 'OrderRepository.Create'));
    const source = new TextDecoder().decode(tree.read(REPOSITORY));
    const declaration = source.indexOf('func (r *OrderRepository) Create');
    const callbackAt = source.indexOf('func(tx *sql.Tx) error {', declaration);
    expect(callbackAt).toBeGreaterThan(declaration);
    const byteStart = new TextEncoder().encode(source.slice(0, callbackAt)).length;
    const line = source.slice(0, callbackAt).split('\n').length;
    const callback = sym(REPOSITORY, `OrderRepository.Create.callback@${line}:${byteStart}`);
    expect(node(callback).span?.byteStart).toBe(byteStart);
    for (const target of [sym(`${ORDERS}/store/outbox.go`, 'OutboxWriter.Write'), sym(REPOSITORY, 'insertOrder'), sym(REPOSITORY, 'insertItems')]) {
      const call = expectEdge(REL_CALLS, callback, target);
      expect(call.span?.path).toBe(REPOSITORY);
      expect(call.span!.byteStart).toBeGreaterThan(byteStart);
      expect(has(REL_CALLS, create, target)).toBe(false);
    }
    expectEdge(REL_CALLS, create, sym(REPOSITORY, 'OrderRepository.inTx'));
    const reference = expectEdge(REL_REFERENCES, create, callback);
    expect(reference.properties.role).toBe('callback-value');
    expect(reference.span?.byteStart).toBe(byteStart);
    // The service reaches this implementation through the interface.
    const viaInterface = edges(REL_CALLS, sym(SERVICE, 'Service.Place'), create);
    expect(viaInterface[0]?.properties['via']).toBe('interface');
  });

  test('flow.orders.table: the symbols of the chain resolve to the data-model extractor function nodes that read and write the orders table', () => {
    const symbols = new Set(ex.nodes.filter((n) => n.kind === KIND_SYMBOL).map((n) => n.key));
    const accesses = dataModel.edges.filter((e) => e.type === 'code.writes-table' || e.type === 'code.reads-table');
    expect(accesses.length).toBeGreaterThan(0);
    // The key builder is shared: every function a table access starts from is a symbol node of this extractor.
    const functionStarts = accesses.map((e) => e.from).filter((from) => !from.startsWith('code.file:'));
    expect(functionStarts.length).toBeGreaterThan(0);
    for (const from of functionStarts) expect(symbols.has(from), `${from} is not a code.symbol node`).toBe(true);
    const ordersWriters = accesses.filter((e) => e.to.endsWith('.orders') && e.type === 'code.writes-table').map((e) => e.from);
    expect(ordersWriters).toContain(sym(REPOSITORY, 'OrderRepository.Create'));
    // The chain: route -> handler -> interface -> implementation -> table, all in one connected graph.
    expectEdge(REL_REFERENCES, sym(ROUTER, 'NewRouter'), sym(HANDLERS, 'OrderHandlers.Create'));
    expectEdge(REL_CALLS, sym(HANDLERS, 'OrderHandlers.Create'), sym(SERVICE, 'Service.Place'));
    expectEdge(REL_CALLS, sym(SERVICE, 'Service.Place'), sym(REPOSITORY, 'OrderRepository.Create'));
    expect(locationsOf('flow.orders.table')[0]!.anchor).toBe('CREATE TABLE orders');
  });

  test('flow.orders.interface: store.OrderRepository implements application.OrderStore (a structural link no declaration names)', () => {
    const edge = expectEdge(REL_IMPLEMENTS, sym(REPOSITORY, 'OrderRepository'), sym(SERVICE, 'OrderStore'));
    expect(edge.properties['form']).toBe('structural');
    expect(edge.properties['inferred']).toBe(true);
    expectEdge(REL_IMPLEMENTS, sym(SERVICE, 'Service'), sym(HANDLERS, 'OrderService'));
    // main.go passes the repository to NewService.
    expectEdge(REL_CALLS, sym('services/orders/cmd/orders/main.go', 'run'), sym(SERVICE, 'NewService'));
    expectEdge(REL_CALLS, sym('services/orders/cmd/orders/main.go', 'run'), sym(REPOSITORY, 'NewOrderRepository'));
  });

  test('flow.payments.chain: createApp mounts authenticate and paymentRoutes, whose registered callback calls PaymentService.pay, which stores through PrismaPaymentRepository', () => {
    const create = sym(`${PAYMENTS}/app.ts`, 'createApp');
    expectEdge(REL_CALLS, create, sym(`${PAYMENTS}/api/middleware.ts`, 'authenticate'));
    expectEdge(REL_CALLS, create, sym(`${PAYMENTS}/api/routes.ts`, 'paymentRoutes'));
    const routes = sym(`${PAYMENTS}/api/routes.ts`, 'paymentRoutes');
    const pay = sym(`${PAYMENTS}/domain/payment-service.ts`, 'PaymentService.pay');
    const handler = inlineRouteHandler(`${PAYMENTS}/api/routes.ts`, '/payments', 'paymentRoutes');
    expectEdge(REL_CALLS, handler, pay);
    expect(edges(REL_CALLS, routes, pay)).toEqual([]);
    const repository = `${PAYMENTS}/store/payment-repository.ts`;
    expectEdge(REL_CALLS, pay, sym(repository, 'PaymentRepository.create'));
    expectEdge(REL_CALLS, pay, sym(repository, 'PrismaPaymentRepository.create'));
    // The table end of the chain is the data-model extractor's, on the same symbol key.
    const writers = dataModel.edges.filter((e) => e.type === 'code.writes-table' && e.to.endsWith('.payments')).map((e) => e.from);
    expect(writers).toContain(sym(repository, 'PrismaPaymentRepository.create'));
    expectEdge(REL_CALLS, create, sym(`${PAYMENTS}/api/middleware.ts`, 'authenticate'));
    expect(locationsOf('flow.payments.chain').length).toBe(6);
  });

  test('flow.payments.interface: PrismaPaymentRepository explicitly implements PaymentRepository, which PaymentService depends on', () => {
    const repository = `${PAYMENTS}/store/payment-repository.ts`;
    const edge = expectEdge(REL_IMPLEMENTS, sym(repository, 'PrismaPaymentRepository'), sym(repository, 'PaymentRepository'));
    expect(edge.properties['form']).toBe('declared');
    expect(edge.properties['inferred']).toBe(false);
    expectEdge(REL_REFERENCES, sym(`${PAYMENTS}/domain/payment-service.ts`, 'PaymentServiceDeps.repository'), sym(repository, 'PaymentRepository'));
  });

  test('flow.checkout.chain: checkoutRoutes is mounted by createApp and its registered callback calls CheckoutService.checkout', () => {
    expectEdge(REL_CALLS, sym(`${CHECKOUT}/app.ts`, 'createApp'), sym(`${CHECKOUT}/api/routes.ts`, 'checkoutRoutes'));
    const handler = inlineRouteHandler(`${CHECKOUT}/api/routes.ts`, '/checkout', 'checkoutRoutes');
    const checkout = sym(`${CHECKOUT}/checkout-service.ts`, 'CheckoutService.checkout');
    expectEdge(REL_CALLS, handler, checkout);
    expect(edges(REL_CALLS, sym(`${CHECKOUT}/api/routes.ts`, 'checkoutRoutes'), checkout)).toEqual([]);
    expect(locationsOf('flow.checkout.chain').length).toBe(3);
  });
});

// ---- exports ---------------------------------------------------------------------

describe('exports', () => {
  test('exports.not-entrypoints: formatInvoiceLegacy is exported and no entry point; main is an entry point', () => {
    const [legacy, main] = locationsOf('exports.not-entrypoints');
    const exported = node(sym(legacy!.path, legacy!.symbol!));
    expect(exported.properties['exported']).toBe(true);
    expect(exported.properties['entryPoint']).toBeUndefined();
    expect(exported.properties['deadExport']).toBe(true);
    const entry = node(sym(main!.path, declared(main!.symbol!)));
    expect(entry.properties['entryPoint']).toBe('main');
    // A used export is an export all the same, and is not marked dead.
    const used = node(sym(`${PAYMENTS}/format.ts`, 'formatMoney'));
    expect(used.properties['exported']).toBe(true);
    expect(used.properties['deadExport']).toBe(false);
    // No entry point is marked as a dead export.
    for (const n of ex.nodes.filter((candidate) => candidate.kind === KIND_SYMBOL && candidate.properties['entryPoint'] !== undefined)) {
      expect(n.properties['deadExport'] ?? false, n.key).toBe(false);
    }
  });
});

// ---- patterns ---------------------------------------------------------------------

describe('pattern', () => {
  const CONFIG = `${ORDERS}/config/config.go`;
  const DISCOUNT = 'services/promotions/internal/discount/strategy.go';
  const PROVIDERS = `${PAYMENTS}/providers`;

  test('pattern.singleton: Load reads the once and instance package variables; once is a sync.Once', () => {
    const location = locationsOf('pattern.singleton')[0]!;
    expect(location.anchor).toBe('once.Do');
    const load = sym(CONFIG, location.symbol!);
    expect(node(sym(CONFIG, 'once')).properties['typeText']).toBe('sync.Once');
    expectEdge(REL_REFERENCES, load, sym(CONFIG, 'once'));
    expectEdge(REL_REFERENCES, load, sym(CONFIG, 'instance'));
    const instance = expectEdge(REL_REFERENCES, load, sym(CONFIG, 'instance'));
    expect(instance.span?.path).toBe(CONFIG);
    expect(node(sym(CONFIG, 'instance')).properties['symbolKind']).toBe('variable');
  });

  test('pattern.not-singleton: the module-level client is written by request() on every call', () => {
    const location = locationsOf('pattern.not-singleton')[0]!;
    expect(location.anchor).toBe('client = createClient(timeoutMs);');
    const client = sym(location.path, 'client');
    expect(node(client).properties['symbolKind']).toBe('variable');
    const writes = edges(REL_OCCURRENCE, sym(location.path, location.symbol!), client);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.some((e) => (e.properties['roles'] as string[]).includes('write-access'))).toBe(true);
    expectEdge(REL_CALLS, sym(location.path, 'request'), sym(location.path, 'createClient'));
  });

  test('pattern.strategy: Percent, FixedAmount and Threshold implement Strategy, For selects them and the handler calls only the interface', () => {
    const locations = locationsOf('pattern.strategy');
    expect(locations.length).toBe(5);
    const strategy = sym(DISCOUNT, 'Strategy');
    for (const impl of ['Percent', 'FixedAmount', 'Threshold']) {
      const edge = expectEdge(REL_IMPLEMENTS, sym(DISCOUNT, impl), strategy);
      expect(edge.properties['form']).toBe('structural');
      expectEdge(REL_REFERENCES, sym(DISCOUNT, 'For'), sym(DISCOUNT, impl));
    }
    const apply = sym('services/promotions/internal/api/handler.go', 'Handler.apply');
    expectEdge(REL_CALLS, apply, sym(DISCOUNT, 'For'));
    expectEdge(REL_CALLS, apply, sym(DISCOUNT, 'Strategy.Discount'));
    // The handler names no strategy: each implementation is reached only through the interface.
    for (const impl of ['Percent', 'FixedAmount', 'Threshold']) {
      expect(expectEdge(REL_CALLS, apply, sym(DISCOUNT, `${impl}.Discount`)).properties['via']).toBe('interface');
      expect(has(REL_REFERENCES, apply, sym(DISCOUNT, impl))).toBe(false);
    }
  });

  test('pattern.adapter: Cardnet and Deferred implement the PaymentProvider port', () => {
    const port = sym(`${PROVIDERS}/provider.ts`, 'PaymentProvider');
    for (const adapter of ['cardnet.ts#Cardnet', 'deferred.ts#Deferred']) {
      const [file, name] = adapter.split('#');
      const edge = expectEdge(REL_IMPLEMENTS, sym(`${PROVIDERS}/${file}`, name!), port);
      expect(edge.properties['form']).toBe('declared');
    }
    expectEdge(REL_REFERENCES, sym(`${PAYMENTS}/domain/payment-service.ts`, 'PaymentServiceDeps.provider'), port);
  });

  test('pattern.factory: PaymentClientFactory.create constructs Cardnet and Deferred and fails on an unknown name', () => {
    const create = sym(`${PROVIDERS}/factory.ts`, 'PaymentClientFactory.create');
    expectEdge(REL_REFERENCES, create, sym(`${PROVIDERS}/cardnet.ts`, 'Cardnet'));
    expectEdge(REL_REFERENCES, create, sym(`${PROVIDERS}/deferred.ts`, 'Deferred'));
    expect(node(create).properties['symbolKind']).toBe('method');
    expect(locationsOf('pattern.factory')[0]!.anchor).toBe('switch (name)');
  });

  test('pattern.inheritance: Cardnet and Deferred extend the abstract BaseProvider', () => {
    const base = sym(`${PROVIDERS}/provider.ts`, 'BaseProvider');
    expect(node(base).properties['abstract']).toBe(true);
    expect(node(sym(`${PROVIDERS}/cardnet.ts`, 'Cardnet')).properties['abstract']).toBe(false);
    expectEdge(REL_INHERITS, sym(`${PROVIDERS}/cardnet.ts`, 'Cardnet'), base);
    expectEdge(REL_INHERITS, sym(`${PROVIDERS}/deferred.ts`, 'Deferred'), base);
    expect(node(sym(`${PROVIDERS}/provider.ts`, 'BaseProvider.submit')).properties['abstract']).toBe(true);
    expect(node(sym(`${PROVIDERS}/provider.ts`, 'BaseProvider.submitRefund')).properties['abstract']).toBe(true);
    expect(node(sym(`${PROVIDERS}/provider.ts`, 'BaseProvider.charge')).properties['abstract']).toBe(false);
  });

  test('pattern.repository: OrderRepository, PrismaPaymentRepository and the promotions Repository each implement the interface their service depends on', () => {
    expect(locationsOf('pattern.repository').length).toBe(3);
    expectEdge(REL_IMPLEMENTS, sym(REPOSITORY, 'OrderRepository'), sym(SERVICE, 'OrderStore'));
    expectEdge(REL_IMPLEMENTS, sym(`${PAYMENTS}/store/payment-repository.ts`, 'PrismaPaymentRepository'), sym(`${PAYMENTS}/store/payment-repository.ts`, 'PaymentRepository'));
    expectEdge(REL_IMPLEMENTS, sym('services/promotions/internal/store/promotions.go', 'Repository'), sym('services/promotions/internal/api/handler.go', 'Promotions'));
  });

  test('pattern.state-machine: the transitions table is read by Transition, which Apply calls', () => {
    const location = locationsOf('pattern.state-machine')[0]!;
    expect(location.anchor).toBe('var transitions = map[Status]map[Event]Status');
    const table = node(sym(location.path, location.symbol!));
    expect(table.properties['symbolKind']).toBe('variable');
    expect(table.properties['typeText']).toBeUndefined();
    expectEdge(REL_REFERENCES, sym(DOMAIN, 'Transition'), table.key);
    expectEdge(REL_CALLS, sym(DOMAIN, 'Order.Apply'), sym(DOMAIN, 'Transition'));
    expect(edges(REL_REFERENCES, undefined, table.key).map((e) => e.from)).toEqual([sym(DOMAIN, 'Transition')]);
  });

  test('pattern.middleware-chain: Middleware is a function type and Chain composes it, the first listed outermost', () => {
    const location = locationsOf('pattern.middleware-chain')[0]!;
    const chain = sym(location.path, declared(location.symbol!));
    const middleware = sym(location.path, 'Middleware');
    expect(node(middleware).properties['symbolKind']).toBe('type');
    expectEdge(REL_REFERENCES, chain, middleware);
    expectEdge(REL_CALLS, sym(ROUTER, 'NewRouter'), chain);
    // Chain is called for the auth group and for the global chain.
    expect(edges(REL_CALLS, sym(ROUTER, 'NewRouter'), chain)[0]!.properties['count']).toBe(3);
  });
});

// ---- tests -----------------------------------------------------------------------

function cases(file: string): ExtractedNode[] {
  return ex.nodes.filter((n) => n.kind === KIND_TEST_CASE && n.properties['path'] === file).sort((a, b) => a.span!.byteStart - b.span!.byteStart);
}

function subjectsOf(testCase: ExtractedNode): string[] {
  return edges(REL_TESTS, testCase.key).map((e) => e.to).sort(byCodePoint);
}

describe('tests', () => {
  const ORDER_TEST = `${ORDERS}/domain/order_test.go`;
  const PRICING_TEST = `${ORDERS}/pricing/pricing_test.go`;

  test('tests.state-machine: TestTransition is a table-driven Go test of 11 cases whose subject is Transition; TestApplyStampsTheOrder is a unit test', () => {
    const location = locationsOf('tests.state-machine')[0]!;
    const transition = cases(location.path).find((c) => c.properties['name'] === location.symbol)!;
    expect(transition.properties['testKind']).toBe('table-driven');
    expect(transition.properties['cases']).toBe(11);
    expect(transition.properties['framework']).toBe('go-test');
    expect(subjectsOf(transition)).toContain(sym(DOMAIN, 'Transition'));
    const apply = cases(ORDER_TEST).find((c) => c.properties['name'] === 'TestApplyStampsTheOrder')!;
    expect(apply.properties['testKind']).toBe('unit');
    expect(subjectsOf(apply)).toContain(sym(DOMAIN, 'Order.Apply'));
  });

  test('tests.pricing: TestDiscount and TestTax are table-driven, TestLineTax and TestLineTotal are unit tests of the pricing package', () => {
    const found = new Map(cases(PRICING_TEST).map((c) => [c.properties['name'] as string, c]));
    expect([...found.keys()].sort()).toEqual(['TestDiscount', 'TestLineTax', 'TestLineTotal', 'TestTax']);
    expect(found.get('TestDiscount')!.properties['testKind']).toBe('table-driven');
    expect(found.get('TestTax')!.properties['testKind']).toBe('table-driven');
    expect(found.get('TestLineTax')!.properties['testKind']).toBe('unit');
    expect(subjectsOf(found.get('TestDiscount')!)).toContain(sym(`${ORDERS}/pricing/pricing.go`, 'Discount'));
    expect(subjectsOf(found.get('TestTax')!)).toContain(sym(`${ORDERS}/pricing/tax.go`, 'Tax'));
    expect(subjectsOf(found.get('TestLineTax')!)).toContain(sym(`${ORDERS}/pricing/tax.go`, 'LineTax'));
  });

  test('tests.order-service: five test functions over the in-memory fakeStore, which implements OrderStore', () => {
    const file = `${ORDERS}/application/order_service_test.go`;
    expect(cases(file).map((c) => c.properties['name'] as string).sort()).toEqual([
      'TestPaymentEventsMoveTheOrder',
      'TestPlacePricesEveryLine',
      'TestPlaceRefusesWhatCannotBePriced',
      'TestPlaceWithTheSameRequestIDReturnsTheFirstOrder',
      'TestRetentionJobRemovesOnlyExpiredUnshippedOrders',
    ]);
    const store = node(sym(file, 'fakeStore'));
    expect(store.properties['symbolKind']).toBe('struct');
    expectEdge(REL_IMPLEMENTS, store.key, sym(SERVICE, 'OrderStore'));
    const placed = cases(file).find((c) => c.properties['name'] === 'TestPlacePricesEveryLine')!;
    expect(subjectsOf(placed)).toContain(sym(SERVICE, 'Service.Place'));
  });

  test('tests.factory: factory.test.ts has three jest cases whose subject is PaymentClientFactory', () => {
    const location = locationsOf('tests.factory')[0]!;
    const found = cases(location.path);
    expect(found.length).toBe(3);
    for (const testCase of found) {
      expect(testCase.properties['framework']).toBe('jest');
      expect(testCase.properties['suite']).toEqual(['PaymentClientFactory']);
      expect(subjectsOf(testCase)).toContain(sym(`${PAYMENTS}/providers/factory.ts`, 'PaymentClientFactory.create'));
    }
    expect(found.map((c) => c.properties['name'])).toContain('refuses a provider name it does not know');
  });

  test('tests.refund: refund.test.ts exercises checkRefund in table-driven and unit cases', () => {
    const location = locationsOf('tests.refund')[0]!;
    const found = cases(location.path);
    expect(found.length).toBe(7);
    // Every case that runs exercises the refund rule; the one skipped case has an empty body.
    for (const testCase of found.filter((c) => c.properties['skipped'] === false)) expect(subjectsOf(testCase), testCase.key).toContain(sym(`${PAYMENTS}/domain/refund.ts`, 'checkRefund'));
    const each = found.find((c) => c.properties['name'] === 'rejects the amount %p')!;
    expect(each.properties['testKind']).toBe('table-driven');
    expect(each.properties['cases']).toBe(3);
    expect(location.anchor).toBe('window-closed');
  });

  test('tests.skipped: exactly one test is skipped, with the reason its comment gives', () => {
    const location = locationsOf('tests.skipped')[0]!;
    const skipped = ex.nodes.filter((n) => n.kind === KIND_TEST_CASE && n.properties['skipped'] === true);
    expect(skipped.map((n) => n.properties['name'])).toEqual(['refunds through the vault sandbox']);
    expect(location.anchor).toBe("it.skip('refunds through the vault sandbox'");
    expect(skipped[0]!.properties['path']).toBe(location.path);
    expect(skipped[0]!.properties['skipReason']).toContain('sandbox credentials');
    expect(ex.nodes.filter((n) => n.kind === KIND_TEST_CASE && n.properties['skipped'] === false).length).toBeGreaterThan(20);
  });

  test('tests.pay: pay.test.ts runs PaymentService with in-memory fakes that implement the repository, the sink and the provider', () => {
    const location = locationsOf('tests.pay')[0]!;
    const found = cases(location.path);
    expect(found.length).toBe(7);
    const subjects = new Set(found.flatMap(subjectsOf));
    // The cases build the service through a helper of the file, so the subject is the class they construct.
    expect(subjects.has(sym(`${PAYMENTS}/domain/payment-service.ts`, 'PaymentService'))).toBe(true);
    expectEdge(REL_IMPLEMENTS, sym(location.path, 'ScriptedProvider'), sym(`${PAYMENTS}/providers/provider.ts`, 'PaymentProvider'));
    expectEdge(REL_IMPLEMENTS, sym(location.path, 'MemoryRepository'), sym(`${PAYMENTS}/store/payment-repository.ts`, 'PaymentRepository'));
    expectEdge(REL_IMPLEMENTS, sym(location.path, 'RecordingSink'), sym(`${PAYMENTS}/events/publishers.ts`, 'EventSink'));
  });

  test('tests.checkout-e2e: the e2e file is a boundary test: two e2e cases that reach only checkout code', () => {
    const location = locationsOf('tests.checkout-e2e')[0]!;
    const found = cases(location.path);
    expect(found.map((c) => c.properties['name'] as string).sort()).toEqual([
      'cancels the order and answers 402 when the payment is declined',
      'places the order with the promotion percent and pays it',
    ]);
    for (const testCase of found) {
      expect(testCase.properties['testKind']).toBe('e2e');
      const subjects = subjectsOf(testCase);
      expect(subjects.length).toBeGreaterThan(0);
      for (const subject of subjects) expect(subject.slice(subject.indexOf(':') + 1).startsWith('services/checkout/'), subject).toBe(true);
    }
    const every = new Set(found.flatMap(subjectsOf));
    expect(every.has(sym(`${CHECKOUT}/app.ts`, 'createApp'))).toBe(true);
    expect(location.anchor).toBe('places the order with the promotion percent and pays it');
  });

  test('tests.checkout-pricing: checkout pricing.test.ts tests discountFor and previewTotal', () => {
    const location = locationsOf('tests.checkout-pricing')[0]!;
    const found = cases(location.path);
    expect(found.length).toBe(2);
    const subjects = new Set(found.flatMap(subjectsOf));
    expect(subjects.has(sym(`${CHECKOUT}/pricing.ts`, 'previewTotal'))).toBe(true);
    expect(subjects.has(sym(`${CHECKOUT}/pricing.ts`, 'discountFor'))).toBe(true);
    expect(location.anchor).toBe('144');
  });

  test('tests.promotions-none: the promotions service is named as a package with no tests', () => {
    const promotions = node(packageKey('services/promotions'));
    expect(promotions.properties['hasTests']).toBe(false);
    expect(promotions.properties['testFiles']).toBe(0);
    expect(promotions.properties['tests']).toBe('none');
    expect(promotions.properties['sourceFiles']).toBeGreaterThan(0);
    for (const check of (item('tests.promotions-none') as AnswerKeyItem & {checks: {path: string; absent: boolean}[]}).checks) {
      expect(check.absent).toBe(true);
      expect(tree.paths).not.toContain(check.path);
    }
    for (const service of ['orders', 'payments', 'checkout']) {
      expect(node(packageKey(`services/${service}`)).properties['hasTests'], service).toBe(true);
    }
    const none = ex.nodes.filter((n) => n.kind === KIND_PACKAGE && n.properties['tests'] === 'none').map((n) => n.key);
    expect(none).toEqual([packageKey('services/promotions')]);
  });
});

// ---- payments.cycle -----------------------------------------------------------------

describe('payments.cycle', () => {
  const DOMAIN_FILE = `${PAYMENTS}/domain/payment.ts`;
  const EVENTS_FILE = `${PAYMENTS}/events/publishers.ts`;

  test('payments.cycle.domain-to-events: payment.ts imports publishers.ts', () => {
    const location = locationsOf('payments.cycle.domain-to-events')[0]!;
    expect(location.path).toBe(DOMAIN_FILE);
    const edge = expectEdge(REL_IMPORTS, fileKey(DOMAIN_FILE), fileKey(EVENTS_FILE));
    expect(edge.properties['specifier']).toBe('../events/publishers');
    expect(edge.span?.path).toBe(DOMAIN_FILE);
    expect(expectEdge(REL_DEPENDS_ON, moduleKey(`${PAYMENTS}/domain`), moduleKey(`${PAYMENTS}/events`)).properties['count']).toBeGreaterThan(0);
  });

  test('payments.cycle.events-to-domain: publishers.ts imports payment.ts, closing the stored cycle domain <-> events', () => {
    const location = locationsOf('payments.cycle.events-to-domain')[0]!;
    expect(location.path).toBe(EVENTS_FILE);
    expectEdge(REL_IMPORTS, fileKey(EVENTS_FILE), fileKey(DOMAIN_FILE));
    const cycles = ex.nodes.filter((n) => n.kind === KIND_CYCLE);
    const sameMembers = (level: string, members: string[]): ExtractedNode | undefined =>
      cycles.find((c) => c.properties['level'] === level && JSON.stringify(c.properties['members']) === JSON.stringify(members));
    const moduleCycle = sameMembers('module', [moduleKey(`${PAYMENTS}/domain`), moduleKey(`${PAYMENTS}/events`)])!;
    expect(moduleCycle).toBeDefined();
    expectEdge(REL_CYCLE_MEMBER, moduleCycle.key, moduleKey(`${PAYMENTS}/domain`));
    expectEdge(REL_CYCLE_MEMBER, moduleCycle.key, moduleKey(`${PAYMENTS}/events`));
    expect(moduleCycle.properties['edges']).toEqual([
      `${moduleKey(`${PAYMENTS}/domain`)} -> ${moduleKey(`${PAYMENTS}/events`)}`,
      `${moduleKey(`${PAYMENTS}/events`)} -> ${moduleKey(`${PAYMENTS}/domain`)}`,
    ]);
    const fileCycle = sameMembers('file', [fileKey(DOMAIN_FILE), fileKey(EVENTS_FILE)])!;
    expect(fileCycle).toBeDefined();
    // Cycles of the other services are records too; the payments cycle is among them and is the only file-level one of payments.
    const paymentFileCycles = cycles.filter((c) => c.properties['level'] === 'file' && (c.properties['members'] as string[]).some((m) => m.includes('services/payments/')));
    expect(paymentFileCycles.map((c) => c.key)).toEqual([fileCycle.key]);
    // A folder and its subfolders are not a cycle: the only module cycle of payments is domain <-> events.
    const paymentModuleCycles = cycles.filter((c) => c.properties['level'] === 'module' && (c.properties['members'] as string[]).some((m) => m.includes('services/payments/')));
    expect(paymentModuleCycles.map((c) => c.properties['members'])).toEqual([[moduleKey(`${PAYMENTS}/domain`), moduleKey(`${PAYMENTS}/events`)]]);
  });
});

// ---- dead-export ----------------------------------------------------------------------

describe('dead-export', () => {
  test('dead-export: formatInvoiceLegacy is exported by format.ts with no reference in the repository', () => {
    const location = locationsOf('dead-export')[0]!;
    expect(location.anchor).toBe('export function formatInvoiceLegacy');
    const legacy = sym(location.path, location.symbol!);
    expect(node(legacy).properties['deadExport']).toBe(true);
    expect(edges(REL_CALLS, undefined, legacy)).toEqual([]);
    expect(edges(REL_REFERENCES, undefined, legacy)).toEqual([]);
    expect(edges(REL_OCCURRENCE, undefined, legacy)).toEqual([]);
    // The report that once used it imports the file now for formatMoney only.
    expect(edges(REL_OCCURRENCE, undefined, sym(location.path, 'formatMoney')).length).toBeGreaterThan(0);
    const dead = ex.nodes.filter((n) => n.kind === KIND_SYMBOL && n.properties['deadExport'] === true);
    // The key names one dead export; nothing else in the repository is flagged.
    expect(dead.map((n) => n.key)).toEqual([legacy]);
    // A dead export is a symbol of production code: never a test, a main function or a route.
    for (const n of dead) {
      expect(n.properties['test'] ?? false, n.key).toBe(false);
      expect(n.properties['entryPoint'], n.key).toBeUndefined();
    }
  });
});

// ---- what this extractor does not read --------------------------------------------------------

// Each of these key facets is not a deterministic reading of the code structure; the item itself is asserted above
// for what is, and the facet is named here with its reason.
describe('named todo: facets of the key items that the code structure does not decide', () => {
  test.todo('flow.orders.route / flow.orders.middleware: that POST /orders is inside the auth group is the contracts extractor\'s route record (authGroup); here the chain Chain -> RequireAuth is calls only', () => {});
  test.todo('flow.orders.repository: that the insert, the items and the outbox write run in one database transaction is a property of the data-model extractor\'s table accesses, not of the call graph', () => {});
  test.todo('pattern.repository: the exceptions with direct database access (legacy report, migration runner, outbox writer, relay) are table-access records of the data-model extractor', () => {});
  test.todo('pattern.singleton / pattern.strategy / pattern.adapter / pattern.factory / pattern.state-machine: the pattern names are interpretations; the extractor stores their structural evidence (implements, references, once, transitions) and the wiki names the pattern', () => {});
  test.todo('tests.checkout-e2e: that the gRPC stub speaks the real proto and the orders stub prices with 8% tax is behaviour of the test, not structure; only "reaches no code of other services" is stored', () => {});
  test.todo('tests.pay: the per-case behaviours (doubling waits, decline after three failures) are in the case names the catalogue stores; the subject is the PaymentService class because the cases build it through a helper whose result type the reader does not infer', () => {});
  test.todo('architecture.composition-root: that dependencies are injected through constructors and the composition root is the only place that builds them is a judgement over the calls; the calls of run() and main() are asserted', () => {});
});

// ---- the whole extraction ---------------------------------------------------------------

describe('the extraction as a whole', () => {
  test('the same bytes give the same records, in code point order', () => {
    expect(JSON.stringify(again)).toBe(JSON.stringify(ex));
    const keys = ex.nodes.map((n) => n.key);
    expect(keys).toEqual([...keys].sort(byCodePoint));
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('every edge ends at a node of code, data-model or declared operations provenance, and every gap names its path and reason', () => {
    expect(operations.producer).toBe(OPERATIONS_PRODUCER);
    const dependencies = operations.nodes.filter((node) => node.kind === 'code.dependency');
    expect(dependencies.length).toBeGreaterThan(0);
    for (const imported of ex.edges.filter((edge) => edge.type === REL_IMPORTS && edge.to.startsWith('code.dependency:'))) {
      const dependency = dependencies.find((node) => node.key === imported.to);
      expect(dependency, imported.to).toBeDefined();
      const span = dependency!.span!;
      expect(span, imported.to).toBeDefined();
      expect(imported.to).toBe(`code.dependency:${span.path}#${String(dependency!.properties['name'])}`);
      const declaration = operations.edges.filter((edge) => edge.type === 'code.declares-dependency' && edge.from === `code.manifest:${span.path}` && edge.to === imported.to);
      expect(declaration, imported.to).toHaveLength(1);
      expect(declaration[0]!.span).toEqual(span);
      const text = new TextDecoder().decode(tree.read(span.path));
      const line = text.split('\n')[span.lineStart - 1]!;
      expect(line, imported.to).toContain(String(dependency!.properties['name']));
      expect(line, imported.to).toContain(String(dependency!.properties['version']));
      expect(imported.properties['version'], imported.to).toBe(dependency!.properties['version']);
      expect(ex.nodes.some((node) => node.key === imported.to), imported.to).toBe(false);
    }
    const known = new Set([...ex.nodes, ...dataModel.nodes, ...operations.nodes].map((node) => node.key));
    for (const edge of ex.edges) {
      expect(known.has(edge.from), `${edge.type} from ${edge.from}`).toBe(true);
      expect(known.has(edge.to), `${edge.type} to ${edge.to}`).toBe(true);
    }
    const seen = new Set<string>();
    for (const edge of ex.edges) {
      const id = `${edge.type}\u0000${edge.from}\u0000${edge.to}\u0000${edge.discriminator}`;
      expect(seen.has(id), id).toBe(false);
      seen.add(id);
    }
    for (const gap of ex.gaps) {
      expect(gap.path.length).toBeGreaterThan(0);
      expect(gap.reason.length).toBeGreaterThan(0);
    }
    expect(ex.producer).toBe('code.extract.code');
  });

  test('the handler a route names resolves to a symbol node: contracts and code share one key shape', () => {
    const symbols = new Set(ex.nodes.filter((n) => n.kind === KIND_SYMBOL).map((n) => n.key));
    const withHandler = contracts.nodes.filter((n) => typeof n.properties['handlerKey'] === 'string');
    expect(withHandler.length).toBeGreaterThan(0);
    for (const route of withHandler) expect(symbols.has(route.properties['handlerKey'] as string), `${route.key} -> ${route.properties['handlerKey']}`).toBe(true);
    expect(withHandler.map((n) => n.properties['handlerKey'])).toContain(sym(HANDLERS, 'OrderHandlers.Create'));
  });

  test('a file that cannot be read becomes a gap, never a silence', async () => {
    const broken: TreeReader = {
      paths: ['services/x/go.mod', 'services/x/a.go', 'services/x/b.ts'],
      read(p) {
        if (p === 'services/x/a.go') return new Uint8Array([0xff, 0xfe, 0xfd]);
        if (p === 'services/x/go.mod') return new TextEncoder().encode('module example.test/x\n');
        throw new Error(`disk failure reading ${p}`);
      },
    };
    const result = await extractCode(broken);
    const paths = result.gaps.map((g) => g.path);
    expect(paths).toContain('services/x/a.go');
    expect(paths).toContain('services/x/b.ts');
    expect(result.gaps.find((g) => g.path === 'services/x/b.ts')!.reason).toContain('disk failure');
  });
});
