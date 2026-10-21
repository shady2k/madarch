INSERT INTO customers (id, email, name) VALUES ('demo', 'demo@example.test', 'Demo Shopper')
ON CONFLICT (id) DO NOTHING;
