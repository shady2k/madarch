# Storefront (domain)

```mermaid
%%{init: {"flowchart": {"curve": "linear"}}}%%
flowchart LR
  subgraph storefront ["Storefront"]
    accounts_api["Accounts"]
    accounts_db[("Accounts database")]
    content_api["Content"]
    content_db[("Content database")]
    loyalty_api["Loyalty"]
    loyalty_db[("Loyalty database")]
    mobile_app["Mobile app"]
    mobile_bff["Mobile back end"]
    session_cache[("Session cache")]
    web_shop["Web shop"]
  end
  catalog["Catalog"]
  customer(["Customer"])
  fulfilment["Fulfilment"]
  ordering["Ordering"]
  payments["Payments"]
  platform["Platform"]
  accounts_api -->|"1"| accounts_db
  content_api -->|"2"| content_db
  customer -->|"3"| mobile_app
  customer -->|"4"| web_shop
  loyalty_api -->|"5"| loyalty_db
  loyalty_api -.->|"6"| platform
  mobile_app -->|"7"| mobile_bff
  mobile_app -->|"8"| payments
  mobile_bff -->|"9"| accounts_api
  mobile_bff -->|"10"| catalog
  mobile_bff -->|"11"| ordering
  mobile_bff -->|"12"| platform
  platform -->|"13"| accounts_api
  web_shop -->|"14"| accounts_api
  web_shop -->|"15"| catalog
  web_shop -->|"16"| content_api
  web_shop -->|"17"| fulfilment
  web_shop -->|"18"| loyalty_api
  web_shop -->|"19"| ordering
  web_shop -->|"20"| payments
  web_shop -->|"21"| platform
  web_shop -->|"22"| session_cache
```

| # | From | To | Relations |
| --- | --- | --- | --- |
| 1 | Accounts | Accounts database | stores accounts and addresses |
| 2 | Content | Content database | stores pages |
| 3 | Customer | Mobile app | browses and buys in the app |
| 4 | Customer | Web shop | browses and buys on the web |
| 5 | Loyalty | Loyalty database | stores points |
| 6 | Loyalty | Platform | subscribes to order-placed: awards points for placed orders |
| 7 | Mobile app | Mobile back end | loads screens |
| 8 | Mobile app | Payments | tokenizes the card |
| 9 | Mobile back end | Accounts | shows and edits the account |
| 10 | Mobile back end | Catalog | searches products; shows product pages |
| 11 | Mobile back end | Ordering | checks out the cart; adds items to the cart |
| 12 | Mobile back end | Platform | signs the customer in |
| 13 | Platform | Accounts | looks up contact details |
| 14 | Web shop | Accounts | shows and edits the account |
| 15 | Web shop | Catalog | loads product images; posts a review; searches products; shows product pages; shows recommendations; shows reviews |
| 16 | Web shop | Content | loads landing pages |
| 17 | Web shop | Fulfilment | shows parcel tracking |
| 18 | Web shop | Loyalty | shows loyalty points |
| 19 | Web shop | Ordering | checks out the cart; downloads an invoice; adds items to the cart; requests a return; shows the order history |
| 20 | Web shop | Payments | tokenizes the card |
| 21 | Web shop | Platform | signs the customer in |
| 22 | Web shop | Session cache | keeps sessions |

Up: [Landscape](_landscape.md)

Open: [Catalog](catalog.md) · [Fulfilment](fulfilment.md) · [Ordering](ordering.md) · [Payments](payments.md) · [Platform](platform.md)
