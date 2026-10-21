-- Promotion codes. kind selects the discount strategy (percent, fixed,
-- threshold); value is a percent or an amount in cents, depending on the kind.
CREATE TABLE promotions (
    id         TEXT PRIMARY KEY,
    code       TEXT NOT NULL UNIQUE,
    kind       TEXT NOT NULL CHECK (kind IN ('percent', 'fixed', 'threshold')),
    value      BIGINT NOT NULL,
    -- min_cents is the spend a threshold promotion needs; null for the other kinds.
    min_cents  BIGINT,
    active     BOOLEAN NOT NULL DEFAULT true,
    expires_at TIMESTAMPTZ
);
