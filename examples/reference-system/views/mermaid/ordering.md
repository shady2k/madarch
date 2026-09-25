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
  orders_api -->|"cancels unpaid orders; confirms paid orders; marks orders as shipped (+3 more)"| platform
  promotions_api -->|"stores promotion rules"| promotions_db
  returns_api -->|"checks the returned order"| orders_api
  returns_api -->|"publishes return-approved"| platform
  returns_api -->|"stores returns"| returns_db
  storefront -->|"checks out the cart; adds items to the cart"| checkout_api
  storefront -->|"downloads an invoice"| invoices_api
  storefront -->|"shows the order history"| orders_api
  storefront -->|"requests a return"| returns_api
```

Up: [Landscape](_landscape.md)

Open: [Catalog](catalog.md) · [Checkout](checkout-api.md) · [Fulfilment](fulfilment.md) · [Payments](payments.md) · [Platform](platform.md) · [Storefront](storefront.md)
