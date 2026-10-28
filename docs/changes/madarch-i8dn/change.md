# Publish a reader snapshot for a rebuild that has nothing to replace

Change: madarch-i8dn
Base: e49f36c4eff997dec15c1baf31179e5330d8b7f7
Tasks: madarch-i8dn
Kind: no-behavior

## Intent
The wiki answers while a fill runs. A product's first fill is always a rebuild, and
the rebuild guard held every snapshot back, so the server stayed on the empty store
it opened before the press: the Files list answered no rows for the whole fill and
the owner's walk failed on the empty list of a first fill. This restores what the
wiki already promised; it decides nothing new.

## Rationale
A rebuild with nothing to replace protects nothing by holding the reader back. It
now holds back only when a working index exists, and publishes the replacement once
at the first commit boundary. Publishing at every boundary was measured and refused:
five store copies and five reader processes pushed one page's 99th percentile to
349 ms against the 300 ms bound, where one publication keeps every path between
145 and 244 ms.

## Out of scope
- The Files list is still empty before the head tree is extracted (about 78 s of a
  92 s first fill of the training repository): there is no file to show before then.
- The extractor store's rebuild rules, the promotion snapshot and the fill's
  generations are unchanged.
- No page format, no tool guard and no requirement changes.

## Changes to requirements
None. The behaviour this restores is already required: the wiki answers while a
fill runs, and the host owns the publication of its reader snapshots.

## Preserved contracts
- product-wiki/live: a page follows its file as it is saved, and a fill in flight never hides what the store already holds. The store and the page format are untouched; only the moment a snapshot is offered changed.
- fill-orchestrator/host: the background server owns the orchestrator and the fill publishes through it. The publication still happens through the same host, once per rebuild with nothing to replace, and the promotion snapshot is unchanged.
- product-wiki/pages: the Files list shows the files of the head tree with the count the status reports. The listing, its paging and its count are unchanged.

## Coverage
- product-wiki/live: test
- fill-orchestrator/host: test
- product-wiki/pages: test

## Blocking questions
None.

## Design and decisions
One condition in the fill worker's `snapshot()`: hold the reader back only when a
rebuild has a working index to keep. A rebuild with nothing to replace publishes
once, sets `published`, and the reader keeps that snapshot until the promotion
snapshot at the end. The owner's walk is the regression check and stays as it is.

## Acceptance evidence
On the pod, `bun run check && bun test test/knowledge-responsive.test.ts` (without
`MADARCH_SKIP_PERF`, which would skip the walk): exit 0, three times — the
worker's instrumented run at 94 s and clean run at 92 s, and this lane's run at
95 s with every page's 99th percentile at 200-238 ms and the last during-fill Files
samples at total 114-115 with 100 rows. PR CI carries the suite.

## Where it is seen
Kind: internal
Place: the Files list of a product while its first fill runs
Reason: the change is invisible as a design — no screen, page or message is added or altered. The Files list a person already reads is what it was; during a first fill it now has the content it shows after one, instead of being empty until the fill ends.

1. A person presses fill on a product that has never been filled, and opens the Files list: it shows the files of the head tree from the first commit boundary on, with the count the status reports.

## DONE WHEN
The owner's walk passes on the pod with the Files list showing files during a first
fill, and every page stays under its 300 ms bound.
