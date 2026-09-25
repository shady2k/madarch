# Checkout (service)

```mermaid
flowchart LR
  subgraph checkout_api ["Checkout"]
    checkout_cart["Cart"]
    checkout_confirmation["Confirmation"]
    checkout_payment_step["Payment step"]
    checkout_pricing["Pricing"]
  end
  cart_cache[("Cart cache")]
  catalog["Catalog"]
  fulfilment["Fulfilment"]
  orders_api["Orders"]
  payments["Payments"]
  promotions_api["Promotions"]
  storefront["Storefront"]
  tax_api["Tax"]
  checkout_cart -->|"keeps open carts"| cart_cache
  checkout_cart -->|"prices the cart"| checkout_pricing
  checkout_cart -->|"checks stock"| fulfilment
  checkout_confirmation -->|"takes payment before placing"| checkout_payment_step
  checkout_confirmation -->|"places the order"| orders_api
  checkout_payment_step -->|"authorizes the payment"| payments
  checkout_pricing -->|"reads list prices"| catalog
  checkout_pricing -->|"quotes delivery options"| fulfilment
  checkout_pricing -->|"applies promotions"| promotions_api
  checkout_pricing -->|"calculates tax"| tax_api
  storefront -->|"adds items to the cart"| checkout_cart
  storefront -->|"checks out the cart"| checkout_confirmation
```

| # | From | To | Relations |
| --- | --- | --- | --- |
| 1 | Cart | Cart cache | keeps open carts |
| 2 | Cart | Pricing | prices the cart |
| 3 | Cart | Fulfilment | checks stock |
| 4 | Confirmation | Payment step | takes payment before placing |
| 5 | Confirmation | Orders | places the order |
| 6 | Payment step | Payments | authorizes the payment |
| 7 | Pricing | Catalog | reads list prices |
| 8 | Pricing | Fulfilment | quotes delivery options |
| 9 | Pricing | Promotions | applies promotions |
| 10 | Pricing | Tax | calculates tax |
| 11 | Storefront | Cart | adds items to the cart |
| 12 | Storefront | Confirmation | checks out the cart |

Up: [Ordering](ordering.md)

Open: [Catalog](catalog.md) · [Fulfilment](fulfilment.md) · [Payments](payments.md) · [Storefront](storefront.md)
