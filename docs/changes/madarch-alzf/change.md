# Publish in bounded pages, and let the audit stream its rows instead of holding them all

Change: madarch-alzf
Base: b96a5904b45283d085992317c962f9509691a437
Tasks: madarch-alzf
Kind: no-behavior

## Intent
The graph audit could not walk a repository of madarch's own size on one 12 GB pod: extraction was killed at 8 GB and 12 GB after `raw-extractions-partial.json` reached 232 MB for a 1 568-file slice, and the store walk over that slice did not finish in 60 minutes. The same task measured two extractor passes at 1 844 s over `src/` alone, of which `code.extract.operations` took 856.7 s and `code.extract.contracts` 846.9 s. The two causes were separable: the audit serialized every extractor's whole output after each producer and held the raw phase beside the fill, and the fill wrote one record at a time on the thread that also answers readers.

This branch removes the retained whole-output string and the two copies of the raw rows, gives the later extractors the facts the code pass already built instead of making them rebuild those facts, indexes the lookups that rescanned every expression, and pages the publication's large reads, locks, identity reservations and edge writes. A reader gets a turn between pages, so a 5 000-edge publication no longer waits behind one statement. Edge identities tolerate a concurrent publication that wrote the same key after the first lookup. The audit's generated raw bytes and the publication's transaction and exactly-once rules stay as they were.

The measurements in this record are the training product's and the 300 ms responsive suite's. PR #200 (`fix/madarch-alzf-peak-memory`) stacks on this branch under the same task, and its five-run measurement is quoted below. The task's 12 GB whole-repository run is not repeated here and is still owed.

## Rationale
The audit's peak was not one large database: it was the accumulated extraction serialized as one `JSON.stringify` string, the code facts kept after the last extractor that used them, and the raw rows kept alive while the fill extracted and published them again. Streaming the same JSON bytes, making the partial stream append-only, dropping the facts after the last consumer and releasing the raw rows before the fill remove those copies without changing a byte of `raw-extractions.json`. The later extractors already receive the code pass's facts from the production driver; the audit now supplies them too, and their lookups use the indexes `TreeText` already holds rather than scanning every expression for each call. No product requirement is changed: the same facts are emitted and the same audit rows are counted.

The publication's statements are bounded for the same reason the query engine yields between batches: PGlite runs a statement on the thread that owns it, so one `= ANY` over 1 393 nodes or one 5 000-row insert is the reader's whole wait. Every multi-row statement now names at most 100 rows, preparation yields after ten rows or four milliseconds, and the event loop gets a turn between pages. The transaction is still one transaction and the identity reservation still leaves its unused ids as gaps; a concurrent row is read back rather than aborting the publication.

## Out of scope
- The 12 GB whole-repository acceptance run, the 1 568-file store walk, and any claim that the whole repository now fits: no run of that size is recorded on this branch.
- The reader's snapshot swaps and PGlite process startup, which produce the remaining tail in the responsive measurements; this branch neither redesigns nor removes them.
- Changing the 100-row edge or identity batch sizes, the publication's one-transaction boundary, its fencing, its exactly-once rule or its per-record error fallback.
- A capability change: no current requirement's text or promised behaviour changes.

## Changes to requirements
None. The publication still stores a generation whole or not at all, still answers one publication or a refusal per generation and still reads back as compiled; the audit still writes the same raw rows. The change bounds the rows in a statement and the time between reader turns; it does not change what is stored, what is answered or when a publication is accepted.

## Preserved contracts
- fill-orchestrator/publish: the publication remains one short transaction of the process's one database owner; batching and reader turns happen inside it, the publication record and the queue settlement stay in the same transaction, and a failed application still leaves no publication, no fact and no state change.
- model-history/store-version: every assertion is still stored with the commit's valid time and the storing moment's recorded time; paging changes how many rows one statement names, not which rows or times are written.
- model-history/lossless: what is stored still reads back as compiled; the graph-store round-trip and rollback suites pass unchanged over the paged path.

## Coverage
- fill-orchestrator/publish: test
- model-history/store-version: test
- model-history/lossless: test

## Where it is seen

Kind: internal
Place: any page read while a fill publishes, and the audit command's `raw-extractions.json`
Reason: no screen, control or message is added: the same pages answer during the same fill, and the audit writes the same file. What changes is how long a reader waits behind a publication statement and how much of the audit's output is held in memory.

1. Start a fill of the training product and open its pages while commits are published: the 99th percentile of every page's answers stays under 300 ms, and the slowest answer stays under 1 s.
2. Run the audit over the training product and compare `raw-extractions.json` with the file from the branch's parent: the bytes are identical, while the partial stream is append-only and the fill no longer holds the raw rows beside its own extraction.
3. Publish a unit with a large edge set: its node lookups, locks, slices, identity rows and edge writes are several statements of at most 100 rows, with a reader turn between them, and the unit is still published whole.

## Blocking questions
None.

## Design and decisions
`scripts/extract-truth-json.ts` writes exactly what `JSON.stringify(value, null, 2)` writes, in 64 KiB chunks: the same indentation, key order, escaping and omission of undefined object members, including `null` for an unsupported array element or a sparse hole. `extract-truth-audit.ts` appends each producer's complete extraction to `raw-extractions-partial.jsonl` and rewrites a small manifest after it, so an interrupted run names every producer it completed without loading the stream. It passes the code pass's facts to the later extractors and drops them after the last one; after writing and auditing the raw rows it releases them before the fill extracts again, and reads the raw summary back from its file for the final summary.

`src/extract/library-models/evaluate.ts` indexes member models by member and export models by package, caches local imports and export paths, and only visits the candidate models of a call's own packages. `src/extract/operations/route-facts.ts` uses the `TreeText` indexes (`sitesBySpan`, `symbolsByKey`, `fieldsByKey`, `expressionsBySpan`, `parentsByChild`, `expressionsBySyntax`) and caches the external origin, canonical site, owner and call list instead of scanning the whole fact set per call.

`src/graph/versions.ts` pages node lookups, `FOR SHARE`/`FOR UPDATE` locks, node slices, edge-identity lookups and rereads, current-edge reads and new-node reservations into at most 100 rows, with `yieldToReaders()` between pages. `prefetchNodeSlices` keeps its cached slice list for `currentSlices`, so a publication of N edges does not issue 2N reads. The edge and identity statements remain 100 rows; preparation yields after ten rows or four milliseconds. `edgeIdentities` inserts with `ON CONFLICT (key_hash) DO NOTHING`, reads the actual rows back, and leaves the ids reserved for lost rows as gaps. Prefetch computes key hashes without validating, so the ordered publish loop still reports the first malformed edge rather than an earlier endpoint failure hiding a later unknown relation. `src/graph/publish.ts` uses the paged edge insert in one batch per publication and keeps the per-record path as the error fallback.

## Acceptance evidence
On the branch's final tree, 2026-10-29:

- `bun install --frozen-lockfile`: exit 0.
- `bun run check`: exit 0 (`tsc --noEmit`).
- `bun test test/graph-publish-bounds.test.ts test/graph-edge-identities.test.ts test/graph-store.test.ts test/extract-truth-json.test.ts`: 60 pass, 0 fail, 2 045 expect calls, 5.43 s.
- `bun test test/extract-review-evidence.test.ts`: 11 pass, 0 fail, 112 expect calls, 0.14 s.

The recorded measurements on the same publication and audit code are:

- The audit's median on the training product moved from 15.35 s to 13.51 s and the PGlite fill's median from 7.24 s to 5.10 s; the earlier commit measured 1.77x audit and 1.79x fill, with `raw-extractions.json` byte-identical and peak memory unchanged at that point (the code pass's retained facts dominated then; the later commits drop those facts and the raw rows).
- The fill ran in 13-15 s against a 23 s baseline after the edge batch landed.
- Five responsive runs on a two-core VM: branch p99 68/80/77/72/64 ms (median 72) and slowest answer 356/245/256/331/258 ms (median 258); `origin/main` at `96b05588` p99 74/73/77/94/85 ms (median 77) and slowest 439/340/1290/338/346 ms (median 346), with main's 1 290 ms run exiting only on the separate 1 s bound.
- The stacked peak-memory branch passed five of five runs at p99 57-74 ms and slowest 248-300 ms.

The final merge `4e3d183e` carries `origin/main` at `b96a5904`; `git diff c003a3c9 4e3d183e -- src/graph src/extract scripts/extract-truth-audit.ts scripts/extract-truth-json.ts test/graph-publish-bounds.test.ts test/graph-edge-identities.test.ts` is empty, so those measurements remain measurements of the code in this bundle. The full repository suite was not run, and neither was the 12 GB whole-repository audit. No bound or assertion was weakened.

## DONE WHEN
The training product's audit writes byte-identical raw rows without building the whole file as one string, releases the raw rows before the fill, and hands the code facts to the later extractors; every large publication read, lock and write is a bounded page with a reader turn between pages; the responsive suite passes its 300 ms p99 bound on five consecutive runs and its 1 s slowest-answer bound; and the graph-store publication, idempotence, rollback and round-trip suites pass unchanged. The 12 GB whole-repository run is the task's remaining acceptance, not this record's.
