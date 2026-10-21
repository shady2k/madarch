-- Messages waiting to leave for Kafka. The order service writes a row in the
-- same transaction as the change it announces; the relay publishes the rows
-- with published_at IS NULL (docs/adr/0002-outbox.md).
CREATE TABLE outbox (
    id           BIGSERIAL PRIMARY KEY,
    aggregate_id TEXT NOT NULL,
    topic        TEXT NOT NULL,
    payload      JSONB NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ
);

CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
