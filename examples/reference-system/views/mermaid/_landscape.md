# Landscape

```mermaid
flowchart LR
  catalog["Catalog"]
  customer(["Customer"])
  delivery_carrier["Delivery carrier"]
  fulfilment["Fulfilment"]
  messaging_provider["Email and SMS provider"]
  ordering["Ordering"]
  payment_provider["Payment provider"]
  payments["Payments"]
  platform["Platform"]
  storefront["Storefront"]
  catalog -->|"publishes price-changed; publishes product-changed; learns from placed orders (+3 more)"| platform
  customer -->|"browses and buys in the app; browses and buys on the web"| storefront
  delivery_carrier -->|"reports tracking events"| fulfilment
  fulfilment -->|"books the delivery"| delivery_carrier
  fulfilment -->|"publishes stock-changed; releases stock of cancelled orders; reserves stock for placed orders (+4 more)"| platform
  ordering -->|"reads list prices"| catalog
  ordering -->|"checks stock; quotes delivery options"| fulfilment
  ordering -->|"takes payment"| payments
  ordering -->|"issues invoices for confirmed orders; cancels unpaid orders; confirms paid orders (+5 more)"| platform
  payment_provider -->|"reports payment outcomes"| payments
  payments -->|"charges the card; refunds the payment; downloads settlement reports"| payment_provider
  payments -->|"publishes payment-captured; publishes payment-failed; refunds approved returns"| platform
  platform -->|"sends emails; sends text messages"| messaging_provider
  platform -->|"looks up contact details"| storefront
  storefront -->|"searches products; shows product pages; loads product images (+3 more)"| catalog
  storefront -->|"shows parcel tracking"| fulfilment
  storefront -->|"checks out the cart; adds items to the cart; downloads an invoice (+2 more)"| ordering
  storefront -->|"tokenizes the card"| payments
  storefront -->|"awards points for placed orders; signs the customer in"| platform
  classDef external fill:#f4f4f4,stroke:#888888,stroke-dasharray:5 5
  class delivery_carrier,messaging_provider,payment_provider external
```

Open: [Catalog](catalog.md) · [Fulfilment](fulfilment.md) · [Ordering](ordering.md) · [Payments](payments.md) · [Platform](platform.md) · [Storefront](storefront.md)
