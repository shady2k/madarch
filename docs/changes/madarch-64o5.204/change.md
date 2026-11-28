# Search answers on a freshly published wiki catalogue

Change: madarch-64o5.204
Base: b1b9ceb27238dd19806e74929bff643878966f99
Tasks: madarch-64o5.204
Kind: no-behavior

## Intent

Open Search from the toolbar or a shared link on a fresh `everything` product.
Searching for a catalogue kind shows its match. A term absent from the graph
and the catalogue shows the empty state in the reader's language.

## Rationale

The packaged wiki sent the grouped search operation. PostgreSQL built a branch
for each searchable field in every declared kind, including kinds with no stored
vertices. The direct search reached the read worker's 30-second deadline and
returned HTTP 200 with the GraphQL error `TIMEOUT`.

Search builds field expressions only for kinds with stored vertices. An
indexed existence probe finds these kinds without applying the read snapshot's
visibility filters. The visibility check reads existence assertions only for
the chosen kinds, and each field branch filters the active vertices by kind
before reading the field. The search uses the same snapshot, matching and
ranking rules. The separate search of catalogue labels and definitions still
supplies catalogue matches before any Fill runs.

The toolbar uses the existing localized loading message while the refresh
button is disabled during a page read. Table, Relations and Treemap use
localized messages while loading and at the first and last page.

## Preserved contracts

- product-wiki/serve: the packaged wiki reads page contents through GraphQL and keeps the existing toolbar and direct search routes.

## Coverage

- product-wiki/serve: static, test, mutation, review
