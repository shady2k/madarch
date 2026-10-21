/**
 * The contracts extractor (src/extract/contracts) against the training
 * repository (madarch-o0eq.1). One generation of the repository feeds every
 * case; the expected values come from examples/training-repository/answer-key.json
 * -- the item's own locations, anchors and judge.mustShow -- never from the
 * extractor's output. Each case's name carries the key item id it asserts.
 */
import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp, readFile, readdir, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  KIND_CONTRACT,
  KIND_ENTRY_POINT,
  KIND_INPUT,
  KIND_OPERATION,
  KIND_SQL_BUILD,
  KIND_SQL_SINK,
  REL_CALLS_REMOTE,
  REL_CONSUMES,
  REL_FLOWS_INTO,
  REL_PUBLISHES,
  REL_SERVES,
  channelKey,
  contractKey,
  entryPointKey,
  fileKey,
  inputKey,
  messageKey,
  operationKey,
  routeKey,
  sqlBuildKey,
  sqlSinkKey,
} from '../src/extract/contracts/schema.js';
import {extractContracts} from '../src/extract/contracts/index.js';
import type {Extraction, ExtractedEdge, ExtractedNode, TreeReader} from '../src/extract/records.js';

const testFolder = path.dirname(fileURLToPath(import.meta.url));
const checkoutRoot = path.resolve(testFolder, '..');
const key: AnswerKey = JSON.parse(
  await readFile(path.join(checkoutRoot, 'examples/training-repository/answer-key.json'), 'utf8'),
);

interface AnswerKeyItem {
  id: string;
  locations?: readonly {snapshot: string; path: string; symbol?: string; anchor?: string}[];
  location?: {snapshot: string; path: string; symbol?: string; anchor?: string};
  expectedWikiStatement: string;
  evidenceClass: string;
  judge: {mustShow: readonly string[]; mustNotClaim?: readonly string[]};
}
interface AnswerKey {
  fixtureVersion: string;
  items: AnswerKeyItem[];
}

/** The answer-key item of one case; the test fails when the id is not in the key. */
function item(id: string): AnswerKeyItem {
  const found = key.items.find((entry) => entry.id === id);
  if (!found) throw new Error(`answer-key.json holds no item ${id}`);
  return found;
}

/** Paths sorted by code point, the order a TreeReader carries. */
function byCodePoint(a: string, b: string): number {
  const left = Array.from(a).map((c) => c.codePointAt(0)!);
  const right = Array.from(b).map((c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  }
  return left.length - right.length;
}

/** A TreeReader over a generated folder, the way the driver would hand a tree over. */
async function folderReader(dir: string): Promise<{reader: TreeReader; folder: string}> {
  const walk = async (prefix: string): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await readdir(prefix ? path.join(dir, prefix) : dir)) {
      const rel = prefix ? `${prefix}/${entry}` : entry;
      const full = path.join(dir, rel);
      if ((await stat(full)).isDirectory()) {
        if (entry !== '.git' && entry !== 'node_modules') out.push(...(await walk(rel)));
      } else {
        out.push(rel);
      }
    }
    return out;
  };
  const paths = (await walk('')).sort(byCodePoint);
  const bytes = new Map<string, Uint8Array>();
  for (const p of paths) bytes.set(p, new Uint8Array(await readFile(path.join(dir, p))));
  return {
    folder: dir,
    reader: {
      paths,
      read(p: string): Uint8Array {
        const held = bytes.get(p);
        if (held === undefined) throw new Error(`no such path in the tree: ${p}`);
        return held;
      },
    },
  };
}

let extraction: Extraction;

beforeAll(async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'madarch-o0eq1-'));
  const generated = path.join(scratch, 'training-repository');
  execFileSync('node', [path.join(checkoutRoot, 'examples/training-repository/generate.mjs'), generated], {
    cwd: checkoutRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const {reader} = await folderReader(generated);
  extraction = await extractContracts(reader);
  await rm(scratch, {recursive: true, force: true});
}, 240_000);

afterAll(async () => {
  // The scratch folder is removed in beforeAll's own scope; nothing else lives past the run.
});

/** The one node of a key, failing with a listing when it is absent. */
function node(keyText: string): ExtractedNode {
  const found = extraction.nodes.find((n) => n.key === keyText);
  if (!found) {
    const near = extraction.nodes.filter((n) => n.key.split(':')[0] === keyText.split(':')[0]).map((n) => n.key);
    throw new Error(`no node ${keyText}; the extractor holds: ${near.join(', ') || '(none)'}`);
  }
  return found;
}

function nodesOfKind(kind: string): ExtractedNode[] {
  return extraction.nodes.filter((n) => n.kind === kind);
}

function edgesOf(type: string): ExtractedEdge[] {
  return extraction.edges.filter((e) => e.type === type);
}

function expectEdge(type: string, from: string, to: string): ExtractedEdge {
  const found = extraction.edges.filter((e) => e.type === type && e.from === from && e.to === to);
  if (found.length !== 1) {
    const held = edgesOf(type).map((e) => `${e.from} -> ${e.to}`).join(', ');
    throw new Error(`expected exactly one ${type} edge ${from} -> ${to}; the extractor holds: ${held || '(none)'}`);
  }
  return found[0]!;
}

/** The start entries of one entry point. */
function startsOf(file: string, symbol: string): readonly {kind: string; symbol: string; path?: string; port?: string}[] {
  const entry = node(entryPointKey(file, symbol));
  const starts = entry.properties['starts'];
  if (!Array.isArray(starts)) throw new Error(`entry point ${file}#${symbol} carries no starts list`);
  return starts as readonly {kind: string; symbol: string; path?: string; port?: string}[];
}

describe('extract contracts (training repository)', () => {
  test('diagnostic: what the extractor held', () => {
    const kinds = new Map<string, number>();
    for (const node of extraction.nodes) kinds.set(node.kind, (kinds.get(node.kind) ?? 0) + 1);
    console.log('nodes:', [...kinds.entries()].sort().map(([k, n]) => `${k}=${n}`).join(' '));
    console.log('edges:', extraction.edges.map((e) => `${e.type} ${e.from} -> ${e.to}`).sort().join(' | '));
    console.log('gaps:', extraction.gaps.map((gap) => `${gap.path}: ${gap.reason}`).join(' | ') || '(none)');
  });

  test('every answer-key item of the contracts areas is carried', () => {
    const mine = key.items.filter((i) => /^(contract|entrypoints|interaction|security)\./.test(i.id));
    expect(mine.length).toBe(19);
    for (const i of mine) expect(i.evidenceClass).toBe('code-fact');
  });

  // ---- entry points --------------------------------------------------------

  test('entrypoints.orders: one main starting the HTTP server, the relay, the consumer and the retention job', () => {
    const it = item('entrypoints.orders');
    const file = it.locations![0]!.path;
    const main = node(entryPointKey(file, 'main'));
    expect(main.kind).toBe(KIND_ENTRY_POINT);
    const starts = startsOf(file, 'main');
    // The key's locations carry the started loops as anchors; each must appear as a start.
    const anchors = it.locations!.map((l) => l.anchor).filter((a): a is string => a !== undefined);
    expect(starts.some((s) => s.kind === 'http-server')).toBe(true);
    for (const anchor of ['relay.New(db, publisher, log, time.Second).Run(ctx)', 'consumer.NewPaymentEvents(cfg.KafkaBrokers, orders, log).Run(ctx)']) {
      expect(anchors).toContain(anchor);
      expect(starts.some((s) => s.symbol.includes(anchor))).toBe(true);
    }
    // The retention job lives in its own file (the key's last location).
    const retention = it.locations!.at(-1)!;
    expect(starts.some((s) => s.symbol.includes('runRetention') && s.path === retention.path)).toBe(true);
  });

  test('entrypoints.payments: HTTP on 8081 and gRPC on 50051 from main', () => {
    const it = item('entrypoints.payments');
    const file = it.locations![0]!.path;
    expect(node(entryPointKey(file, 'main')).kind).toBe(KIND_ENTRY_POINT);
    const starts = startsOf(file, 'main');
    expect(starts.some((s) => s.kind === 'http-server' && s.port === '8081')).toBe(true);
    expect(starts.some((s) => s.kind === 'grpc-server' && s.port === '50051')).toBe(true);
  });

  test('entrypoints.promotions: one HTTP server on 8082', () => {
    const it = item('entrypoints.promotions');
    const file = it.location!.path;
    expect(node(entryPointKey(file, 'main')).kind).toBe(KIND_ENTRY_POINT);
    expect(startsOf(file, 'main').some((s) => s.kind === 'http-server' && s.port === '8082')).toBe(true);
  });

  test('entrypoints.checkout: one Express server on 8083 from index.ts', () => {
    const it = item('entrypoints.checkout');
    const file = it.location!.path;
    const entry = nodesOfKind(KIND_ENTRY_POINT).find((n) => n.key.startsWith(`${'code.entry-point'}:${file}#`));
    expect(entry).toBeDefined();
    const starts = startsOf(file, (entry!.properties['symbol'] as string) ?? 'main');
    expect(starts.some((s) => s.kind === 'http-server' && s.port === '8083')).toBe(true);
  });

  // ---- contracts -----------------------------------------------------------

  test('contract.openapi.orders: the orders.yaml operations served by orders and called by checkout', () => {
    const it = item('contract.openapi.orders');
    const contractPath = it.locations![0]!.path;
    expect(node(contractKey(contractPath)).kind).toBe(KIND_CONTRACT);
    // The anchor names the operationId of the placed-order operation.
    const routerLocation = it.locations![1]!;
    const clientLocation = it.locations![2]!;
    const operation = operationKey(contractPath, 'POST:/orders');
    expect(node(operation).properties['operationId']).toBe('createOrder');
    const served = expectEdge(REL_SERVES, routeKey(routerLocation.path, 'POST', '/orders'), operation);
    expect(served.from.startsWith('code.route:')).toBe(true);
    const called = expectEdge(REL_CALLS_REMOTE, fileKey(clientLocation.path), operation);
    expect(called.properties['client']).toBe(`OrdersClient.${clientLocation.symbol}`);
    expect(called.span?.path).toBe(clientLocation.path);
  });

  test('contract.openapi.export: exportOrders is served by OrderHandlers.Export outside the auth group', () => {
    const it = item('contract.openapi.export');
    const contractPath = it.locations![0]!.path;
    const operation = operationKey(contractPath, 'GET:/orders/export');
    expect(node(operation).properties['operationId']).toBe('exportOrders');
    expect(node(operation).properties['public']).toBe(true);
    const handlerLocation = it.locations![1]!;
    const served = edgesOf(REL_SERVES).find((e) => e.to === operation);
    expect(served).toBeDefined();
    const route = node(served!.from);
    expect(route.properties['handlerSymbol']).toBe('OrderHandlers.Export');
    expect(route.properties['handlerPath']).toBe(handlerLocation.path);
    expect(route.properties['authGroup']).toBe(false);
  });

  test('contract.proto.payments: the Payments service served by payments and called by checkout', () => {
    const it = item('contract.proto.payments');
    const protoPath = it.locations![0]!.path;
    expect(node(contractKey(protoPath)).kind).toBe(KIND_CONTRACT);
    const serverLocation = it.locations![1]!;
    const clientLocation = it.locations![2]!;
    const authorize = operationKey(protoPath, 'payments.v1.Payments/Authorize');
    expect(node(authorize).properties['rpc']).toBe('Authorize');
    // The proto's second rpc (Refund) stands in the same service (the key's wiki statement names both).
    expect(node(operationKey(protoPath, 'payments.v1.Payments/Refund')).properties['rpc']).toBe('Refund');
    const served = expectEdge(REL_SERVES, fileKey(serverLocation.path), authorize);
    expect(served.properties['handler']).toBe('paymentsHandlers.authorize');
    expect(served.span?.path).toBe(serverLocation.path);
    const called = expectEdge(REL_CALLS_REMOTE, fileKey(clientLocation.path), authorize);
    expect(called.properties['client']).toBe(`PaymentsClient.${clientLocation.symbol}`);
    expect(called.span?.path).toBe(clientLocation.path);
  });

  test('contract.asyncapi.orders-events: the orders.events channel written by the outbox relay', () => {
    const it = item('contract.asyncapi.orders-events');
    const contractPath = it.locations![0]!.path;
    expect(node(contractKey(contractPath)).kind).toBe(KIND_CONTRACT);
    expect(node(channelKey('orders.events')).kind).toBe('code.channel');
    expect(node(messageKey(contractPath, 'OrderChanged')).kind).toBe('code.message');
    // The relay publishes; the topic is named by the constant in store/outbox.go.
    const relayLocation = it.locations![2]!;
    const constantLocation = it.locations![1]!;
    const published = expectEdge(REL_PUBLISHES, fileKey(relayLocation.path), channelKey('orders.events'));
    expect(published.span?.path).toBe(relayLocation.path);
    expect(published.properties['constant']).toBe('OrdersTopic');
    expect(published.properties['constantPath']).toBe(constantLocation.path);
    expect(published.properties['via']).toBe('outbox');
  });

  test('contract.asyncapi.payments-events: payments.events published by payments, consumed by orders', () => {
    const it = item('contract.asyncapi.payments-events');
    const contractPath = it.locations![0]!.path;
    expect(node(channelKey('payments.events')).kind).toBe('code.channel');
    expect(node(messageKey(contractPath, 'PaymentEvent')).kind).toBe('code.message');
    const publisherLocation = it.locations![1]!;
    const consumerLocation = it.locations![2]!;
    const published = expectEdge(REL_PUBLISHES, fileKey(publisherLocation.path), channelKey('payments.events'));
    expect(published.properties['constant']).toBe('PAYMENTS_TOPIC');
    const consumed = expectEdge(REL_CONSUMES, fileKey(consumerLocation.path), channelKey('payments.events'));
    expect(consumed.span?.path).toBe(consumerLocation.path);
  });

  // ---- interactions --------------------------------------------------------

  test('interaction.checkout-promotions: checkout calls POST /internal/apply and promotions serves it', () => {
    const it = item('interaction.checkout-promotions');
    const clientLocation = it.locations![0]!;
    const serverLocation = it.locations![1]!;
    const route = routeKey(serverLocation.path, 'POST', '/internal/apply');
    expect(node(route).properties['handlerSymbol']).toBe('Handler.apply');
    const called = expectEdge(REL_CALLS_REMOTE, fileKey(clientLocation.path), route);
    expect(called.properties['client']).toBe(`PromotionsClient.${clientLocation.symbol}`);
    expect(called.span?.path).toBe(clientLocation.path);
  });

  test('interaction.checkout-orders: place and cancel over HTTP with the bearer token forwarded', () => {
    const it = item('interaction.checkout-orders');
    const clientLocation = it.locations![0]!;
    const serverLocation = it.locations![1]!;
    const contractPath = 'contracts/openapi/orders.yaml';
    const place = expectEdge(REL_CALLS_REMOTE, fileKey(clientLocation.path), operationKey(contractPath, 'POST:/orders'));
    expect(place.properties['client']).toBe('OrdersClient.placeOrder');
    expect(place.properties['tokenForwarded']).toBe(true);
    const cancel = expectEdge(REL_CALLS_REMOTE, fileKey(clientLocation.path), operationKey(contractPath, 'POST:/orders/{id}/cancel'));
    expect(cancel.properties['client']).toBe('OrdersClient.cancelOrder');
    expect(cancel.properties['tokenForwarded']).toBe(true);
    expect(node(routeKey(serverLocation.path, 'POST', '/orders')).kind).toBe('code.route');
  });

  test('interaction.checkout-payments: Authorize over gRPC with a deadline', () => {
    const it = item('interaction.checkout-payments');
    const clientLocation = it.locations![0]!;
    const protoPath = 'contracts/proto/payments.proto';
    const called = expectEdge(
      REL_CALLS_REMOTE,
      fileKey(clientLocation.path),
      operationKey(protoPath, 'payments.v1.Payments/Authorize'),
    );
    expect(called.properties['client']).toBe(clientLocation.symbol);
    expect(called.properties['deadlineMs']).toBe(8000);
  });

  test('interaction.payments-events: the three payment event types on payments.events keyed by order id', () => {
    const it = item('interaction.payments-events');
    const publisherLocation = it.locations![0]!;
    const published = expectEdge(REL_PUBLISHES, fileKey(publisherLocation.path), channelKey('payments.events'));
    expect(published.properties['publisher']).toBe(publisherLocation.symbol);
    expect(published.properties['key']).toBe('payment.orderId');
    expect(published.properties['eventTypes']).toEqual(['payment.captured', 'payment.failed', 'payment.refunded']);
  });

  test('interaction.orders-events: OrderChanged to orders.events through the outbox relay', () => {
    const it = item('interaction.orders-events');
    const relayLocation = it.locations![0]!;
    const published = expectEdge(REL_PUBLISHES, fileKey(relayLocation.path), channelKey('orders.events'));
    expect(published.span?.path).toBe(relayLocation.path);
    expect(published.properties['via']).toBe('outbox');
  });

  test('interaction.orders-consumes-payments: group orders, the event mapping, and the unconditional offset commit', () => {
    const it = item('interaction.orders-consumes-payments');
    const consumerLocation = it.locations![0]!;
    const handlerLocation = it.locations![1]!;
    const consumed = expectEdge(REL_CONSUMES, fileKey(consumerLocation.path), channelKey('payments.events'));
    expect(consumed.properties['group']).toBe('orders');
    expect(consumed.properties['handler']).toBe(`Service.${handlerLocation.symbol}`);
    expect(consumed.properties['handlerPath']).toBe(handlerLocation.path);
    expect(consumed.properties['eventKinds']).toEqual(['payment.captured', 'payment.failed', 'payment.refunded']);
    // The wiki statement: duplicates are handled only by comparing the current status; the offset
    // is committed even when applying the event failed.
    expect(consumed.properties['duplicates']).toBe('status-comparison');
    expect(consumed.properties['offsetCommit']).toBe('unconditional');
  });

  // ---- security ------------------------------------------------------------

  test('security.export-route: GET /orders/export answers outside the auth group', () => {
    const it = item('security.export-route');
    const location = it.location!;
    const route = node(routeKey(location.path, 'GET', '/orders/export'));
    expect(route.properties['authGroup']).toBe(false);
    expect(route.properties['handler']).toBe('deps.Orders.Export');
    // Every other /orders route requires a token.
    for (const [method, routePath] of [['POST', '/orders'], ['GET', '/orders'], ['GET', '/orders/{id}'], ['POST', '/orders/{id}/cancel']] as const) {
      expect(node(routeKey(location.path, method, routePath)).properties['authGroup']).toBe(true);
    }
  });

  test('security.sql-input: the query parameters reach the SQL through whereClause and $queryRawUnsafe', () => {
    const it = item('security.sql-input');
    const file = it.locations![0]!.path;
    for (const name of ['order', 'status', 'currency']) {
      const input = node(inputKey(file, 'query', name));
      expect(input.kind).toBe(KIND_INPUT);
    }
    const build = node(sqlBuildKey(file, 'whereClause'));
    expect(build.kind).toBe(KIND_SQL_BUILD);
    // The wiki statement names order, status and currency; the builder splices the date bounds too.
    const spliced = build.properties['spliced'] as string[];
    for (const name of ['order', 'status', 'currency']) expect(spliced).toContain(name);
    const sink = node(sqlSinkKey(file, '$queryRawUnsafe'));
    expect(sink.kind).toBe(KIND_SQL_SINK);
    // The chain: the query parameters flow into the builder, the builder into the sink.
    for (const name of ['order', 'status', 'currency']) {
      expectEdge(REL_FLOWS_INTO, inputKey(file, 'query', name), sqlBuildKey(file, 'whereClause'));
    }
    expectEdge(REL_FLOWS_INTO, sqlBuildKey(file, 'whereClause'), sqlSinkKey(file, '$queryRawUnsafe'));
  });

  test('security.auth-group: the auth group verifies HS256; ship needs support; export, healthz and metrics sit outside', () => {
    const it = item('security.auth-group');
    const router = it.locations![0]!.path;
    const middlewareFile = it.locations![1]!.path;
    const inside = node(routeKey(router, 'POST', '/orders'));
    expect(inside.properties['authGroup']).toBe(true);
    expect((inside.properties['middleware'] as string[])).toContain('RequireAuth');
    expect(inside.properties['authAlgorithm']).toBe('HS256');
    const ship = node(routeKey(router, 'POST', '/orders/{id}/ship'));
    expect((ship.properties['middleware'] as string[])).toContain('RequireRole("support")');
    for (const [method, routePath] of [['GET', '/orders/export'], ['GET', '/healthz'], ['GET', '/metrics']] as const) {
      expect(node(routeKey(router, method, routePath)).properties['authGroup']).toBe(false);
    }
    expect(node(routeKey(router, 'GET', '/healthz')).span?.path).toBe(router);
    expect(middlewareFile.endsWith('middleware.go')).toBe(true);
  });

  test('security.payments-auth: /payments and /reports need the HS256 bearer token; /healthz is open', () => {
    const it = item('security.payments-auth');
    const middlewareFile = it.location!.path;
    const app = 'services/payments/src/app.ts';
    const routes = 'services/payments/src/api/routes.ts';
    expect(node(routeKey(app, 'GET', '/healthz')).properties['authGroup']).toBe(false);
    const pay = node(routeKey(routes, 'POST', '/payments'));
    expect(pay.properties['authGroup']).toBe(true);
    expect(pay.properties['authAlgorithm']).toBe('HS256');
    expect((pay.properties['middleware'] as string[])).toContain('authenticate');
    expect(node(routeKey('services/payments/src/api/legacy-report.ts', 'GET', '/reports/legacy')).properties['authGroup']).toBe(true);
    expect(node(routeKey(routes, 'GET', '/payments/:id')).properties['authGroup']).toBe(true);
    expect(node(routeKey(routes, 'POST', '/payments/:id/refunds')).properties['authGroup']).toBe(true);
    expect(middlewareFile.endsWith('middleware.ts')).toBe(true);
  });
});
