# Orders service

Orders remain available forever.

The service takes orders from checkout over HTTP (contracts/openapi/orders.yaml),
keeps them in its own Postgres database and announces every change through the
outbox (contracts/asyncapi/order-events.yaml).

Run it from this folder with `make run-orders` at the repository root; it needs
`DATABASE_URL`, `KAFKA_BROKERS` and `JWT_SECRET` (see `.env.example`).
