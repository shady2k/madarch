# Reliable facts and totals on kind pages

Change: madarch-64o5.52
Base: 149cb17a4bdf30b73c5cff44185699e7e9dcb59b
Tasks: madarch-64o5.52
Kind: no-behavior

## Intent

Kind page facts count the effective records of the kind. Preserve the filtered total when a records cursor runs out, display timestamps in rankings, and keep equally named ranked records in separate rows.

## Out of scope

Catalogue selection and fill configuration belong to separate tasks.

## Rationale

The graph already selects one effective value per entity and reads a composed page in one repeatable-read transaction. The fixes carry those results through the records cursor and the wiki's chart and table rendering.

## Changes to requirements

None.

## Preserved contracts

- product-wiki/pages: a page composes its facts and paged records as one GraphQL request, read in the snapshot defined by decisions 0036 and 0039.
- product-wiki/catalog: kind pages read effective records once per entity, as specified by decisions 0036 and 0039.

## Coverage

- product-wiki/pages: test
- product-wiki/catalog: test

## Where it is seen

Kind: request
Place: the GraphQL operation composed for a wiki kind page
1. Publish records with multiple sources and translated values. The facts and records count each active entity once.
2. Group, bucket, or rank by a timestamp. The timestamp contributes to the answer and the ranking shows the date and time.
3. Commit a write between the page's SQL reads. The facts and records reflect the same snapshot, and a new page request sees the committed write.
4. Ask for a page after the last record. The page has no rows and the total still describes the filtered population.

## Blocking questions

None.
