INSERT INTO promotions (id, code, kind, value, min_cents) VALUES
    ('promo-1', 'WELCOME10', 'percent', 10, NULL),
    ('promo-2', 'FIVEOFF', 'fixed', 500, NULL),
    ('promo-3', 'BIGSPENDER', 'threshold', 15, 10000)
ON CONFLICT (code) DO NOTHING;
