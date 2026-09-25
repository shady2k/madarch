# Platform (domain)

```mermaid
flowchart LR
  subgraph platform ["Platform"]
    analytics_pipeline["Analytics pipeline"]
    analytics_warehouse[("Analytics warehouse")]
    auth_api["Sign-in"]
    auth_db[("Identity database")]
    event_bus[["Event bus"]]
    notification_api["Notifications"]
    notification_db[("Notification log")]
  end
  catalog["Catalog"]
  fulfilment["Fulfilment"]
  messaging_provider["Email and SMS provider"]
  ordering["Ordering"]
  payments["Payments"]
  storefront["Storefront"]
  analytics_pipeline -->|"loads events for reporting"| analytics_warehouse
  analytics_pipeline -->|"streams every business event"| event_bus
  auth_api -->|"stores credentials and sessions"| auth_db
  catalog -->|"6 relations, see 4"| event_bus
  fulfilment -->|"7 relations, see 5"| event_bus
  notification_api -->|"3 relations, see 6"| event_bus
  notification_api -->|"sends emails; sends text messages"| messaging_provider
  notification_api -->|"logs sent messages"| notification_db
  notification_api -->|"looks up contact details"| storefront
  ordering -->|"8 relations, see 10"| event_bus
  payments -->|"3 relations, see 11"| event_bus
  storefront -->|"signs the customer in"| auth_api
  storefront -->|"awards points for placed orders"| event_bus
  classDef external fill:#f4f4f4,stroke:#888888,stroke-dasharray:5 5
  class messaging_provider external
```

| # | From | To | Relations |
| --- | --- | --- | --- |
| 1 | Analytics pipeline | Analytics warehouse | loads events for reporting |
| 2 | Analytics pipeline | Event bus | streams every business event |
| 3 | Sign-in | Identity database | stores credentials and sessions |
| 4 | Catalog | Event bus | publishes price-changed; publishes product-changed; learns from placed orders; reindexes changed prices; reindexes changed products; updates availability in the index |
| 5 | Fulfilment | Event bus | publishes stock-changed; releases stock of cancelled orders; reserves stock for placed orders; publishes shipment-dispatched; ships packed parcels; creates pick lists for confirmed orders; publishes parcel-packed |
| 6 | Notifications | Event bus | tells customers the parcel is on its way; asks customers to retry payment; emails order confirmations |
| 7 | Notifications | Email and SMS provider | sends emails; sends text messages |
| 8 | Notifications | Notification log | logs sent messages |
| 9 | Notifications | Storefront | looks up contact details |
| 10 | Ordering | Event bus | issues invoices for confirmed orders; cancels unpaid orders; confirms paid orders; marks orders as shipped; publishes order-cancelled; publishes order-confirmed; publishes order-placed; publishes return-approved |
| 11 | Payments | Event bus | publishes payment-captured; publishes payment-failed; refunds approved returns |
| 12 | Storefront | Sign-in | signs the customer in |
| 13 | Storefront | Event bus | awards points for placed orders |

Up: [Landscape](_landscape.md)

Open: [Catalog](catalog.md) · [Fulfilment](fulfilment.md) · [Ordering](ordering.md) · [Payments](payments.md) · [Storefront](storefront.md)
