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
  catalog -->|"6 relations, see 1"| platform
  customer -->|"2 relations, see 2"| storefront
  delivery_carrier -->|"reports tracking events"| fulfilment
  fulfilment -->|"books the delivery"| delivery_carrier
  fulfilment -->|"7 relations, see 5"| platform
  ordering -->|"reads list prices"| catalog
  ordering -->|"checks stock; quotes delivery options"| fulfilment
  ordering -->|"takes payment"| payments
  ordering -->|"8 relations, see 9"| platform
  payment_provider -->|"reports payment outcomes"| payments
  payments -->|"3 relations, see 11"| payment_provider
  payments -->|"3 relations, see 12"| platform
  platform -->|"sends emails; sends text messages"| messaging_provider
  platform -->|"looks up contact details"| storefront
  storefront -->|"8 relations, see 15"| catalog
  storefront -->|"shows parcel tracking"| fulfilment
  storefront -->|"7 relations, see 17"| ordering
  storefront -->|"tokenizes the card"| payments
  storefront -->|"3 relations, see 19"| platform
  classDef external fill:#f4f4f4,stroke:#888888,stroke-dasharray:5 5
  class delivery_carrier,messaging_provider,payment_provider external
```

| # | From | To | Relations |
| --- | --- | --- | --- |
| 1 | Catalog | Platform | publishes price-changed; publishes product-changed; learns from placed orders; reindexes changed prices; reindexes changed products; updates availability in the index |
| 2 | Customer | Storefront | browses and buys in the app; browses and buys on the web |
| 3 | Delivery carrier | Fulfilment | reports tracking events |
| 4 | Fulfilment | Delivery carrier | books the delivery |
| 5 | Fulfilment | Platform | publishes stock-changed; releases stock of cancelled orders; reserves stock for placed orders; publishes shipment-dispatched; ships packed parcels; creates pick lists for confirmed orders; publishes parcel-packed |
| 6 | Ordering | Catalog | reads list prices |
| 7 | Ordering | Fulfilment | checks stock; quotes delivery options |
| 8 | Ordering | Payments | takes payment |
| 9 | Ordering | Platform | issues invoices for confirmed orders; cancels unpaid orders; confirms paid orders; marks orders as shipped; publishes order-cancelled; publishes order-confirmed; publishes order-placed; publishes return-approved |
| 10 | Payment provider | Payments | reports payment outcomes |
| 11 | Payments | Payment provider | charges the card; refunds the payment; downloads settlement reports |
| 12 | Payments | Platform | publishes payment-captured; publishes payment-failed; refunds approved returns |
| 13 | Platform | Email and SMS provider | sends emails; sends text messages |
| 14 | Platform | Storefront | looks up contact details |
| 15 | Storefront | Catalog | searches products; shows product pages; loads product images; posts a review; shows recommendations; shows reviews |
| 16 | Storefront | Fulfilment | shows parcel tracking |
| 17 | Storefront | Ordering | checks out the cart; adds items to the cart; downloads an invoice; requests a return; shows the order history |
| 18 | Storefront | Payments | tokenizes the card |
| 19 | Storefront | Platform | awards points for placed orders; signs the customer in |

Open: [Catalog](catalog.md) · [Fulfilment](fulfilment.md) · [Ordering](ordering.md) · [Payments](payments.md) · [Platform](platform.md) · [Storefront](storefront.md)
