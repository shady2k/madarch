# The packaged wiki's Logs page reads the machine's logs again

Change: madarch-64o5.200
Base: 898838c8755a5341923ecf16e24d022bde4e662f
Tasks: madarch-64o5.200
Kind: no-behavior

## Intent

The owner's acceptance of ALX-1936 walked a fresh packaged product: the «Журналы» screen failed with
`Cannot return null for non-nullable field Query.logs`, while the logs stood on the disk beside the store. The page reads
`Query.logs` through `POST /graphql`, and the api role answers a graph operation in the read worker. The descriptor
`KnowledgeProduct.readDescriptor()` hands the worker the product's graph connection and nothing else, while
`logsReaderOf()` needs two more paths — the product's store folder and the knowledge root its logs stand under — and
answers no logs reader without them, which the non-nullable `logs: JSON!` turns into that refusal.

After that change the descriptor carries both paths, the same pair `product.logs()` already hands the read of
`/api/logs`: the field answers one structured page of every log madarch keeps for the product, keeps the source, level,
run, text and window filters and the paging of that read, and answers an empty page — `entries: []`, `more: false`,
`scanned`, `truncated`, the runs, the sources and the levels — when nothing matches.

The review of that correction (ALX-2008) approved the descriptor and found three faults beside it, all of them on the
page's own path through the field. This change carries the correction of all three on top of the two reviewed commits
(`af34eb10d`, `f66b8d729`), which stand unchanged on the branch:

1. **An absent filter arrives as an explicit null.** The page's operation sends `level: null` for "All levels" and when
   the level filter is reset, and the read worker refused a null as an unknown level. The screen therefore failed at
   its first load, before any selected level could help.
2. **A moment is epoch milliseconds, which a 32-bit GraphQL `Int` cannot carry.** `2026-11-27T18:00:00Z` is
   `1795802400000` against `Int`'s `2147483647`, so a date filter, the older page and the live tail — all three send
   the moment in milliseconds — were refused before the read started.
3. **The lower bound never reached the read.** `from` was handed over as `since`, a name the read's own query does not
   hold, so `from` excluded nothing and answered every record the other filters kept.

## Out of scope

- The page's own drawing and the kit's log viewer: unchanged, and its tests pass untouched.
- The `GET /api/logs` route: it reads `product.logs()` in the api process, keeps `LogQuery`'s own `from` and answered
  before these changes.
- The fill role's own reads, the run page's journal and what the agent units record: madarch-64o5.88 owns them.
- Which logs exist and where each one stands: the sources, their files and their bounds are that change's.
- The pages and the graph reads outside `Query.logs`: no other field and no other root changes here.

## Rationale

**The null.** The page states a filter it does not apply as an explicit null, and a nullable GraphQL argument hands
that null to the reader as it came (`src/graph/read-worker.ts`). An absent filter and a null one are the same ask, so
the reader now reads a null as absent — `asked.level ?? undefined` — which is what the operation's own comment already
claimed ("a filter the page did not ask for is null, which the schema reads as absent"). The alternative, changing the
page to omit the key, would leave the same trap for every other client of the field and fight the client's own
`variablesOf()`.

**The moments.** `from` and `before` are declared `Float` (`src/graphql/schema.ts`), GraphQL's double: it holds every
whole number below 2^53 exactly, so a millisecond stays a millisecond for any date a log can carry, and the reader
floors one anyway. `Float` is the smallest complete choice among the scalars the schema already publishes: `Int`
refuses the values, `BigInt` parses any input untouched (a string would reach the reader as a string and silently
ignored), and a new scalar would add a name, a coercion and a test for a value the schema types can already carry.
`limit` stays an `Int`, because the page size is bounded by the reader (`MAX_PAGE`). The page's operation
(`wiki/app/src/components/logs-query.ts`) declares the same two types, and so do the two published SDLs —
`src/graphql/starter.graphql` and `test/graphql/fixture.golden.graphql` — which their byte-for-byte tests check. The
`logs` field itself is madarch-64o5.88's own and shipped in the same undelivered change, so its signature moves with it
and no released client builds against the old one.

**The lower bound.** `logsAnswer` reads `LogQuery.from`, and the reader filters `entry.at <= query.from` out. The
worker built its query under the name `since`, which no field of `LogQuery` holds; a spread keeps excess properties
out of TypeScript's excess-property check, so the compiler said nothing and the read dropped the bound. It is `from`
now, and the boundary stays what it was: `from` exclusive, `before` exclusive, oldest first, the newest page kept.

## Changes to requirements

None. The change realizes the Logs page's own proposed requirement (`product-wiki/logs`, proposed by change
madarch-64o5.88): one page of every log madarch keeps, read through the product's one read API, with its filters and
paging and an empty state. No requirement text moves.

## Preserved contracts

- product-wiki/serve: a served product still answers its wiki's reads through `POST /graphql` by the api role, one operation in its own read-only snapshot answered by the read worker; the page and the route that was already answered are unchanged (static)
- product-wiki/logs: the window's own meaning is untouched — `from` and `before` are epoch milliseconds, both exclusive, entries oldest first, one page of at most `MAX_PAGE` kept from the newest end (test)

## Coverage

- product-wiki/serve: static, test, mutation, review
- product-wiki/logs: static, test

## Where it is seen

Kind: screen
Place: the wiki's «Журналы» page of a packaged product, opened from the sidebar
Mockup: docs/changes/madarch-64o5.88/mockups/logs-1440-light.png

1. Make a fresh packaged product with `madarch init` on a new folder and the `everything` template, then run
   `madarch serve` and open its wiki in a browser.
2. Open «Журналы»: the page lists the machine's log rows, the server's own records at least, instead of the
   `Query.logs` refusal.
3. Choose a source, a level and a run, set a window and type a text that no row holds: the page answers its empty
   state, and the filters still name the sources, the levels and the runs they can offer.
4. Set a date in the window, press «Старые» for the page before, and leave the live tail on: the page answers each
   read, and the tail adds only the rows newer than the newest one it holds.

## Blocking questions

None.

## Acceptance evidence

Every line names the command, its exit status and the revision it covered. The earlier block ran in SkyPilot through
`madarch-sky-test`, on the two imported commits; this correction's block ran in box `alx1936-logs` (2 vCPU, 4 GiB,
`/work/madarch`), as the card asks.

### Revision `f66b8d729` — the two imported commits, before this correction

- Static: `bun run check` — `tsc --noEmit` exit 0 (run-20261128-002757). The chain then stops, on this revision **and
  on the base commit `7e7dc946b` and on `origin/main` `f1917a675` alike**, at two checks this change does not turn:
  `check:architecture` refuses three entries of `.architecture/violations.json` that no rule finds any more (both
  `code.image` entries and the `digest` one, all `src/knowledge/graph-verdict-rules.ts`; run-20261128-002941 for the
  base, run-20261128-003445 for `origin/main`), and `check:catalog` refuses the `everything` template's kinds whose
  `derives-from` names a kind the manifest does not declare (`build-artifact`, `build`, `builder`, `code.image`,
  `code.compose-service`; run-20261128-003612 for `origin/main`). `check:ui`, `check:workflows`, `check:slow-tests`,
  `check:quarantine` and `check:tests` pass on this revision.
- Test: `test/logs-graphql.test.ts` failed before the descriptor change with the reported
  `Cannot return null for non-nullable field Query.logs` and passes after it (run-20261128-002610 and
  run-20261128-002706); the file with `test/logs.test.ts` answers 8 pass, 0 fail (run-20261128-003809). The full suite
  `MADARCH_SKIP_PERF=1 bun test test/` on a 2 CPU / 8 GB pod answers 3284 pass, 167 skip, 279 fail of 3730 tests across
  511 files (run-20261128-004219); the failing families — the starter catalogue's schema and workflows, the CLI and
  daemon readiness cases, the GraphQL executor — fail the same way on the base commit, checked file by file
  (test/graphql-executor.test.ts, test/graphql-schema-route.test.ts, test/graphql-starter.test.ts,
  test/catalogue-diagram.test.ts, test/catalogue-kind-relations.test.ts and test/api-role-first-page.test.ts: 16 fail
  on the base `7e7dc946b` in run-20261128-020455, 17 on this revision in run-20261128-015933, and the one case that
  differs fails on the base in isolation too, run-20261128-020900).

### The three faults on revision `f66b8d729` — one focused run each

The corrected `test/logs-graphql.test.ts` run against the pre-correction tree, its operation written as that revision
shipped it (`$from: Int, $before: Int`, every filter an explicit null):

- `MADARCH_SKIP_PERF=1 bun test test/logs-graphql.test.ts` — 2 pass, 2 fail, exit 1. The two cases this change adds
  fail on the faults they hold:
  - **the null level:** `/work/madarch/src/graph/read-worker.ts:1: "level" is one of debug, info, warn, error, got
    null`, raised from `src/graph/read-worker.ts:104` and read as `the graph refused the logs read` at
    `/work/madarch/test/logs-graphql.test.ts:83` (case at line 150).
  - **the millisecond moment:** `/work/madarch/src/graph/validation.ts:1: /variables: expected values matching the
    operation variable definitions, got {"sources":null,"level":null,"run":null,"q":null,"from":1795802400000,
    "before":null,"limit":null}`, the `Int` declaration of `src/graphql/schema.ts:566` refusing a real date
    (assertion at `/work/madarch/test/logs-graphql.test.ts:83`, case at line 168).
- The lower bound alone, with the first two faults patched on that tree (the null reading and the `Float` moments
  applied, `since` left as it was): `MADARCH_SKIP_PERF=1 bun test test/logs-graphql.test.ts -t "a window carries epoch
  milliseconds"` — 0 pass, 1 fail, exit 1, at `/work/madarch/test/logs-graphql.test.ts:169`: expected
  `['the plugin read a file its parser does not know']`, received `['fill started', 'the plugin read a file its parser
  does not know']` — the record at the lower bound stood, because `from` was handed over as `since` and excluded
  nothing (`src/graph/read-worker.ts:120`).

### Revision `29fda91b9` — this correction (the head below `f66b8d729`)

- Static: `bunx tsc --noEmit` — exit 0. Full chain `bun run check` — exit 0: architecture 499 violations, all 499
  listed; `check:ui` 0 violations; `check:catalog` 28 areas, 106 subgroups, 503 kinds, the `everything` template with
  120 kinds and no finding; `check:workflows` 4 workflows; `check:slow-tests` 65 listed, 503 measured files, no
  finding; `check:quarantine` 65 excluded files; `check:tests` 0 violations.
- Test: `MADARCH_SKIP_PERF=1 bun test test/logs-graphql.test.ts test/logs.test.ts test/graphql-schema.test.ts
  test/page-contract.test.ts` — 41 pass, 0 fail, 489 expect() calls, exit 0. `test/graphql-starter.test.ts` — 3 pass,
  exit 0, including "is src/graphql/starter.graphql, byte for byte".
- Single-file timings: `bun run test --only test/logs-graphql.test.ts
  --timings=.github/workflows/single-file-timings.json --update-timings` — 4 pass, exit 0, 25.58 s recorded as
  `25580 ms`, which `check:slow-tests` then accepts with no finding (exit 0).
- Wiki app: `bun install --frozen-lockfile` exit 0; `bun run check` exit 0 (`tsc --noEmit` and the UI architecture
  check, 0 violations); `bun test src/components/logs.test.tsx` — 5 pass, 0 fail, exit 0, the page's operation carrying
  the same two types as the schema.
- Full suite: not run for this correction. The card holds GitHub CI as the merge check and names the affected checks
  for the box; the files this change touches are the ones above.
- Walk: not taken here. The packaged walk of a fresh product — `madarch init`, `madarch serve`, a browser — is the
  shared post-merge acceptance of ALX-1936, and it now also covers the date window, the older page and the live tail.
- Mutation: not run, per the stage rule (Stryker runs off the path once per assembled stage), and the card forbids one
  here.
- Review: this correction follows the ALX-2008 verdict (`CHANGES f66b8d72912a671cdefcd22e101b4ec1b61cd4f4`); the lead
  checks the correction diff.
