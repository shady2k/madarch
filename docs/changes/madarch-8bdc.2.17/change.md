# Entity pages read only what they show

Change: madarch-8bdc.2.17
Base: 858806f92913c1a227908a597f2566586a93633b
Tasks: madarch-8bdc.2.17
Kind: no-behavior

## Intent

The api role's entity pages read far more than they show: the repository page issued one snapshot
transaction of 451 statements reading 45 747 rows, the commit page 86 statements/48 147 rows, the
file page 54/41 522 and the author page 0.32 s. The history block loaded every touched edge and
commit for a repository, the treemap looked every file up again for its in-degree, and the commit
block looked every changed file up again for its rename and symbols. This change replaces those
per-row loops and whole-repository reads with set-based queries bounded by the block's limit and
aggregates for totals.

## Out of scope

- The pages' visible content: sections, items, figures, totals and links stay the same.
- The fill, the graph schema and the entity-id rules.

## Rationale

A slow read is explained by its query plans and per-row timings, never by volume. The trace now
shows each block's spans and the transaction's statement/row counts; the page budget test fixes
the bound so a per-row read fails the suite.

## Changes to requirements

None. The pages' behaviour is unchanged; only the reads behind them change.

## Preserved contracts

- product-wiki/pages: the catalogue, repository, commit, file and author pages keep their sections, items, figures, totals and links.
- graph-queries/children: a neighbourhood answer is unchanged; only the reads that build it are bounded.

## Coverage

- product-wiki/pages: static test mutation review root-suite wiki-app-check wiki-app-test wiki-app-build
- graph-queries/children: test review root-suite

## Where it is seen

Kind: internal
Place: /api/k/page for the repository, commit, file and author entities
Reason: the pages keep the same content; only their query plans and trace spans change.
1. Open the repository page; it shows the same history, treemap and related blocks.

## Blocking questions

None.

## Design and decisions

The repository history is one aggregate query for its summary, one grouped query for hotspots
(with renamed paths merged) and one grouped query for authors. A commit's parents and branch
commits are set-based queries; its changed files are one query with churn, rename and symbol
counts. The treemap's in-degrees read the entities already fetched. The history evidence is cached
per snapshot and warmed with the product at server start; the server also opens each product's
reader before the first request. Block spans name every block in the trace.

Before/after, from the api role's trace on the madarch repository (1 876 files, 2 503 commits):

| Page | Before | After |
|---|---:|---:|
| repository | 451 statements / 45 747 rows / 4.5 s | 47 / 9 748 / 0.18 s |
| commit | 86 / 48 147 / 0.7 s | 64 / 3 731 / 0.07 s |
| file (.githooks/commit-msg) | 54 / 41 522 / 0.39 s | 46 / 281 / 0.06 s |
| author | 0.32 s | 55 / 1 582 / 0.06 s |

`EXPLAIN (ANALYZE, BUFFERS)` of the old full touched-edge read: Nested Loop, actual 23.1 ms,
90 459 shared buffers, 26 730 rows. The new repository summary: Aggregate, 7.3 ms, 25 054 buffers;
the new hotspots: GroupAggregate, 35.8 ms, 114 336 buffers, 2 795 groups. The old page repeated
that read per row; the new page reads it once per block.

## Acceptance evidence

- `test/knowledge-page-budget.test.ts`: a 1 800-file repository, four entity pages, statement and
  row bounds from the trace's `db.statements`/`db.rows` and time bounds.
- The walk store page JSON compared before/after: repository and commit history sections, items
  and totals are equal; the file and author history sections are unchanged (the file page keeps
  its commits and coupling; the author page its commits and files).
- CI wiki walk: `bun scripts/wiki-walk-ci.ts --baseline scripts/wiki-walk-baseline.json` passes.
