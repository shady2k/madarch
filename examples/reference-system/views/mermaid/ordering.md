# Ordering (domain)

```mermaid
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
  checkout_api -->|"keeps open carts"| cart_cache
  checkout_api -->|"reads list prices"| catalog
  checkout_api -->|"checks stock; quotes delivery options"| fulfilment
  checkout_api -->|"places the order"| orders_api
  checkout_api -->|"takes payment"| payments
  checkout_api -->|"applies promotions"| promotions_api
  checkout_api -->|"calculates tax"| tax_api
  invoices_api -->|"archives invoice PDFs"| invoice_archive
  invoices_api -->|"issues invoices for confirmed orders"| platform
  orders_api -->|"stores orders"| orders_db
  orders_api -->|"6 relations, see 11"| platform
  promotions_api -->|"stores promotion rules"| promotions_db
  returns_api -->|"checks the returned order"| orders_api
  returns_api -->|"publishes return-approved"| platform
  returns_api -->|"stores returns"| returns_db
  storefront -->|"4 relations, see 16"| checkout_api
  storefront -->|"downloads an invoice"| invoices_api
  storefront -->|"shows the order history"| orders_api
  storefront -->|"requests a return"| returns_api
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
| 9 | Invoices | Platform | issues invoices for confirmed orders |
| 10 | Orders | Orders database | stores orders |
| 11 | Orders | Platform | cancels unpaid orders; confirms paid orders; marks orders as shipped; publishes order-cancelled; publishes order-confirmed; publishes order-placed |
| 12 | Promotions | Promotions database | stores promotion rules |
| 13 | Returns | Orders | checks the returned order |
| 14 | Returns | Platform | publishes return-approved |
| 15 | Returns | Returns database | stores returns |
| 16 | Storefront | Checkout | checks out the cart; adds items to the cart |
| 17 | Storefront | Invoices | downloads an invoice |
| 18 | Storefront | Orders | shows the order history |
| 19 | Storefront | Returns | requests a return |

Up: [Landscape](_landscape.md)

Open: [Catalog](catalog.md) · [Checkout](checkout-api.md) · [Fulfilment](fulfilment.md) · [Payments](payments.md) · [Platform](platform.md) · [Storefront](storefront.md)
