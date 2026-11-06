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
   payments, :70 for promotions and :82 sets `ORDERS_URL` for checkout; four
   services set `JWT_SECRET` (:40, :57) and `KAFKA_BROKERS` (:39, :56). One id
   per variable hid that, so each definition now carries its service:
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

Nothing else changed: the facts of every other entry, and every line they
cite, are the ones committed with the reference.
