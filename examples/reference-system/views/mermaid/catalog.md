# Catalog (domain)

```mermaid
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
  media_api -->|"stores product images"| media_bucket
  ordering -->|"reads list prices"| prices_api
  prices_api -->|"publishes price-changed"| platform
  prices_api -->|"stores list prices"| prices_db
  products_api -->|"publishes product-changed"| platform
  products_api -->|"stores the catalogue"| products_db
  recommendations_api -->|"learns from placed orders"| platform
  recommendations_api -->|"reads product details"| products_api
  recommendations_api -->|"caches recommendations"| recommendations_cache
  reviews_api -->|"stores reviews"| reviews_db
  search_api -->|"3 relations, see 11"| platform
  search_api -->|"queries and updates the index"| search_index
  storefront -->|"loads product images"| media_api
  storefront -->|"shows product pages"| products_api
  storefront -->|"shows recommendations"| recommendations_api
  storefront -->|"posts a review; shows reviews"| reviews_api
  storefront -->|"searches products"| search_api
```

| # | From | To | Relations |
| --- | --- | --- | --- |
| 1 | Media | Product images | stores product images |
| 2 | Ordering | Prices | reads list prices |
| 3 | Prices | Platform | publishes price-changed |
| 4 | Prices | Prices database | stores list prices |
| 5 | Products | Platform | publishes product-changed |
| 6 | Products | Products database | stores the catalogue |
| 7 | Recommendations | Platform | learns from placed orders |
| 8 | Recommendations | Products | reads product details |
| 9 | Recommendations | Recommendations cache | caches recommendations |
| 10 | Reviews | Reviews database | stores reviews |
| 11 | Search | Platform | reindexes changed prices; reindexes changed products; updates availability in the index |
| 12 | Search | Search index | queries and updates the index |
| 13 | Storefront | Media | loads product images |
| 14 | Storefront | Products | shows product pages |
| 15 | Storefront | Recommendations | shows recommendations |
| 16 | Storefront | Reviews | posts a review; shows reviews |
| 17 | Storefront | Search | searches products |

Up: [Landscape](_landscape.md)

Open: [Ordering](ordering.md) · [Platform](platform.md) · [Storefront](storefront.md)
