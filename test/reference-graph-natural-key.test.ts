/**
 * The one function that names a graph record the way the reference graph names
 * it (`scripts/reference-graph-natural-key.ts`): every kind the reference uses,
 * named from the producer's own key builders (`src/extract/*\/keys.ts`,
 * `.../schema.ts`) and the record fields a digest-keyed record carries. A record
 * that does not say what it is is refused by name; nothing is folded or matched
 * by similarity.
 */
import { describe, expect, test } from 'bun:test';
import { columnKey, databaseKey, indexKey, tableKey } from '../src/extract/data-model/keys.js';
import { channelKey, contractKey, messageKey, operationKey, routeKey } from '../src/extract/contracts/schema.js';
import { naturalKeyOf, serviceOfFile } from '../scripts/reference-graph-natural-key.js';

/** A record as the reader presents it; a static stage hangs its own fields under `record`. */
function rec(kind: string, key: string, record: Record<string, unknown> = {}, label = '', properties: Record<string, unknown> = {}) {
  return { kind, key, label, properties: { record, ...properties } };
}

describe('naturalKeyOf', () => {
  test('a file, a symbol and a module keep the producer\'s own key', () => {
    expect(naturalKeyOf(rec('code.file', 'code.file:services/orders/go.mod'))).toBe('code.file:services/orders/go.mod');
    expect(naturalKeyOf(rec('code.symbol', 'code.symbol:services/orders/internal/pricing/pricing.go#Discount'))).toBe('code.symbol:services/orders/internal/pricing/pricing.go#Discount');
    expect(naturalKeyOf(rec('code.module', 'code.module:services/orders/internal/api'))).toBe('code.module:services/orders/internal/api');
  });

  test('a package is named by the folder its manifest sits in, and a repository by its name', () => {
    expect(naturalKeyOf(rec('code.package', 'package:338afafa', { name: 'checkout', manifest: 'services/checkout/package.json' })))
      .toBe('code.package:services/checkout');
    expect(naturalKeyOf(rec('code.repository', 'repository:8e3639', {}, '', { repository: 'training' }))).toBe('code.repository:training');
  });

  test('a document, its sections, a state, a state machine and a migration are named by what they are', () => {
    expect(naturalKeyOf(rec('code.document', 'document:dca1bb', { path: 'README.md', title: 'Ordering and payments training system' })))
      .toBe('code.document:README.md');
    expect(naturalKeyOf(rec('code.document-section', 'section:017a8a', { document: 'README.md', heading: 'What it does', anchor: 'what-it-does' })))
      .toBe('code.document-section:README.md#What it does');
    expect(naturalKeyOf(rec('code.state', 'code.state:training:services/orders/internal/domain/order.go#transitions/Cancelled', {}, 'cancelled')))
      .toBe('code.state:cancelled');
    expect(naturalKeyOf(rec('code.state-machine', 'code.state-machine:training:services/orders/internal/domain/order.go#transitions', {}, 'transitions')))
      .toBe('code.state-machine:services/orders/internal/domain/order.go#transitions');
    expect(naturalKeyOf(rec('code.migration', 'code.migration:orders/0003_order_items.sql', { path: 'services/orders/migrations/0003_order_items.sql', database: 'orders' })))
      .toBe('code.migration:services/orders/migrations/0003_order_items.sql');
  });

  test('a route is named by its service, its method and its path', () => {
    const key = routeKey('services/orders/internal/api/router.go', 'GET', '/orders/{id}');
    expect(naturalKeyOf(rec('code.route', key))).toBe('code.route:orders:GET /orders/{id}');
    expect(serviceOfFile('services/promotions/internal/api/handler.go')).toBe('promotions');
  });

  test('a table, a column and an index keep the database and the name, and the schema only when it is not public', () => {
    expect(naturalKeyOf(rec('code.table', tableKey('orders', 'orders')))).toBe('code.table:orders.orders');
    expect(naturalKeyOf(rec('code.column', columnKey('orders', 'orders', 'status')))).toBe('code.column:orders.orders.status');
    expect(naturalKeyOf(rec('code.index', indexKey('orders', 'orders', 'orders_customer_idx')))).toBe('code.index:orders.orders_customer_idx');
    expect(naturalKeyOf(rec('code.table', tableKey('orders', 'orders', 'audit')))).toBe('code.table:orders.audit.orders');
    expect(naturalKeyOf(rec('code.database', databaseKey('orders')))).toBe('code.database:orders');
  });

  test('a contract, a channel and a message are named by the contract and the name', () => {
    expect(naturalKeyOf(rec('code.contract', contractKey('contracts/openapi/orders.yaml')))).toBe('code.contract:contracts/openapi/orders.yaml');
    expect(naturalKeyOf(rec('code.channel', channelKey('orders.events')))).toBe('code.channel:orders.events');
    expect(naturalKeyOf(rec('code.message', messageKey('contracts/proto/payments.proto', 'AuthorizeRequest')))).toBe('code.message:contracts/proto/payments.proto#AuthorizeRequest');
  });

  test('an operation is named by its operationId or its RPC name', () => {
    expect(naturalKeyOf(rec('code.operation', operationKey('contracts/openapi/orders.yaml', 'POST:/orders'), { operationId: 'createOrder' })))
      .toBe('code.operation:contracts/openapi/orders.yaml#createOrder');
    expect(naturalKeyOf(rec('code.operation', operationKey('contracts/proto/payments.proto', 'payments.v1.Payments/Authorize'), { rpc: 'Authorize' })))
      .toBe('code.operation:contracts/proto/payments.proto#Authorize');
  });

  test('a digest-keyed record is named by the name it carries', () => {
    expect(naturalKeyOf(rec('code.commit', 'commit:8f2c', { commit: '8f7f63c5ca3ad8fdaa3ef71db4762b3604b39277' })))
      .toBe('code.commit:8f7f63c5ca3ad8fdaa3ef71db4762b3604b39277');
    expect(naturalKeyOf(rec('code.task', 'task:9a1f', { key: 'ORD-113' }, 'ORD-113'))).toBe('code.task:ORD-113');
    expect(naturalKeyOf(rec('code.env-var', 'env:7d2a', { file: '.env.example', name: 'JWT_SECRET' }, 'JWT_SECRET'))).toBe('code.env-var:JWT_SECRET');
    expect(naturalKeyOf(rec('code.dependency', 'dependency:4b1c', { file: 'services/orders/go.mod', name: 'github.com/lib/pq' }, 'github.com/lib/pq v1.10.9')))
      .toBe('code.dependency:services/orders/go.mod#github.com/lib/pq');
  });

  test('a port, a probe, a metric and a logger are named by the thing, not by the file', () => {
    expect(naturalKeyOf(rec('code.port', 'code.port:orders/8080'))).toBe('code.port:orders:8080');
    expect(naturalKeyOf(rec('code.probe', 'code.probe:deploy/k8s/orders.yaml#orders/orders/readiness'))).toBe('code.probe:orders.readiness');
    expect(naturalKeyOf(rec('code.metric', 'code.metric:services/orders/internal/api/metrics.go#orders_created_total', { name: 'orders_created_total' })))
      .toBe('code.metric:orders_created_total');
    expect(naturalKeyOf(rec('code.logger', 'code.logger:services/payments/src/logging/logger.ts#logger'))).toBe('code.logger:payments');
  });

  test('a compose service, a Kubernetes object, a make target and a CI job keep their own names', () => {
    expect(naturalKeyOf(rec('code.compose-service', 'code.compose-service:docker-compose.yml#orders'))).toBe('code.compose-service:orders');
    expect(naturalKeyOf(rec('code.k8s-deployment', 'code.k8s-deployment:deploy/k8s/orders.yaml#orders'))).toBe('code.k8s-deployment:orders');
    expect(naturalKeyOf(rec('code.k8s-service', 'code.k8s-service:deploy/k8s/orders.yaml#orders'))).toBe('code.k8s-service:orders');
    expect(naturalKeyOf(rec('code.make-target', 'code.make-target:Makefile#test'))).toBe('code.make-target:test');
    expect(naturalKeyOf(rec('code.ci-job', 'code.ci-job:.github/workflows/ci.yml#orders'))).toBe('code.ci-job:.github/workflows/ci.yml#orders');
  });

  test('an environment definition keeps the file, the scope and the name', () => {
    expect(naturalKeyOf(rec('code.env-definition', 'code.env-definition:.env.example#JWT_SECRET'))).toBe('code.env-definition:.env.example#JWT_SECRET');
    expect(naturalKeyOf(rec('code.env-definition', 'code.env-definition:docker-compose.yml#payments/JWT_SECRET', { scope: 'payments' })))
      .toBe('code.env-definition:docker-compose.yml#payments/JWT_SECRET');
  });

  test('a newcomer command keeps the README and the command', () => {
    expect(naturalKeyOf(rec('code.newcomer-command', 'code.newcomer-command:README.md#step-2', { command: 'make up' })))
      .toBe('code.newcomer-command:README.md#make up');
  });

  test('a record that does not say what it is is refused by name', () => {
    expect(() => naturalKeyOf(rec('code.route', 'code.route:nothing'))).toThrow(/does not say METHOD:path/);
    expect(() => naturalKeyOf(rec('code.commit', 'commit:8f2c', {}))).toThrow(/the hash of a commit is missing/);
    expect(() => naturalKeyOf(rec('code.table', 'code.table:orders'))).toThrow(/<database>\/<schema>.<table>/);
    expect(() => naturalKeyOf(rec('code.something', 'code.something:x'))).toThrow(/no natural name is known for the kind/);
    expect(() => serviceOfFile('docs/readme.md')).toThrow(/is not under services/);
  });
});
