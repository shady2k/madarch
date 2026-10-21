<!-- @@ until containers -->
# Ordering and payments training system

The ordering and payments back end of a small online shop.
<!-- @@ end -->
<!-- @@ since containers -->
# Ordering and payments training system

The ordering and payments back end of a small online shop: four services
(orders, payments, promotions, checkout), their contracts and a local
environment. Start with docs/vision.md and docs/architecture.md.
<!-- @@ end -->

<!-- @@ since containers -->
## Run it

Prerequisites: Go 1.22, Node 20, Docker Compose and psql.

1. From the repository root, copy the settings: `cp .env.example .env`.
2. Start everything: `make up` (builds the four services and starts Postgres and Kafka).
3. Load the demo customer and promotion codes: `make seed`.
4. Install what the tests need on your machine: `make install` (runs `go mod download` in orders and
   promotions, `npm ci` in payments and checkout, and `npx prisma generate` for payments' database client).
5. Place an order: `curl -s -X POST http://localhost:8080/orders -H "Authorization: Bearer $(make -s token)" -H 'Content-Type: application/json' -d '{"items":[{"sku":"A-1","quantity":2,"priceCents":1000}]}'`
6. Run the tests: `make test`.

Common failure: `make up` stops with "port is already allocated" when a Postgres
of your own already listens on 5432; stop it or change the port in docker-compose.yml.

<!-- @@ end -->
## What it does

The service applies a 10% discount to every order and calculates tax at a flat 5%.
Orders are retained indefinitely. Payments go through a card provider chosen in
the configuration, and every change of an order is published to Kafka.

See [HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110) for the status codes
the APIs use. Sign in at [the project workspace](https://github.com/settings/profile)
to see private project details.
