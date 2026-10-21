-- The client's idempotency key for placing an order: the same customer sending
-- the same request id gets the first order back instead of a second one.
ALTER TABLE orders ADD COLUMN request_id TEXT;

CREATE UNIQUE INDEX orders_request_idx ON orders (customer_id, request_id) WHERE request_id IS NOT NULL;
