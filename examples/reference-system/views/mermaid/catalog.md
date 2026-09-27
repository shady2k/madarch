# Catalog (domain)

```mermaid
%%{init: {"flowchart": {"curve": "linear"}}}%%
flowchart LR
  subgraph catalog ["Catalog"]
    media_api["Media"]
    media_bucket[("Product images")]
    prices_api["Prices"]
    prices_db[("Prices database")]
    products_api["Products"]
    products_db[("Products database")]
    recommendations_api["Recommendations"]
    recommendations_cache[("Recommendations cache")]
    reviews_api["Reviews"]
    reviews_db[("Reviews database")]
    search_api["Search"]
    search_index[("Search index")]
  end
  ordering["Ordering"]
  platform["Platform"]
  storefront["Storefront"]
  media_api -->|"1"| media_bucket
  ordering -->|"2"| prices_api
  prices_api -.->|"3"| platform
  prices_api -->|"4"| prices_db
  products_api -.->|"5"| platform
  products_api -->|"6"| products_db
  recommendations_api -.->|"7"| platform
  recommendations_api -->|"8"| products_api
  recommendations_api -->|"9"| recommendations_cache
  reviews_api -->|"10"| reviews_db
  search_api -.->|"11"| platform
  search_api -->|"12"| search_index
  storefront -->|"13"| media_api
  storefront -->|"14"| products_api
  storefront -->|"15"| recommendations_api
  storefront -->|"16"| reviews_api
  storefront -->|"17"| search_api
```

| # | From | To | Relations |
| --- | --- | --- | --- |
| 1 | Media | Product images | stores product images |
| 2 | Ordering | Prices | reads list prices |
| 3 | Prices | Platform | publishes price-changed |
| 4 | Prices | Prices database | stores list prices |
| 5 | Products | Platform | publishes product-changed |
| 6 | Products | Products database | stores the catalogue |
| 7 | Recommendations | Platform | subscribes to order-placed: learns from placed orders |
| 8 | Recommendations | Products | reads product details |
| 9 | Recommendations | Recommendations cache | caches recommendations |
| 10 | Reviews | Reviews database | stores reviews |
| 11 | Search | Platform | subscribes to price-changed: reindexes changed prices; subscribes to product-changed: reindexes changed products; subscribes to stock-changed: updates availability in the index |
| 12 | Search | Search index | queries and updates the index |
| 13 | Storefront | Media | loads product images |
| 14 | Storefront | Products | shows product pages; shows product pages |
| 15 | Storefront | Recommendations | shows recommendations |
| 16 | Storefront | Reviews | posts a review; shows reviews |
| 17 | Storefront | Search | searches products; searches products |

Up: [Landscape](_landscape.md)

Open: [Ordering](ordering.md) · [Platform](platform.md) · [Storefront](storefront.md)
