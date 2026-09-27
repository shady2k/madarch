# Checkout (service)

```mermaid
%%{init: {"flowchart": {"curve": "linear"}}}%%
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
  checkout_cart -->|"1"| cart_cache
  checkout_cart -->|"2"| checkout_pricing
  checkout_cart -->|"3"| fulfilment
  checkout_confirmation -->|"4"| checkout_payment_step
  checkout_confirmation -->|"5"| orders_api
  checkout_payment_step -->|"6"| payments
  checkout_pricing -->|"7"| catalog
  checkout_pricing -->|"8"| fulfilment
  checkout_pricing -->|"9"| promotions_api
  checkout_pricing -->|"10"| tax_api
  storefront -->|"11"| checkout_cart
  storefront -->|"12"| checkout_confirmation
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
| 11 | Storefront | Cart | adds items to the cart; adds items to the cart |
| 12 | Storefront | Confirmation | checks out the cart; checks out the cart |

Up: [Ordering](ordering.md)

Open: [Catalog](catalog.md) · [Fulfilment](fulfilment.md) · [Payments](payments.md) · [Storefront](storefront.md)
