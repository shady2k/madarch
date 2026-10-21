# Training repository: what it holds and what the wiki must show

The owner's decision of 2026-10-21 (tracker madarch-9uop, decisions recorded on
madarch-tzte): the training repository is a product we fully understand, so we
judge the wiki against it. It contains every element the wiki must explain to a
newcomer, and an answer key says, item by item, what the wiki must show. This
file is the agreed specification; Codex's critique of the first draft is folded
in.

The generator (`generate.mjs`) keeps today's story — the ordering and payments
slice of `examples/reference-system` — and today's languages: **orders and
promotions in Go, payments and checkout in TypeScript**. Today's answer-key items
(business rules, the order state machine, interactions, the three
contradictions, terms, links, expected open questions) are kept and remapped to
their new locations. Size is not a goal: every file, line and commit exists for a
named observation, nothing is padding.

## The repository

**Documents**
- `README.md`: what the product is, how to run it; keeps today's stale claims.
- `docs/vision.md`: users (shopper, support agent, finance), the value, the
  journeys (place an order, pay, get a refund, use a promotion).
- `docs/requirements.md`: use cases with ids (place order, pay, refund, apply
  promotion), business rules referenced by id from code comments where planted.
- `docs/adr/0001-broker.md` (Kafka chosen, why), `docs/adr/0002-outbox.md`
  (events leave through a transactional outbox).
- `docs/architecture.md`, `docs/glossary.md`.
- One tiny to-be fixture: `docs/plans/loyalty.md` naming one planned service
  (loyalty) and one planned relation (checkout -> loyalty), dated, so the
  architecture-state axis (as-is / to-be) has something to show.

**services/orders (Go, net/http)**
- `cmd/orders/main.go`: the composition root; constructs everything and injects
  dependencies through constructors.
- `internal/api`: routes; a middleware chain (auth, request logging, error
  handling, registered on the router, so the chain is resolvable); one route,
  `GET /orders/export`, registered outside the auth group.
- `internal/domain/order.go`: the Order aggregate and its status state machine
  (today's `services/orders/src/order.go`, moved here by a scripted rename).
- `internal/application/order_service.go`: the use-case service (the hotspot).
- `internal/pricing/pricing.go`, `internal/pricing/tax.go`: change together in
  every commit that touches either, with no import between them.
- `internal/store`: `OrderRepository` on `database/sql`; the outbox table writer
  inside the order transaction; `internal/relay` reads the outbox and publishes
  to Kafka.
- `internal/config`: configuration loaded once (`sync.Once`), the singleton.
- `migrations/*.sql`: customers, orders, order_items, outbox — keys, nullability,
  one-to-many order -> items, applied in a named order.
- Go tests (`TestX`, one table-driven) for the state machine and pricing.

**services/payments (TypeScript, Express)**
- `src/api`: routes and Express middleware; `src/api/legacy-report.ts`, the large
  file (a report endpoint whose SQL is concatenated from a query parameter — the
  untrusted input path is explicit).
- `src/domain` and `src/events` import each other: the planted cycle.
- `src/providers`: two payment providers behind one `PaymentProvider` interface
  (adapters), chosen by `PaymentClientFactory` from configuration (factory); all
  of `src/providers` is written by one author.
- `src/grpc`: the gRPC server implementing `contracts/proto/payments.proto`.
- `src/store`: `PaymentRepository` over Prisma; `prisma/schema.prisma` holds
  payments and refunds; `payments.order_id` is a **logical** reference to the
  orders service (no foreign key, different database).
- `src/format.ts`: exports `formatInvoiceLegacy`, referenced nowhere in the
  repository.
- `src/http-client.ts`: the counter-example — a module-level `let client` that is
  reassigned per request, which looks like a singleton and is not one.
- A TODO and a FIXME, each with a reason.
- Retries, a timeout (`PAYMENT_TIMEOUT_MS`, default 3000 ms in code) and an
  idempotency key on the pay endpoint.
- jest tests for the factory and the refund rule; one skipped test.

**services/promotions (Go)**: discount strategies behind one interface
(strategy); its own migration (promotions table); no tests.

**services/checkout (TypeScript)**: the backend for the frontend; HTTP to orders
(per the OpenAPI contract), gRPC to payments; one end-to-end test of the checkout
path including the payment-declined failure path.

**Contracts**: `contracts/openapi/orders.yaml`, `contracts/proto/payments.proto`,
`contracts/asyncapi/order-events.yaml`; each has implementing code to link to.

**Dependencies**: `package.json` + `package-lock.json` per TypeScript service
(direct, transitive and dev dependencies distinguishable), `go.mod` + `go.sum` per
Go service; one dependency pinned to a deliberately old version (a version fact,
not a vulnerability claim).

**Build and deploy**: a Dockerfile per service; `docker-compose.yml` (postgres,
kafka, the four services, ports, environment); `deploy/k8s/orders.yaml`
(deployment, service, port); `.github/workflows/ci.yml`; a `Makefile` with
`run-orders`, `test`, `up`. The chain deployment -> image -> process -> port is
traceable.

**Configuration**: environment variables read in code — `DATABASE_URL`,
`KAFKA_BROKERS`, `PAYMENT_PROVIDER`, `JWT_SECRET`, `PAYMENT_TIMEOUT_MS`; each with
whether it is required and its default where it has one; `.env.example` and the
compose file define all but `PAYMENT_TIMEOUT_MS`, which falls back to its
default (startup does not fail).

**Observability**: a logger module per service, `/healthz` per service, a
metrics endpoint in orders.

## The history (scripted, deterministic)

About 60 commits on `main` over six months, three authors, task keys in the
messages, fixed committer dates. The commits really add, change and delete code
(the reading at a past date differs from today's). One feature branch merged
into main (its changes appear on main at the merge's date; first-parent order).
One rename with a move (`services/orders/src/order.go` ->
`services/orders/internal/domain/order.go`, content kept). One commit whose
committer date is earlier than its parent's (the date-anomaly policy). Exact
numbers are fixed by the generator and written in the key: how many commits
touch the hotspot, how many touch pricing.go and tax.go together and apart (and
how merges and the rename are counted), the line count of the large file.
Named snapshots (for example `snapshot-2026-06-01`, `snapshot-final`) map to
commits in the key so the expected state at a date is checkable.

## The answer key

`answer-key.json`, beside the generator, never in the output. Top level: fixture
version, the snapshot -> commit map, then one atomic assertion per item:

```json
{
  "id": "config.payment-timeout",
  "location": { "snapshot": "snapshot-final", "path": "services/payments/src/config.ts", "symbol": "paymentTimeoutMs", "anchor": "process.env.PAYMENT_TIMEOUT_MS" },
  "expectedWikiStatement": "Payments reads PAYMENT_TIMEOUT_MS, defaults to 3000 ms, and neither .env.example nor docker-compose.yml defines it.",
  "evidenceClass": "code-fact",
  "viewpoints": ["developer", "operations"],
  "requiredNow": true,
  "judge": {
    "readerTask": "Find the payment timeout and where its value comes from.",
    "mustShow": ["the reading code", "the default", "that no configuration defines it"],
    "mustLink": ["the source expression"],
    "mustNotClaim": ["startup fails because it is undefined"]
  }
}
```

- `evidenceClass`: `code-fact`, `document-fact`, `history-fact`, `inference`.
- Relationships and contradictions carry several locations.
- Temporal items carry the snapshot or date they hold at; the to-be items carry
  their state.
- `requiredNow` is false for items whose pages come later (security, operations
  details); their data must still be extractable.
- Equivalent wording passes; extraction correctness is judged apart from the
  reading task.

The key covers, at least: the stack passport; services and modules with their
purpose and boundaries; the newcomer's first run (prerequisites, folder, command,
seed, one request, tests, one typical failure); the chain route -> middleware ->
handler -> domain -> repository -> table, through calls, references, an interface
implementation and inheritance; that exports are not entry points; each pattern
with its structural evidence, and the counter-example as not a singleton; the
entry points and which code serves each contract; the checkout sequence with its
failure path; the outbox (ADR, table, writer, relay); retries, timeout,
idempotency; the ER model per database with keys and cardinality, and the
logical cross-service reference shown as logical; which code reads and writes
which table; dependencies with versions, direct/transitive/dev; build and deploy
units and ports; environment variables with requiredness, defaults and where
defined; tests by kind with their named cases and subjects, the skipped one, and
promotions untested; the cycle; the large file; the hotspot and the change
coupling with their exact counts; `formatInvoiceLegacy` as "no references in this
repository"; the single-author module as observed authorship; the route outside
the auth group and the concatenated SQL with its input path (requiredNow false);
document -> code links; the rename kept as one identity; the date anomaly; the
to-be loyalty service beside the as-is; and today's agent-stage items.
