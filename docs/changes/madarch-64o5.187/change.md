# A kind's catalogue page states the fields its declaration names

Change: madarch-64o5.187
Base: 898838c8755a5341923ecf16e24d022bde4e662f
Tasks: madarch-64o5.187
Kind: no-behavior

## Intent

A kind's page extends the base entity page (decision 0036, section 6). Its inherited Details section requests
`details`, while the catalogue replaces the base header. The read layer returned null for
`CatalogueEntity.details`, which the schema declares as `[Detail!]!`, so GraphQL refused the whole page
operation:

    Cannot return null for non-nullable field CatalogueEntity.details.

The page therefore showed an error instead of the kind's records: the table and its rows were read correctly, and the
operation carrying them was refused. It failed for a kind a product declares in its manifest and for the starter
catalogue's own kinds alike.

A catalogue entry now states its details as the fields its declaration names, in code-point order: the name and the
type the published field carries, the key mark the published kind gives, and no value, no dispute and no opinion,
because a declaration holds none of its own. Its `trail` is empty: a kind is the root of its records and sits in no
container. Ordinary entities' details and trails are untouched.

No requirement changes. The Entity interface already requires both fields of every entity type.

## Out of scope

The catalogue page's other surfaces and the wiki's authored editing controls (madarch-64o5.194), the author named in the
journal's reader-facing text (madarch-64o5.195), and the values a kind's records hold, which the records table reads.

## Rationale

The declarations are already in the graph: the entry's `fields` are the `manifest.field` records published at start,
read by the same `catalogueData` call the catalogue page makes. Answering `details` from them adds no source and no
second read; returning an empty list instead would leave the Details section blank even where the graph names the
fields, so the page would still say nothing of the kind it opens. The alternative — teaching the page a different
field set for a kind — would put the kind's declaration behind a second contract beside the one every entity type
already shares.

## Preserved contracts

- server/serves-wiki: one page view is one GraphQL operation, `CatalogueEntity` answers every field the `Entity` interface declares, and an ordinary entity's details and trail answer as before.
- wiki/pages: the catalogue page composes the sections its template names over the kind's type, and a page whose operation is refused fails as a whole.

## Coverage

- server/serves-wiki: test
- wiki/pages: test

## Where it is seen

Kind: screen
Place: a served product's wiki, at the address of a kind's catalogue entry
Mockup: docs/prototypes/templates-catalogue.html

1. A person adds a kind to a product's manifest (a Git commit in the product) and opens its catalogue entry from the
   navigation: the page shows the kind's records table, the note written on it, and a Details block naming each field
   the declaration gives, with the key marked.
2. The person removes the kind from the manifest and opens the same address: the records table is gone and the page
   names no records.
