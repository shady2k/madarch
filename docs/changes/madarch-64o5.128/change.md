# A kind's records: search, filters with counts, sortable columns and server paging

Change: madarch-64o5.128
Base: b43b57ff88f525024961bdd2f855531643b3dc44
Tasks: madarch-64o5.128
Kind: behavior

## Intent
The owner's walk of the wiki after the first fill: «Где поиск? Где пагинация?». The records table of every kind had lost
the search, the sorting and the paging the old kind page had (audit 299, §5 row 48, §6 row 67): the table component drew
a search box, a sort select and a pager only when the template's query declared variables the page contract refused to
bind, so no template declared them. The generic `instances` read took `first` and `after` and nothing else.

Now the contract binds a section's own filter and order variables, `instances` takes both, and the table draws a search
field and a Find button, one facet row per declared field with each value's count, sortable column headers (a second press
reverses), and the server's page summary with the next and previous presses. The entity page's relation lists page too:
their queries ask a first and an after variable of their own, so more than fifty rows are reachable.

## Out of scope
The dependency graph of kinds (madarch-64o5.124) and the place column of a record (audit §5 row 49).

## Rationale
A reader who cannot search, narrow or turn a page of a kind's records cannot read them: 116 problems and thousands of
files arrive in one list.

## Changes to requirements
- product-wiki/views: a kind's records table is searched, filtered with counts, sorted and paged by the graph.

## Preserved contracts
- views/one-view: the picture and the page's other sections are unchanged.

## Coverage
- product-wiki/views: test
- views/one-view: test

## Where it is seen
Kind: screen
Place: a kind's catalogue entry page, section «Записи», and an entity page's relation lists
Mockup: docs/prototypes/madarch-64o5.128/records-1440-light.png
1. The reader types in «Поиск по записям» and presses «Найти»; the table shows only the records the graph matched, and the summary counts them.
2. Each facet value carries its count; pressing one narrows the table, pressing it again releases it.
3. Pressing a column's name orders the table, and a second press reverses it.
4. The pager shows the page's rows out of the whole and reaches the next page from the server.
