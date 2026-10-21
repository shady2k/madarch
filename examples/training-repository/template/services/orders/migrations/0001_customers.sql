-- Customers of the shop. Orders reference them; payments and checkout only know the id.
CREATE TABLE customers (
    id         TEXT PRIMARY KEY,
    email      TEXT NOT NULL UNIQUE,
    -- name is optional: guest checkout stores only an email.
    name       TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
