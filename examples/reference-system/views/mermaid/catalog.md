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
  search_api -->|"reindexes changed prices; reindexes changed products; updates availability in the index"| platform
  search_api -->|"queries and updates the index"| search_index
  storefront -->|"loads product images"| media_api
  storefront -->|"shows product pages"| products_api
  storefront -->|"shows recommendations"| recommendations_api
  storefront -->|"posts a review; shows reviews"| reviews_api
  storefront -->|"searches products"| search_api
```

Up: [Landscape](index.md)

Open: [Ordering](ordering.md) · [Platform](platform.md) · [Storefront](storefront.md)
