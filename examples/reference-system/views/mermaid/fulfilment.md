# Fulfilment (domain)

```mermaid
%%{init: {"flowchart": {"curve": "linear"}}}%%
flowchart LR
  subgraph fulfilment ["Fulfilment"]
    inventory_api["Inventory"]
    inventory_db[("Inventory database")]
    shipping_api["Shipping"]
    shipping_db[("Shipping database")]
    warehouse_api["Warehouse"]
    warehouse_app["Warehouse app"]
    warehouse_db[("Warehouse database")]
    warehouse_operator(["Warehouse operator"])
  end
  delivery_carrier["Delivery carrier"]
  ordering["Ordering"]
  platform["Platform"]
  storefront["Storefront"]
  delivery_carrier -->|"1"| shipping_api
  inventory_api -->|"2"| inventory_db
  inventory_api -.->|"3"| platform
  ordering -->|"4"| inventory_api
  ordering -->|"5"| shipping_api
  shipping_api -->|"6"| delivery_carrier
  shipping_api -.->|"7"| platform
  shipping_api -->|"8"| shipping_db
  storefront -->|"9"| shipping_api
  warehouse_api -->|"10"| inventory_api
  warehouse_api -.->|"11"| platform
  warehouse_api -->|"12"| warehouse_db
  warehouse_app -->|"13"| warehouse_api
  warehouse_operator -->|"14"| warehouse_app
  classDef external fill:#f4f4f4,stroke:#888888,stroke-dasharray:5 5,color:#222222
  class delivery_carrier external
```

| # | From | To | Relations |
| --- | --- | --- | --- |
| 1 | Delivery carrier | Shipping | reports tracking events |
| 2 | Inventory | Inventory database | stores stock levels |
| 3 | Inventory | Platform | publishes stock-changed; subscribes to order-cancelled: releases stock of cancelled orders; subscribes to order-placed: reserves stock for placed orders |
| 4 | Ordering | Inventory | checks stock |
| 5 | Ordering | Shipping | quotes delivery options |
| 6 | Shipping | Delivery carrier | books the delivery |
| 7 | Shipping | Platform | publishes shipment-dispatched; subscribes to parcel-packed: ships packed parcels |
| 8 | Shipping | Shipping database | stores shipments |
| 9 | Storefront | Shipping | shows parcel tracking |
| 10 | Warehouse | Inventory | deducts picked stock |
| 11 | Warehouse | Platform | subscribes to order-confirmed: creates pick lists for confirmed orders; publishes parcel-packed |
| 12 | Warehouse | Warehouse database | stores pick lists |
| 13 | Warehouse app | Warehouse | confirms packed parcels; loads pick lists |
| 14 | Warehouse operator | Warehouse app | picks and packs orders |

Up: [Landscape](_landscape.md)

Open: [Ordering](ordering.md) · [Platform](platform.md) · [Storefront](storefront.md)
