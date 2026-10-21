// The plan of the generated repository's history: about seventy commits over
// six months by three authors, replayed by generate.mjs over the files of
// template/. A commit changes a file only through the directives in the
// template file ("@@ since <id> [until <id>]"), so the plan says which files
// appear, move or vanish and which of the three planted files each commit
// touches (generate.mjs fails when a declaration and the files disagree).
//
// Ids are the vocabulary of the directives in template/. Task keys are numbered
// in the order of the plan.

export const AUTHORS = {
  rin: {name: 'Rin Tanaka', email: 'rin@example.com'},
  avery: {name: 'Avery Quinn', email: 'avery@example.com'},
  sam: {name: 'Sam Okafor', email: 'sam@example.com'},
};

/** The three files the key counts commits on; a commit declares which it touches. */
export const TAGGED_FILES = {
  hotspot: 'services/orders/internal/application/order_service.go',
  pricing: 'services/orders/internal/pricing/pricing.go',
  tax: 'services/orders/internal/pricing/tax.go',
};

const ORDERS = 'services/orders/';
const PAYMENTS = 'services/payments/';
const CHECKOUT = 'services/checkout/';
const PROMOTIONS = 'services/promotions/';
const under = (prefix, ...names) => names.map((n) => prefix + n);

let counter = 100;
function commit(id, date, author, prefix, message, rest = {}) {
  counter += 1;
  return {id, date: `${date}:00Z`, author, message: `${prefix}-${counter} ${message}`, ...rest};
}

export const COMMITS = [
  commit('bootstrap', '2026-04-13T09:30', 'avery', 'OPS', 'Bootstrap the repository with README, Makefile and compose file', {
    add: ['README.md', '.gitignore', 'Makefile', 'docker-compose.yml', {tpl: '_env.example', as: '.env.example'}, 'scripts/init-databases.sql'],
  }),
  commit('vision', '2026-04-14T11:05', 'sam', 'DOC', 'Write the vision and the first requirements', {
    add: ['docs/vision.md', 'docs/requirements.md'],
  }),
  commit('aggregate', '2026-04-16T14:20', 'avery', 'ORD', 'Start the orders service with the order aggregate', {
    add: [
      {tpl: `${ORDERS}internal/domain/order.go`, as: `${ORDERS}src/order.go`},
      ...under(ORDERS, 'migrations/0001_customers.sql', 'migrations/0002_orders.sql', 'README.md'),
    ],
  }),
  commit('place', '2026-04-20T10:10', 'avery', 'ORD', 'Place an order through the application service', {
    add: under(ORDERS, 'go.mod', 'cmd/orders/main.go', 'internal/application/order_service.go', 'internal/api/router.go', 'internal/api/handlers.go',
      'internal/config/config.go', 'internal/logging/logger.go', 'internal/store/db.go', 'internal/store/order_repository.go', 'migrations/0003_order_items.sql'),
    touches: ['hotspot'],
  }),
  commit('pricing', '2026-04-22T16:45', 'avery', 'ORD', 'Price orders with a discount and a tax', {
    add: under(ORDERS, 'internal/pricing/pricing.go', 'internal/pricing/tax.go', 'internal/pricing/pricing_test.go'),
    touches: ['hotspot', 'pricing', 'tax'],
  }),
  commit('checkout-start', '2026-04-27T09:50', 'sam', 'CHK', 'Start the checkout backend for the frontend', {
    add: under(CHECKOUT, 'package.json', 'tsconfig.json', 'README.md', 'src/app.ts', 'src/config.ts', 'src/index.ts', 'src/logging/logger.ts',
      'src/pricing.ts', 'src/orders-client.ts', 'src/checkout-service.ts', 'src/api/routes.ts'),
  }),
  commit('payments-start', '2026-05-04T10:30', 'rin', 'PAY', 'Start the payments service with Express', {
    add: under(PAYMENTS, 'package.json', 'tsconfig.json', 'README.md', 'src/app.ts', 'src/config.ts', 'src/index.ts', 'src/logging/logger.ts',
      'src/domain/payment.ts', 'src/domain/payment-service.ts', 'src/api/routes.ts', 'src/api/middleware.ts'),
  }),
  commit('loyalty-plan', '2026-05-05T15:00', 'sam', 'DOC', 'Plan the loyalty service as a to-be', {add: ['docs/plans/loyalty.md']}),
  commit('cardnet', '2026-05-07T11:40', 'rin', 'PAY', 'Add the cardnet provider behind PaymentProvider', {
    add: under(PAYMENTS, 'src/providers/provider.ts', 'src/providers/cardnet.ts', 'src/http-client.ts'),
  }),
  commit('factory', '2026-05-11T13:15', 'rin', 'PAY', 'Choose the payment provider from configuration', {
    add: under(PAYMENTS, 'src/providers/factory.ts', 'test/factory.test.ts', 'jest.config.js'),
  }),
  commit('deferred', '2026-05-13T10:05', 'rin', 'PAY', 'Add the deferred settlement provider', {add: under(PAYMENTS, 'src/providers/deferred.ts')}),
  commit('move-domain', '2026-05-14T17:30', 'avery', 'ORD', 'Move the order aggregate under internal/domain', {
    move: [[`${ORDERS}src/order.go`, `${ORDERS}internal/domain/order.go`]],
    touches: ['hotspot'],
  }),
  commit('read-orders', '2026-05-18T09:20', 'avery', 'ORD', 'Read and list orders over HTTP', {add: ['contracts/openapi/orders.yaml'], touches: ['hotspot']}),
  commit('arch-docs', '2026-05-20T12:00', 'sam', 'DOC', 'Describe the architecture, the glossary and the broker choice', {
    add: ['docs/architecture.md', 'docs/glossary.md', 'docs/adr/0001-broker.md'],
  }),
  commit('cancel-ship', '2026-05-25T10:40', 'avery', 'ORD', 'Cancel and ship orders', {touches: ['hotspot']}),
  commit('outbox-write', '2026-05-28T15:10', 'avery', 'ORD', 'Write order events to the outbox in the order transaction', {
    add: [...under(ORDERS, 'internal/store/outbox.go', 'migrations/0004_outbox.sql'), 'docs/adr/0002-outbox.md'],
    touches: ['hotspot'],
  }),
  commit('relay', '2026-05-30T11:25', 'avery', 'ORD', 'Relay the outbox to Kafka', {
    add: [...under(ORDERS, 'internal/relay/relay.go', 'internal/relay/kafka.go'), 'contracts/asyncapi/order-events.yaml'],
  }),
  commit('persist-pay', '2026-06-03T10:00', 'rin', 'PAY', 'Persist payments and make pay idempotent', {
    add: under(PAYMENTS, 'src/store/payment-repository.ts', 'prisma/schema.prisma', 'prisma/migrations/migration_lock.toml',
      'prisma/migrations/20260603000000_create_payments/migration.sql'),
  }),
  commit('payment-events', '2026-06-05T14:35', 'rin', 'PAY', 'Publish payment events to Kafka', {add: under(PAYMENTS, 'src/events/publishers.ts')}),
  commit('consume-events', '2026-06-09T09:55', 'avery', 'ORD', 'Confirm or cancel orders from payment events', {
    add: under(ORDERS, 'internal/consumer/payments.go'),
    touches: ['hotspot'],
  }),
  commit('grpc-server', '2026-06-11T13:00', 'rin', 'PAY', 'Serve payments over gRPC', {add: ['contracts/proto/payments.proto', ...under(PAYMENTS, 'src/grpc/server.ts')]}),
  commit('grpc-client', '2026-06-12T16:20', 'sam', 'CHK', 'Authorize payments over gRPC from checkout', {add: under(CHECKOUT, 'src/payments-client.ts')}),
  commit('promotions-start', '2026-06-16T10:15', 'sam', 'PRM', 'Start the promotions service with a percent strategy', {
    add: under(PROMOTIONS, 'go.mod', 'README.md', 'cmd/promotions/main.go', 'internal/api/handler.go', 'internal/discount/strategy.go',
      'internal/logging/logger.go', 'internal/store/promotions.go', 'migrations/0001_promotions.sql'),
  }),
  commit('strategies', '2026-06-18T11:50', 'sam', 'PRM', 'Add fixed-amount and spend-threshold strategies'),
  commit('apply-promotion', '2026-06-23T14:05', 'sam', 'CHK', 'Apply promotions in checkout and accept the discount percent in orders', {
    add: under(CHECKOUT, 'src/promotions-client.ts'),
    touches: ['hotspot'],
  }),
  commit('jwt', '2026-06-25T10:25', 'avery', 'ORD', 'Authenticate requests with JWT and log them', {add: [...under(ORDERS, 'internal/api/middleware.go'), 'scripts/token.mjs']}),
  commit('errors', '2026-06-30T15:45', 'avery', 'ORD', 'Typed domain errors and an error handling middleware', {touches: ['hotspot']}),
  commit('retries', '2026-07-02T12:10', 'rin', 'PAY', 'Retry provider calls with backoff and a timeout', {add: under(PAYMENTS, 'src/resilience.ts')}),
  commit('refunds', '2026-07-07T09:40', 'rin', 'PAY', 'Add refunds to the payment flow', {
    add: under(PAYMENTS, 'src/domain/refund.ts', 'prisma/migrations/20260707000000_create_refunds/migration.sql'),
  }),
  commit('refunded-status', '2026-07-09T14:30', 'avery', 'ORD', 'Move refunded orders to a refunded status', {touches: ['hotspot']}),
  commit('tax-rounding', '2026-07-14T10:55', 'avery', 'ORD', 'Round tax per line and fix zero-rated items', {touches: ['hotspot', 'pricing', 'tax']}),
  commit('preview', '2026-07-15T13:25', 'sam', 'CHK', 'Show tax and discount in the checkout preview', {
    add: under(CHECKOUT, 'test/pricing.test.ts', 'jest.config.js'),
    touches: ['hotspot'],
  }),
  commit('legacy-report', '2026-07-17T11:15', 'rin', 'PAY', 'Add the legacy settlement report endpoint', {add: under(PAYMENTS, 'src/api/legacy-report.ts', 'src/format.ts')}),
  commit('locks', '2026-07-20T10:00', 'avery', 'OPS', 'Commit the lock files of every service', {
    add: [...under(PAYMENTS, 'package-lock.json'), ...under(CHECKOUT, 'package-lock.json'), ...under(ORDERS, 'go.sum'), ...under(PROMOTIONS, 'go.sum')],
  }),
  commit('idempotent-place', '2026-07-21T14:50', 'avery', 'ORD', 'Place orders idempotently by request id', {
    add: under(ORDERS, 'migrations/0005_order_request_id.sql'),
    touches: ['hotspot'],
  }),
  commit('export', '2026-07-22T09:30', 'avery', 'ORD', 'Export orders as CSV', {add: under(ORDERS, 'internal/api/export.go'), touches: ['hotspot']}),
  commit('containers', '2026-07-23T16:05', 'avery', 'OPS', 'Containerize the services and add them to compose', {
    add: [...under(ORDERS, 'Dockerfile'), ...under(PROMOTIONS, 'Dockerfile'), ...under(PAYMENTS, 'Dockerfile'), ...under(CHECKOUT, 'Dockerfile'),
      'scripts/seed-orders.sql', 'scripts/seed-promotions.sql', 'deploy/k8s/orders.yaml'],
  }),
  commit('customers-check', '2026-07-24T11:35', 'avery', 'ORD', 'Reject orders from unknown customers', {touches: ['hotspot']}),
  commit('metrics', '2026-07-27T10:20', 'avery', 'ORD', 'Count requests and orders at /metrics', {add: under(ORDERS, 'internal/api/metrics.go'), touches: ['hotspot']}),
  // The feature branch forks here; main goes on while it is open.
  commit('request-ids', '2026-07-28T13:40', 'sam', 'CHK', 'Propagate request ids through checkout', {branch: 'feature/checkout-observability'}),
  commit('request-id-log', '2026-07-29T10:50', 'avery', 'ORD', 'Log the request id in the order service', {
    branch: 'feature/checkout-observability',
    touches: ['hotspot'],
  }),
  commit('refund-cap', '2026-07-30T15:30', 'rin', 'PAY', 'Reject refunds over the captured amount'),
  commit('half-up', '2026-08-03T12:20', 'avery', 'ORD', 'Use half-up rounding for discounts and tax', {touches: ['pricing', 'tax']}),
  {
    merge: 'feature/checkout-observability',
    date: '2026-08-04T10:00:00Z',
    author: 'avery',
    message: 'CHK-142 Merge feature/checkout-observability: request ids from checkout to orders',
  },
  commit('log-transitions', '2026-08-05T11:10', 'avery', 'ORD', 'Log every order transition', {touches: ['hotspot']}),
  commit('tax-zero', '2026-08-06T15:20', 'avery', 'ORD', 'Stop taxing zero and negative amounts', {touches: ['tax']}),
  commit('discount-cap', '2026-08-10T10:30', 'avery', 'ORD', 'Reject negative discounts and cap them at the subtotal', {touches: ['hotspot', 'pricing']}),
  commit('glossary-fix', '2026-08-12T14:00', 'sam', 'DOC', 'Define CardToken and PaymentToken in the glossary'),
  commit('paging', '2026-08-14T16:40', 'avery', 'ORD', 'Page the order list with a cursor', {touches: ['hotspot']}),
  // snapshot-2026-08-15 is the commit above.
  commit('refund-window', '2026-08-18T09:45', 'rin', 'PAY', 'Count the refund window from the capture date', {add: under(PAYMENTS, 'test/refund.test.ts')}),
  commit('expiry', '2026-08-20T13:10', 'avery', 'ORD', 'Expire unshipped orders after 90 days', {add: under(ORDERS, 'cmd/orders/retention.go'), touches: ['hotspot']}),
  commit('tax-bp', '2026-08-24T10:15', 'avery', 'ORD', 'Compute tax in basis points to avoid float drift', {touches: ['pricing', 'tax']}),
  commit('pay-log', '2026-08-26T14:25', 'rin', 'PAY', 'Log pay attempts with the idempotency key'),
  commit('duplicate-events', '2026-08-27T11:00', 'avery', 'ORD', 'Ignore payment events that were already applied', {touches: ['hotspot']}),
  commit('validate', '2026-08-31T15:35', 'avery', 'ORD', 'Validate order items and quantities', {touches: ['hotspot']}),
  commit('decline-reason', '2026-09-02T10:05', 'avery', 'ORD', 'Keep the decline reason on cancelled orders', {touches: ['hotspot']}),
  commit('domain-tests', '2026-09-04T13:55', 'avery', 'ORD', 'Test the state machine and the retention rule', {add: under(ORDERS, 'internal/domain/order_test.go')}),
  commit('customer-filter', '2026-09-07T09:35', 'avery', 'ORD', 'List only the customer\'s own orders', {touches: ['hotspot']}),
  commit('drop-legacy-format', '2026-09-09T12:45', 'rin', 'PAY', 'Stop using the legacy invoice format in the report'),
  commit('full-payload', '2026-09-11T10:20', 'avery', 'ORD', 'Publish the full order in outbox messages'),
  commit('batch-delete', '2026-09-14T14:15', 'avery', 'ORD', 'Delete expired orders in batches', {touches: ['hotspot']}),
  // The committer date of this commit is earlier than its parent's: the clock of the machine it was
  // rebuilt on was wrong. Its author date is right.
  commit('pin-toolchain', '2026-09-16T09:30', 'avery', 'OPS', 'Pin the Go toolchain in the Dockerfiles', {committerDate: '2026-09-04T09:30:00Z'}),
  commit('trim-ids', '2026-09-18T11:40', 'avery', 'ORD', 'Trim ids and request ids on the way in', {touches: ['hotspot']}),
  commit('claim-rows', '2026-09-21T10:10', 'avery', 'ORD', 'Claim outbox rows with SKIP LOCKED in the relay'),
  commit('promo-round', '2026-09-23T15:00', 'sam', 'PRM', 'Round promotion discounts down'),
  commit('service-tests', '2026-09-25T13:20', 'avery', 'ORD', 'Test the order service with an in-memory store', {add: under(ORDERS, 'internal/application/order_service_test.go')}),
  commit('rounding-mode', '2026-09-28T10:45', 'avery', 'ORD', 'Round half away from zero for negative amounts', {touches: ['pricing', 'tax']}),
  commit('pay-tests', '2026-10-01T12:30', 'rin', 'PAY', 'Cover the pay path with tests', {add: under(PAYMENTS, 'test/pay.test.ts')}),
  commit('requirements-align', '2026-10-05T11:20', 'sam', 'DOC', 'Align the requirements with refunds and promotions'),
  commit('deadlines', '2026-10-07T10:00', 'avery', 'ORD', 'Bound every order call with a deadline', {touches: ['hotspot']}),
  commit('report-extras', '2026-10-08T14:40', 'rin', 'PAY', 'Add the order ledger and reconciliation reports'),
  commit('e2e', '2026-10-09T13:05', 'sam', 'CHK', 'Test the checkout path end to end, declined payment included', {
    add: under(CHECKOUT, 'test/checkout.e2e.test.ts', 'test/payments-stub.ts'),
  }),
  commit('ci', '2026-10-12T09:50', 'avery', 'OPS', 'Run every service\'s checks in CI', {add: ['.github/workflows/ci.yml']}),
];

/** Named snapshots of the key: the commit that is the latest at that date. */
export const SNAPSHOTS = {
  'snapshot-2026-05-01': 'checkout-start',
  'snapshot-2026-06-01': 'relay',
  'snapshot-2026-08-15': 'paging',
  'snapshot-final': 'ci',
};
