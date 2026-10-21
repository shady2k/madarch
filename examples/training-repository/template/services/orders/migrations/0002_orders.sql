-- One row per order. Money columns are cents. cancel_reason is only set on
-- cancelled orders, so it is nullable.
CREATE TABLE orders (
    id             TEXT PRIMARY KEY,
    customer_id    TEXT NOT NULL REFERENCES customers (id),
    status         TEXT NOT NULL,
    subtotal_cents BIGINT NOT NULL DEFAULT 0,
    discount_cents BIGINT NOT NULL DEFAULT 0,
    tax_cents      BIGINT NOT NULL DEFAULT 0,
    total_cents    BIGINT NOT NULL,
    cancel_reason  TEXT,
    created_at     TIMESTAMPTZ NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL
);

CREATE INDEX orders_customer_idx ON orders (customer_id, created_at);
