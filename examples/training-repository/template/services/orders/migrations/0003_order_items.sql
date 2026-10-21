-- The lines of an order: one order has many items, an item belongs to one
-- order and goes away with it.
CREATE TABLE order_items (
    id          BIGSERIAL PRIMARY KEY,
    order_id    TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    sku         TEXT NOT NULL,
    quantity    INTEGER NOT NULL CHECK (quantity > 0),
    price_cents BIGINT NOT NULL,
    zero_rated  BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX order_items_order_idx ON order_items (order_id);
