# The temporal graph store of decision 0028 exists beside today's stores

Change: madarch-bjdx
Base: 65d1b549541b44d88532e75e794a0656587a2e19
Tasks: madarch-bjdx
Kind: no-behavior

## Intent
Decision 0028 chooses one temporal graph in the process's database as madarch's knowledge store. This change builds the storage layer of that decision as a new module, src/graph, with the checks the decision names: the tables, the exclusion constraints over valid time, recorded time and architecture states, the append-only write path with its cascades, endpoint integrity, fenced publication of a unit's result, the reads at a date, a known time and a state, and the engine's and the product's two vocabularies. Nothing calls the module yet; a later stage moves the extraction and the wiki over to it.

## Out of scope
- Today's stores (fill_fact, the assertion log, the query projection): not touched, not dropped, not rewired.
- The extraction rewrite, the training-repository checks of 0028 (idempotent refill on 72 commits, rename keeps identity, dates on main) and the wiki's pages.
- Sweeping a producer's versions that a publication no longer repeats; a publication ends nodes explicitly.
- Performance: no latency target is set, and no size or plan is measured here.

## Rationale
A new module that no code path calls changes no product behaviour. Its database-owner change adds an option, btreeGist, that is off unless asked for.

## Preserved contracts
- model-history/store-version: the fact log still stores a source's model at a commit exactly as before; the graph module is added beside it and shares none of its tables
- model-history/lossless: what the history store holds still reads back as compiled, from its own tables, which the new module does not read or write

## Coverage
- model-history/store-version: test
- model-history/lossless: test

## Where it is seen

Kind: internal
Place: src/graph and its two test files in a madarch checkout
Reason: the module has no caller yet, so nothing a person reaches changes; the next stage connects the extraction and the wiki to it.

1. A developer opens test/graph-store.test.ts and test/graph-store-suite.ts and finds each constraint of decision 0028 as a named case on a small graph written out by hand.
2. They run the graph-store-postgres test with MADARCH_TEST_POSTGRES_URL set and see the same cases pass against a server.

## Blocking questions
None.

## Design and decisions
The design is decision 0028 (docs/decisions/0028-temporal-graph-store.md). Choices made inside it:
- Identifiers are bigint columns read as text, and instants are text with microseconds, because 0028 orders two commits that share a second by one microsecond.
- The database refuses what the write path never does: a trigger allows an update of a version only to close its recorded_to together with who closed it and why, and refuses every delete; another trigger holds content nodes to one set of bytes and claims to a digest.
- A work item is the only table beside the graph's own; it carries the unit's lease token, lease expiry, input digest and the published mark, and a publication locks its row.
- Reads take the lens as the first three parameters of one visibility predicate that is applied to every edge and to both end nodes on every hop; results that can be large are pages with a keyset cursor and a next marker.
- A concurrent writer that wins a lock second may hold an earlier recorded instant than a version the first just wrote; its close is recorded one microsecond after that version.

## Acceptance evidence
Run on the SkyPilot pod: bun run check exit 0; test/graph-store.test.ts and test/graph-store-postgres.test.ts, 38 cases each, all passing, the second against a PostgreSQL 17.5 server with btree_gist.

## DONE WHEN
Every constraint of decision 0028 that concerns the storage layer (graph-only, no-overlap, append-only, known-then, every-hop, endpoint-integrity, states-stable, acceptance-bound, content-immutable, fenced-publication, registry-kinds) is a passing case on PGlite and on PostgreSQL, and the pull request's CI is green on every shard.
