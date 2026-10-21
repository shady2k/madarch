# ADR-0001: Kafka is the broker

Status: accepted, 2026-05-20

## Context

Orders and payments must tell each other what happened without calling each
other synchronously: payments reports the outcome of a charge, orders reports
every change of an order. Finance wants to replay a month of events when
numbers do not add up.

## Decision

Both services publish to Kafka topics, `orders.events` and `payments.events`
(contracts/asyncapi/order-events.yaml). Messages are keyed by order id, so all
events of one order are read in order.

## Why Kafka

- Messages are retained, so a consumer that was down, or a new consumer, can
  read the history again. A plain queue deletes a message once it is read.
- Per-key ordering is exactly the guarantee the order state machine needs.
- The team already runs it for other products.

## Consequences

- Consumers must tolerate duplicates: delivery is at least once.
- A local run needs a broker; docker-compose.yml starts a single-node one.
