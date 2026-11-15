# Diagram presses stay under the product's base, and an unknown address reads as a page

Change: madarch-64o5.98
Base: 8b3c73cb7bfa96b18c8c6f98e7f3ee2d6590d65c
Tasks: madarch-64o5.98
Kind: no-behavior

## Intent
The owner's walk on a products-home server: a press on a Mermaid node opened /e/code.file/<id> without the
/products/<folder> prefix, and the home answered raw JSON. The product's handler sees the path after the prefix, so the
diagram links were bare app addresses; Mermaid's own SVG link is xlink:href, which the pane did not read.

The home now names the product's prefix on the forwarded request, every diagram link (Mermaid, LikeC4, archify) stands
under it, and the pane follows xlink:href. An address the home does not serve answers an HTML page in the reader's
language naming the products with links; an API client still gets its JSON.

## Out of scope
The diagram's readability and fit (madarch-64o5.96) and the width of pages (madarch-64o5.99).

## Rationale
A link that leads to the server's JSON is a broken page; a home that answers JSON to a person is not a wiki.

## Changes to requirements
None.

## Preserved contracts
- views/one-view: the picture and its nodes are the same; only the address each node names carries the product's prefix.
- server/serves-wiki: one server still serves each product's wiki under /products/<folder>/; unknown addresses now say so as a page.

## Coverage
- views/one-view: test
- server/serves-wiki: test

## Where it is seen
Kind: screen
Place: a product served by a products home, /products/<folder>/e/<kind>/<id>, section «Вокруг»
1. A press on a Mermaid node opens the node's page under /products/<folder>/e/… without a page load.
2. A press on a LikeC4 node and on an archify node does the same.
3. Opening an address the home does not serve shows a page naming the products with links, not the server's JSON.
