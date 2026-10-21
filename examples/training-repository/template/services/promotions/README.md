# Promotions service

Promotion codes and the discount strategies behind them (percent, fixed amount,
spend threshold). `POST /internal/apply` answers how much a code takes off a
subtotal. Listens on 8082; the table is created by migrations/0001_promotions.sql.
