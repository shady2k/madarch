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

The existing search builds field expressions only for kinds with stored
vertices. The presence probe uses the index of stored nodes by kind.
Search still applies the operation's visibility and time filters when it
matches fields. The separate search of catalogue labels and definitions
still supplies catalogue matches before any Fill runs.

The toolbar uses the existing localized loading message while the refresh
button is disabled during a page read.

## Preserved contracts

- product-wiki/serve: the packaged wiki reads page contents through GraphQL and keeps the existing toolbar and direct search routes.

## Coverage

- product-wiki/serve: static, test, mutation, review
