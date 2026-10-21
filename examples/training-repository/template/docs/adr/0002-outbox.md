# ADR-0002: Events leave through a transactional outbox

Status: accepted, 2026-05-28

## Context

Orders must publish a message for every change of an order. Writing the order
and then publishing to Kafka are two operations on two systems: a crash
between them loses the message, and publishing first can announce an order
that was never stored.

## Decision

The orders service writes the message into the `outbox` table in the same
database transaction as the change (`store.OutboxWriter`, called by
`store.OrderRepository`). A relay (`internal/relay`) reads the rows that are
not yet published, sends them to Kafka and marks them published.

## Consequences

- A message exists if and only if its change was committed.
- A crash between publishing and marking publishes the message again, so
  consumers must tolerate duplicates (ADR-0001).
- Messages reach Kafka a second or so after the commit, not at the commit.
