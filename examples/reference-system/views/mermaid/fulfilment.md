# Fulfilment (domain)

```mermaid
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
  delivery_carrier -->|"reports tracking events"| shipping_api
  inventory_api -->|"stores stock levels"| inventory_db
  inventory_api -->|"3 relations, see 3"| platform
  ordering -->|"checks stock"| inventory_api
  ordering -->|"quotes delivery options"| shipping_api
  shipping_api -->|"books the delivery"| delivery_carrier
  shipping_api -->|"2 relations, see 7"| platform
  shipping_api -->|"stores shipments"| shipping_db
  storefront -->|"shows parcel tracking"| shipping_api
  warehouse_api -->|"deducts picked stock"| inventory_api
  warehouse_api -->|"2 relations, see 11"| platform
  warehouse_api -->|"stores pick lists"| warehouse_db
  warehouse_app -->|"2 relations, see 13"| warehouse_api
  warehouse_operator -->|"picks and packs orders"| warehouse_app
  classDef external fill:#f4f4f4,stroke:#888888,stroke-dasharray:5 5
  class delivery_carrier external
```

| # | From | To | Relations |
| --- | --- | --- | --- |
| 1 | Delivery carrier | Shipping | reports tracking events |
| 2 | Inventory | Inventory database | stores stock levels |
| 3 | Inventory | Platform | publishes stock-changed; releases stock of cancelled orders; reserves stock for placed orders |
| 4 | Ordering | Inventory | checks stock |
| 5 | Ordering | Shipping | quotes delivery options |
| 6 | Shipping | Delivery carrier | books the delivery |
| 7 | Shipping | Platform | publishes shipment-dispatched; ships packed parcels |
| 8 | Shipping | Shipping database | stores shipments |
| 9 | Storefront | Shipping | shows parcel tracking |
| 10 | Warehouse | Inventory | deducts picked stock |
| 11 | Warehouse | Platform | creates pick lists for confirmed orders; publishes parcel-packed |
| 12 | Warehouse | Warehouse database | stores pick lists |
| 13 | Warehouse app | Warehouse | confirms packed parcels; loads pick lists |
| 14 | Warehouse operator | Warehouse app | picks and packs orders |

Up: [Landscape](_landscape.md)

Open: [Ordering](ordering.md) · [Platform](platform.md) · [Storefront](storefront.md)
