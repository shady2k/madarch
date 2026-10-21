# Architecture

Four services, each with its own database where it has one.

| Service | Language | Role | Ports |
| --- | --- | --- | --- |
| orders | Go | Orders and their state machine; HTTP API; outbox relay | 8080 |
| payments | TypeScript | Charges and refunds behind a provider adapter; HTTP and gRPC | 8081, 50051 |
| promotions | Go | Promotion codes and discount strategies | 8082 |
| checkout | TypeScript | Backend for the frontend; runs the checkout sequence | 8083 |

## How they talk

- Checkout calls Orders over HTTP, as described in contracts/openapi/orders.yaml.
- Checkout calls Payments over gRPC (contracts/proto/payments.proto).
- Checkout calls Promotions over HTTP (`POST /internal/apply`).
- Orders publishes `orders.events` through its outbox relay; Payments
  publishes `payments.events`; Orders consumes the payment events to confirm
  or cancel orders (contracts/asyncapi/order-events.yaml).

## Data

Orders and Payments keep separate Postgres databases. `payments.order_id` is a
logical reference to an order: there is no foreign key, because the order lives
in another service and another database.

## Payment flow

Checkout sends the payment token with the amount to Payments. Payments passes
the payment token to the provider, stores the outcome and publishes it.

## Not built yet

A loyalty service is planned (docs/plans/loyalty.md); nothing in the code
refers to it.
