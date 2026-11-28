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

**Follow-up, 2026-11-28: the engine's own location in what the reader is shown.** The packaged walk of ALX-2047 on `c94b578ec79346dc003512ab9c1d8c852988a0f9` followed Runs → run → Logs with no HTTP,
GraphQL or console failure, and found the shipped binary's own path in three texts a reader sees. The run's journal
cause and the extract-failed row read `src/plugin/agent.ts:1: /$bunfs/root/madarch-linux-x64: the agent answer is no
JSON`; the fill-failed row's detail opened with `Error: /$bunfs/root/madarch-linux-x64:87: RUN_NOT_WRITABLE run
cancelling unit cancelled` and named every frame at the bundle's byte offsets; a context field held only
`/$bunfs/root/madarch-linux-x64:152346:42`. The reproduction and the exact fields are
`/work/alx2047/lead-followup/raw-path-finding.json` in box `alx1936-accept` (ALX-2047 at `bec7e39f9`).

Three faults, one correction:

1. **The agent bridge named the file it was bundled into, not itself.** `src/plugin/agent.ts:29` built its `WHERE` from
   `import.meta.url`, which is `/$bunfs/root/madarch-linux-x64` in a compiled binary and the checkout's absolute path otherwise;
   every failure it raised carried that after its own `src/plugin/agent.ts:1:`, so the journal cause and the
   extract-failed row carried it too.
2. **The operation host did the same.** `src/graph/operation-host.ts:17` built its `WHERE` from `new URL(import.meta.url).pathname`, the head of the fill-failed row's detail.
3. **The Logs read showed the record as the engine wrote it.** `src/knowledge/logs.ts` passed a record's message, its
   stack and its context fields through untouched, so the bundle's path and its frames reached the page even where the
   engine's sentence was correct.

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

### The follow-up correction

**The two injections.** Each module now names itself by its source path — `src/plugin/agent.ts:1` and
`src/graph/operation-host.ts` — as `src/plugin/host.ts`, `src/plugin/sandbox.ts` and `src/adapters/postgres-install.ts`
already do. The source path and line are what a failure owes a reader; the file the engine was bundled into is a
deployment detail, and in a compiled binary its line is not a line of any module.

**The read.** `stripEngineLocations()` in `src/server/engine-location.ts` reads a record the engine wrote for a person:
it takes out every engine location wherever it stands (the head of a message, the field after it, a context value) and
drops a stack frame that stands only at the engine's bundle — a bundle frame carries no source map, so its line and
column name an offset in the shipped binary that no reader can open. A frame at the checkout's own source keeps its
line and column and loses only the folder this machine keeps the checkout in, and a product's or a plugin's location
stands as written. It is the module's existing normalization (`stripEngineLocation()`, madarch-64o5.203), read over a
whole text instead of its head, and it reuses that function for the head so the two cannot disagree. `src/knowledge/
logs.ts` applies it to the message, the stack detail and the context fields of records the engine wrote — engine, fill,
agent failure, trace status — and not to text it did not write: a plugin's standard error and the store's own
PostgreSQL log stand as they were written and stay marked quoted. A context field left holding nothing but an engine
location is left out rather than shown empty. The file on disk is never rewritten: the bundle's path stays in the
record as the evidence a developer reads with the store.

## Changes to requirements

None. The change realizes the Logs page's own proposed requirement (`product-wiki/logs`, proposed by change
madarch-64o5.88): one page of every log madarch keeps, read through the product's one read API, with its filters and
paging and an empty state. No requirement text moves.

## Preserved contracts

- product-wiki/serve: a served product still answers its wiki's reads through `POST /graphql` by the api role, one operation in its own read-only snapshot answered by the read worker; the page and the route that was already answered are unchanged (static)
- product-wiki/logs: the page's entries, filters, paging and order stand, and so do its window's own meaning (`from` and `before` are epoch milliseconds, both exclusive, oldest first, one page of at most `MAX_PAGE` kept from the newest end) and the text madarch did not write, which is shown exactly as it was; an engine record's message, stack, context and trace attributes, and a saved run's journal, are shown without an engine location and with every product or plugin coordinate kept (test)

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

### The follow-up correction

Box `alx1936-accept` (4 vCPU, 8 GiB), a worker checkout of `origin/main` `d08cfb936210952af89eae50098718afef9bdfb4` at
`/work/correction`, run as the box user. The correction is PR #404, one commit on that base; every line below covers
that commit, so a later revision's results replace none of them. Errors as the run printed them, with the file, the line
and the full path.

- **The correction fails on the pre-fix source, on the same tests.** With `git stash push -- src` (the three source
  files at `d08cfb936`), `MADARCH_SKIP_PERF=1 bun test test/logs.test.ts test/plugin-agent-bridge.test.ts` — exit 1,
  20 pass, 2 fail:
  - `/work/correction/test/plugin-agent-bridge.test.ts:98`: expected `src/plugin/agent.ts:1: the agent answer is no
    JSON`, received `src/plugin/agent.ts:1: /work/correction/src/plugin/agent.ts: the agent answer is no JSON`.
  - `/work/correction/test/logs.test.ts:149`: expected `unit not extracted: src/plugin/host.ts:1: agent.run failed:
    src/plugin/agent.ts:1: the agent answer is no JSON`, received the same with
    `/$bunfs/root/madarch-linux-x64: ` between `src/plugin/agent.ts:1: ` and the words.
  - With the same stash, `MADARCH_SKIP_PERF=1 bun test test/immediate-operation.test.ts` — exit 1, 3 pass, 1 fail at
    `/work/correction/test/immediate-operation.test.ts:56`: expected `/^src\/graph\/operation-host\.ts:87:
    RUN_NOT_WRITABLE run paused unit running$/u`, received `/work/correction/src/graph/operation-host.ts:87:
    RUN_NOT_WRITABLE run paused unit running`.
- **The correction passes.** `MADARCH_SKIP_PERF=1 bun test test/logs.test.ts test/logs-graphql.test.ts
  test/plugin-agent-bridge.test.ts test/immediate-operation.test.ts test/wiki-refusal-boundary.test.ts
  test/entity-cli.test.ts` — exit 0, 37 pass, 0 fail, 386 expect() calls, 15.39 s, the two Logs files among them so the
  page's own route still reads its entries.
- **Static:** `bun run check` — exit 0. `tsc --noEmit` clean; `check:architecture` 499 violations, all 499 listed;
  `check:ui` 0; `check:catalog` no finding; `check:workflows` 4; `check:slow-tests` 66 excluded files, no finding;
  `check:quarantine`; `check:tests` 0 violations.
- **Full suite and mutation:** not run, per the card — GitHub CI is the merge check and the card forbids a mutation run.
- **Walk:** the packaged navigation rerun on the merged correction belongs to ALX-2047; the acceptance target is the
  merged correction on a packaged binary.
- **Author:** `shady2k-gateway/deepseek-v4.1-flash-auto` (Pi). No paid model call was made: the agent answer of the
  regression is the deterministic fixture's own text.

### The correction of 2026-11-28 (ALX-2065)

The review of PR #404 at `c9a0f76bd50b34968d13dd97e8202f6eb3e7066c` found that the follow-up above hid the engine's
location where it was generated and left it everywhere the reader actually looks. Five findings, corrected together on
top of that commit, which stands unchanged.

1. **A saved run's journal still showed the bundle.** The bridge fix changed what a new failure says; the run page draws
   the journal from the events the run stored, and `src/knowledge/fill-runs.ts` returned each stored `summary` as it
   was written. `readFillRunDetail()` — the one read behind the run page and `Query.fillRuns` — now shows an event the
   way the Logs page shows one, and the store keeps the event as the engine wrote it.
2. **An engine location swallowed the diagnostic after it.** `engineFieldEnd()` ended a location at the next `: `
   anywhere on the line, so `unit not extracted: failed at /$bunfs/root/madarch-linux-x64:82276:26 while loading
   /workspace/product/plugin.ts:12:3: permission denied` came out as `unit not extracted: failed at permission denied`.
   A location is now one token: a bundle mount runs to its first separator and carries at most its own `:line(:column)`,
   and the text after the token stands as written.
3. **A product inside the engine checkout lost its coordinates.** The Logs read called the sanitizer without the product
   it belongs to, so a location under the checkout's own `src/` or `scripts/` was classified as the engine's. The read
   carries the product's folder (`KnowledgeProduct.logs()`, the read worker's descriptor) and a location under it stands
   as written — message, stack frame and context alike.
4. **Expanded details and context still leaked.** `frameOf()` tested for a final `)` after splitting on `\n`, so a line a
   Windows writer ended in `)\r\n` fell through to the last-word branch, which kept the opening `(`; an object-valued
   context was stringified before it was shown, so a nested value holding only the bundle survived; and the trace
   attributes the orchestrator writes — `madarch.reason`, the unit's failure summary — bypassed the display entirely.
   A frame is read on the line without its `\r`, and its last word loses the parenthesis that opens it; a context value
   is shown string by string, through objects and arrays, and a key or item left holding nothing is left out; trace
   attributes and a span's own status message are shown like the message they carry.
5. **The live tail spent its interval on rows it does not show.** Every read prepared each record for the page —
   sanitizing its message, stack and context — and only then applied the time cursor. Measured in `alx1936-accept` on
   three 1.95 MB fill logs of 5,900 rows each, four reads with a `from` after the newest row (so no row is shown) took
   116–154 ms at the base `898838c8`, 1,118–1,331 ms at `c9a0f76b`, and 21–48 ms on `0e6835b62`. A record outside the
   read's time window is refused before its display fields are built, and one read works out its engine root and
   product once. The follow-up below restores the order in which the file quota and the time window are applied.

**Preserved.** The message, stack and context of a record the engine wrote lose only an engine location: the failure's
words, a product's or a plugin's paths and coordinates, and every frame a reader can open stay. Text the engine did not
write — a plugin's standard error, the store's PostgreSQL log — stands exactly as written and stays marked `quoted`.
A trace's own attributes keep every value except an engine location, and `madarch.reason` keeps the failure's words.
The file on disk is never rewritten.

### Acceptance evidence for the correction (ALX-2065)

Box `alx1936-accept` (4 vCPU, 8 GiB), checkout `/work/correction` at `d08cfb936` with this correction's diff, run as the
box user. Errors are printed as the run printed them, with the file, the line and the full path.

- **The new regressions fail on the reviewed head `c9a0f76b`.** With the reviewed sources restored (`git checkout -- src`
  then `git apply --include=src/** /work/delivered-final.patch`) and the new test files in place,
  `MADARCH_SKIP_PERF=1 bun test test/logs.test.ts test/fill-runs.test.ts --timeout=60000` — exit 1, 2 fail:
  - `/work/correction/test/fill-runs.test.ts:438`: expected to contain
    `the run failed: src/plugin/agent.ts:1: the agent answer is no JSON`, received
    `the run failed: src/plugin/agent.ts:1: /$bunfs/root/madarch-linux-x64: the agent answer is no JSON`.
  - `/work/correction/test/logs.test.ts:195`: expected `unit not extracted: failed at while loading
    …/engine-checkout/src/demo-product/plugin.ts:12:3: permission denied`, received
    `unit not extracted: failed at permission denied`.
- **The same files pass on this correction.** `MADARCH_SKIP_PERF=1 bun test test/logs.test.ts test/logs-graphql.test.ts
  test/fill-runs.test.ts test/plugin-agent-bridge.test.ts test/immediate-operation.test.ts test/entity-cli.test.ts
  test/wiki-refusal-boundary.test.ts --timeout=60000` — exit 0 (the focused files, 60 s bound; the first plain run
  without the flag stopped `test/fill-runs.test.ts`'s 6.2 s case at Bun's 5 s, the box's own hang guard being the
  runner's flag).
- **The wiki's own rendering.** `cd wiki/app && bun install --frozen-lockfile` (exit 0, 330 packages) then
  `bun run check` — `tsc --noEmit` clean and `UI architecture: 0 violations`; `bun test src/components/command-pages.test.tsx`
  — 43 pass, 0 fail, the new case among them: the saved run's journal draws `the agent answer is no JSON` and neither
  `bunfs` nor `madarch-linux-x64`.
- **Static:** `bun run check` — exit 0. `tsc --noEmit` clean; `architecture: 497 violations`, all 497 listed;
  `check:ui` 0; `check:catalog` 120 kinds, no finding; `check:workflows`; `check:slow-tests` 66 listed, 511 measured
  files, no finding; `check:quarantine`; `check:tests` 0 violations.
- **The live tail, measured off the committed tests** (`bun .perf-logs.ts`: three fill logs, 5,900 rows each, 5,710,710
  bytes in all — 1.90 MB each — four reads with an exclusive `from` after the newest row, zero entries shown):

  | Revision | Read 1 | Read 2 | Read 3 | Read 4 |
  | --- | --- | --- | --- | --- |
  | base `898838c8` (pre-fix) | 154 ms | 127 ms | 116 ms | 123 ms |
  | reviewed `c9a0f76b` | 1,331 ms | 1,209 ms | 1,118 ms | 1,206 ms |
  | previous candidate `0e6835b62` | 48 ms | 37 ms | 23 ms | 21 ms |

  The reviewer's own numbers on its input were 143–167 ms at the base and 1,042–1,097 ms at `c9a0f76b`; the shape is the
  same and the empty refresh is back inside the page's 1,000 ms interval.
- **Not run:** the full suite, a mutation run and the packaged browser walk — GitHub CI is the merge check, and the new
  packaged navigation rerun belongs to ALX-2047 after merge. Author: `shady2k-gateway/deepseek-v4.1-flash-auto` (Pi), no
  paid model call.

### The file quota and displayed path (ALX-2007)

The lead's cursor probe found that the previous candidate applied the time window before the file quota. With two
sources selected, an older fill record followed by 10,000 newer ones reappeared in a `before` page. The Logs reader
now selects the last valid records in the byte tail for fill, server and trace files, then checks both exclusive time
bounds before building the display fields. The tests exercise each source with malformed lines, records at the cursor,
out-of-order timestamps, stable line IDs and the page counters.

An engine record's top-level `path` is passed through the same display normalization as its context. A value holding
only the embedded engine location is omitted. Expanded details still carry a product or plugin path and its coordinates,
including when the product sits under the engine checkout's `src` directory. The correction verifies both outcomes
through the Logs reader. The box report `/work/reports/madarch-64o5.200-cursor.md` holds the revision-specific commands,
results and live refresh measurements.
