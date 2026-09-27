# Ordering (domain)

```mermaid
%%{init: {"flowchart": {"curve": "linear"}}}%%
flowchart LR
  subgraph ordering ["Ordering"]
    cart_cache[("Cart cache")]
    checkout_api["Checkout"]
    invoice_archive[("Invoice archive")]
    invoices_api["Invoices"]
    orders_api["Orders"]
    orders_db[("Orders database")]
    promotions_api["Promotions"]
    promotions_db[("Promotions database")]
    returns_api["Returns"]
    returns_db[("Returns database")]
    tax_api["Tax"]
  end
  catalog["Catalog"]
  fulfilment["Fulfilment"]
  payments["Payments"]
  platform["Platform"]
  storefront["Storefront"]
  checkout_api -->|"1"| cart_cache
  checkout_api -->|"2"| catalog
  checkout_api -->|"3"| fulfilment
  checkout_api -->|"4"| orders_api
  checkout_api -->|"5"| payments
  checkout_api -->|"6"| promotions_api
  checkout_api -->|"7"| tax_api
  invoices_api -->|"8"| invoice_archive
  invoices_api -.->|"9"| platform
  orders_api -->|"10"| orders_db
  orders_api -.->|"11"| platform
  promotions_api -->|"12"| promotions_db
  returns_api -->|"13"| orders_api
  returns_api -.->|"14"| platform
  returns_api -->|"15"| returns_db
  storefront -->|"16"| checkout_api
  storefront -->|"17"| invoices_api
  storefront -->|"18"| orders_api
  storefront -->|"19"| returns_api
```

| # | From | To | Relations |
| --- | --- | --- | --- |
| 1 | Checkout | Cart cache | keeps open carts |
| 2 | Checkout | Catalog | reads list prices |
| 3 | Checkout | Fulfilment | checks stock; quotes delivery options |
| 4 | Checkout | Orders | places the order |
| 5 | Checkout | Payments | takes payment |
| 6 | Checkout | Promotions | applies promotions |
| 7 | Checkout | Tax | calculates tax |
| 8 | Invoices | Invoice archive | archives invoice PDFs |
| 9 | Invoices | Platform | subscribes to order-confirmed: issues invoices for confirmed orders |
| 10 | Orders | Orders database | stores orders |
| 11 | Orders | Platform | subscribes to payment-failed: cancels unpaid orders; subscribes to payment-captured: confirms paid orders; subscribes to shipment-dispatched: marks orders as shipped; publishes order-cancelled; publishes order-confirmed; publishes order-placed |
| 12 | Promotions | Promotions database | stores promotion rules |
| 13 | Returns | Orders | checks the returned order |
| 14 | Returns | Platform | publishes return-approved |
| 15 | Returns | Returns database | stores returns |
| 16 | Storefront | Checkout | checks out the cart; adds items to the cart; checks out the cart; adds items to the cart |
| 17 | Storefront | Invoices | downloads an invoice |
| 18 | Storefront | Orders | shows the order history |
| 19 | Storefront | Returns | requests a return |

Up: [Landscape](_landscape.md)

Open: [Catalog](catalog.md) · [Checkout](checkout-api.md) · [Fulfilment](fulfilment.md) · [Payments](payments.md) · [Platform](platform.md) · [Storefront](storefront.md)
