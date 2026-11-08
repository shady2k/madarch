# Corrections to the reference graph

Each correction is read from the source, never from the fill's graph: the lines
that state the corrected fact are named, and the commit that carries this file
changes nothing else.

## Names that were not the source's own

1. **A Dockerfile's port belonged to a folder, not to a service.**
   `services/checkout/Dockerfile`:16 says `EXPOSE 8083`, and the Dockerfile
   sits in the checkout service; the port's id was `code.port:services/checkout:8083`
   and is now `code.port:checkout:8083`. The same for orders, payments and
   promotions.

2. **A compose environment variable was not said for which service it is
   set.** `docker-compose.yml`:38 sets `DATABASE_URL` for orders, :55 for
   payments, :70 for promotions, and :82 sets `ORDERS_URL` for checkout; orders
   and payments set `JWT_SECRET` (:40, :57) and `KAFKA_BROKERS` (:39, :56). One
   id per variable hid that, so each definition now carries its service:
   `code.env-definition:docker-compose.yml#orders/DATABASE_URL`.

3. **A probe was not named as the manifest names it.**
   `deploy/k8s/orders.yaml`:25, :30 and :35 declare `readinessProbe`,
   `livenessProbe` and `startupProbe`; the ids said `orders.readiness`,
   `orders.liveness`, `orders.startup`.

4. **A newcomer's command was abbreviated.** `README.md`:16 gives the whole
   `curl -s -X POST http://localhost:8080/orders …` command; the id named it
   `curl -X POST /orders`.

5. **A state machine was named by an invented aggregate field.** The source
   declares the machine as the `transitions` table (`services/orders/internal/domain/order.go`:55);
   its id was `code.state-machine:Order.status`.

6. **A document's own title is its first section, and two documents were
   named by a placeholder.** Every Markdown document starts with a level-1
   heading (`README.md`:1, `docs/vision.md`:1, …); the glossary and the plan
   were called `(the terms)` and `(the plan)`, and are now `Glossary`
   (`docs/glossary.md`:1) and `Plan: loyalty` (`docs/plans/loyalty.md`:1).

## Facts the source states that the reference had left out

7. **The columns an index covers.** `0002_orders.sql`:16 covers
   `(customer_id, created_at)`, `0003_order_items.sql`:12 covers `(order_id)`,
   `0004_outbox.sql`:13 covers `(id)`, `0005_order_request_id.sql`:5 covers
   `(customer_id, request_id)`, and the payments migration's :18 and :20 cover
   `(idempotency_key)` and `(order_id)`. Each is a `code.covers` edge now.

8. **The Makefile target a newcomer's command names.** `README.md`:12, :13,
   :14, :16 (through `make -s token`) and :17 name `make up`, `make seed`,
   `make install`, the token target and `make test`, and each target stands in
   the `Makefile`; the reference now states that as `code.backed-by`.

## Names that stand after review

The audit of 2026-11-07 read items 1, 3 and 5 as changes of name only. Each
stands because the source reads that way:

- **Item 1.** The port is named by the service the source names: the compose
  service `orders` (`docker-compose.yml`:33) maps `8080` (:36), and the
  Dockerfile under `services/orders` declares `EXPOSE 8080` (:14). The folder is
  the file's place, which the evidence already carries.
- **Item 3.** The manifest's own keys are `readinessProbe`, `livenessProbe` and
  `startupProbe` (`deploy/k8s/orders.yaml`:25, :30, :35).
- **Item 5.** The source states the machine as the `transitions` table
  (`services/orders/internal/domain/order.go`:55); `Order.status` is the field
  the table is keyed by, not the table's name.

## The audit of 2026-11-07

9. **The outbox writer does not publish.** `OutboxWriter.Write` runs
   `INSERT INTO outbox (aggregate_id, topic, payload) …`
   (`services/orders/internal/store/outbox.go`:57) inside the caller's
   transaction; the relay publishes the rows later
   (`services/orders/internal/relay/relay.go`:94
   `r.publisher.Publish(ctx, p.topic, p.key, p.payload)`). The
   `code.publishes` edge from the writer is gone, and the orders service's
   publishes edge now cites the relay's publish call.

10. **A Dockerfile's base image is what the build starts from, not what builds
    it.** `services/orders/Dockerfile`:3 `FROM golang:1.22.5-alpine AS build`
    (and the same line in the other three Dockerfiles) is a dependency of the
    build; the edge is `code.depends-on`, where it was `code.built-by`.

11. **A container port is the deployment's configuration, not the image's.**
    `deploy/k8s/orders.yaml`:21 `containerPort: 8080` is declared by the
    Deployment's pod template; the `code.exposes` edge now runs from
    `code.k8s-deployment:orders`.

12. **The liveness and startup probes cite their own lines.**
    `deploy/k8s/orders.yaml`:32-33 (liveness path and port) and :37-38
    (startup path and port); the reference had cited the readiness lines
    (:27-28) for all three probes.

13. **The calls through locally declared interfaces are stated.**
    `services/payments/src/domain/payment-service.ts`:47, :63, :70, :87, :93,
    :97, :100, :102 and :104 call `PaymentRepository` and `PaymentProvider`
    methods; `services/payments/src/events/publishers.ts`:46 calls
    `EventSink.send`. Their declarations are
    `services/payments/src/store/payment-repository.ts`:7-13 and
    `services/payments/src/providers/provider.ts`:36-40. A TypeScript
    interface's method signature is now a `code.symbol`, as a Go interface's
    method is, and a call through a field, a parameter or a declared type
    resolves to it.

14. **A call through a multi-result assignment is stated.**
    `services/orders/internal/application/order_service.go`:201
    `order, err := s.store.Get(ctx, id)` gives `order` the type
    `domain.Order` the interface's method returns, and :205
    `if err := order.Apply(event, s.now()); err != nil` calls `Order.Apply`.

15. **The environment reads of the configuration readers are stated.**
    `services/payments/src/config.ts`:30, :31, :32, :38, :43;
    `services/checkout/src/config.ts`:15, :16, :17, :18;
    `services/payments/prisma/schema.prisma`:7 `env("DATABASE_URL")`; and
    `services/orders/internal/config/config.go`:47, :48, :49, where the name is
    asked of the `get` function the reader was handed
    (`config.go`:31 `fromEnv(os.Getenv)`).

16. **Checkout's dependencies are in list form.**
    `docker-compose.yml`:85-88 list `orders`, `payments` and `promotions` under
    `depends_on`; the reference had read only the mapping form.

17. **The README links to the two documents it starts from.** `README.md`:5
    "Start with docs/vision.md and docs/architecture.md" — two
    `code.document-link` edges.

18. **The payments image carries the contracts.**
    `services/payments/Dockerfile`:17 `COPY contracts /app/contracts`; the
    reference states a judgement `code.depends-on` from the Dockerfile to the
    three contracts, because the image cannot serve the gRPC API without the
    proto (`services/payments/src/grpc/server.ts`:10).

Nothing else changed: the facts of every other entry, and every line they
cite, are the ones committed with the reference.
