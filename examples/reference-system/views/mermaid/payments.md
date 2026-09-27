# Payments (domain)

```mermaid
%%{init: {"flowchart": {"curve": "linear"}}}%%
flowchart LR
  subgraph payments ["Payments"]
    card_vault["Card vault"]
    card_vault_db[("Card vault database")]
    fraud_api["Fraud screening"]
    fraud_features[("Risk features")]
    payments_api["Payments"]
    payments_db[("Payments database")]
    reconciliation_db[("Reconciliation database")]
    reconciliation_job["Reconciliation"]
  end
  ordering["Ordering"]
  payment_provider["Payment provider"]
  platform["Platform"]
  storefront["Storefront"]
  card_vault -->|"1"| card_vault_db
  fraud_api -->|"2"| fraud_features
  ordering -->|"3"| payments_api
  payment_provider -->|"4"| payments_api
  payments_api -->|"5"| card_vault
  payments_api -->|"6"| fraud_api
  payments_api -->|"7"| payment_provider
  payments_api -->|"8"| payments_db
  payments_api -.->|"9"| platform
  reconciliation_job -->|"10"| payment_provider
  reconciliation_job -->|"11"| payments_db
  reconciliation_job -->|"12"| reconciliation_db
  storefront -->|"13"| card_vault
  classDef external fill:#f4f4f4,stroke:#888888,stroke-dasharray:5 5,color:#222222
  class payment_provider external
```

| # | From | To | Relations |
| --- | --- | --- | --- |
| 1 | Card vault | Card vault database | stores encrypted cards |
| 2 | Fraud screening | Risk features | reads and updates risk features |
| 3 | Ordering | Payments | authorizes the payment |
| 4 | Payment provider | Payments | reports payment outcomes |
| 5 | Payments | Card vault | detokenizes the card |
| 6 | Payments | Fraud screening | screens the payment for fraud |
| 7 | Payments | Payment provider | charges the card; refunds the payment |
| 8 | Payments | Payments database | records payments |
| 9 | Payments | Platform | publishes payment-captured; publishes payment-failed; subscribes to return-approved: refunds approved returns |
| 10 | Reconciliation | Payment provider | downloads settlement reports |
| 11 | Reconciliation | Payments database | matches settlements against payments |
| 12 | Reconciliation | Reconciliation database | records mismatches |
| 13 | Storefront | Card vault | tokenizes the card; tokenizes the card |

Up: [Landscape](_landscape.md)

Open: [Ordering](ordering.md) · [Platform](platform.md) · [Storefront](storefront.md)
