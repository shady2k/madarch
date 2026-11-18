# Test layers

Status: target state of decision 0041. The layer of a test is the folder it lives in, and
`check:tests` holds what each layer may reach. The layout of the folders arrives with the
move of the existing files (T6b); until then a file stays in the root of `test/`, and its
layer is the folder it will move to.

## The layers

| Layer | Folder | A test of it may reach | It must not reach |
|---|---|---|---|
| Unit test | `test/unit/` | memory and temporary folders | a database client, `pg-boss`, `node:child_process`, `node:net`, `puppeteer`, `Bun.spawn`, `Bun.serve`, `test/support/test-database.ts`, `test/support/run-postgres.ts` |
| Integration test | `test/integration/` | one process; a database on the test pass's server; a git fixture through `test/support/git.ts`; an in-process HTTP server; the in-process plugin session | its own store folder, another process, the real plugin sandbox, a browser |
| End-to-end test | `test/e2e/` | everything a reader has: the binary or the CLI as a process, the `api` and `fill` roles, a store folder another process reopens, the real plugin sandbox, a browser | — |
| Measurement suite | `test/measure/` | a process and a store, as the requirement under measurement needs | — |

Helpers are not a layer: they live in `test/support/`. `MADARCH_SKIP_PERF` goes away with
the move; measurements live in their own folder and run in their own CI job.

A file belongs to a layer only when that layer's rule already passes on it. The rules are
those of `check:tests`, over the import graph and the syntax tree, without regular
expressions:
1. a unit file's value imports reach none of the modules listed in the table, and nothing
   in its import closure calls `Bun.spawn*` or `Bun.serve`;
2. an integration file starts no process except git through `test/support/git.ts`, opens no
   store of its own (`store` passed to `createTestDatabaseOwner`), and reaches no
   `puppeteer`;
3. a case bound comes from `bound()` only;
4. elapsed time is read only in `test/measure/` and `test/support/measure.ts`;
5. the full `everything` catalogue and `createDraft` from `src/product/draft.ts` are used
   only in `test/*/starter-set/`; every other file takes `testDraft({ kinds })` from
   `test/support/draft.ts`;
6. after the move, no `*.test.ts` lands in the root of `test/`;
7. the sum of a layer's shard timings stays within `test/budget.json`.

Rules 1–5 apply to the layer folders only, so a file is moved into a folder only when the
folder's rule is green on it; the move creates no entry in `.architecture/violations.json`.

What a layer is for: most behaviour is checked in the cheapest layer that can catch its
defect. Manifest parsing, kinds, catalogue checks, fill states (`fill/fsm.ts`), retry
policy, the plugin's output plan, its closure and rights, uid and digest order, page
rendering and GraphQL resolvers over `FakeGraph` belong to unit. The graph's write path,
key checks, assertions with file, commit and lines, merges, disputes, fences, transactions
and the queue belong to integration, as does the fill orchestrator on a small contract.
Role life, crash and stop, sandbox confinement, and the wiki walk belong to end-to-end.

## Boundaries

The graph writer and the key checks are never faked. Their meaning is in SQL, and a second
implementation in TypeScript would drift from the first. They run in integration, on a
small contract the case declares (one to three kinds) or on the published catalogue held as
a database template.

Only ports with a shared conformance suite are faked: `GraphReader` (`test/fake-graph.ts`)
and `PluginSession`. The same cases run against the fake in unit and against the real
implementation in integration (PostgreSQL) or end-to-end (the sandbox), so a fake that
drifts from the real one fails its own conformance suite. Fakes live in `test/support`
only.

## Case bounds

A case that needs more than the default names its bound with
`bound(ms, { measured, on, at })` from `test/support/deadline.ts`:

- `ms` is at least three times the measured time and at least 10 000 ms;
- integration names at most 30 000 ms, end-to-end at most 120 000 ms;
- a unit case names none: it runs in milliseconds;
- a bare number as the third argument of `test()` is a violation.

Elapsed time is asserted only in the measurement suite, against `test/measure/baselines.json`,
in the CI job that blocks `main`. A `Date.now()` comparison in a functional case is a clock
reading on review, not a measurement.

## Check map

A test rewrite carries a check map in its PR description: one row per old case, the
behaviour it checked, and the new cases and their layer.

| Old case | Behaviour it checked | New cases | Layer |
|---|---|---|---|
| `test/old.test.ts: a draft catalogues its kinds` | a draft writes its kind declarations | `test/unit/draft.test.ts: a draft catalogues its kinds` | unit |
| `test/old.test.ts: a lost key is refused` | the writer refuses a duplicate natural key | `test/integration/graph-write.test.ts: a lost key is refused` | integration |

A rewrite is proved by the coverage comparison and the check map together, both before
review. The map is checked for completeness by the reviewer; the comparison is the
blocking proof, and the commands are below.

## Coverage comparison

Run the old files and then the new files, each with lcov output:

```
bun test <old files> --coverage --coverage-reporter=lcov
bun test <new files> --coverage --coverage-reporter=lcov
bun scripts/test-coverage-diff.ts <old.lcov> <new.lcov> [--allow <map.json>]
```

The first run writes `coverage/lcov.info`; keep a copy under the name given to the command
and repeat for the new files. The command compares product files only (records under
`src/`), prints every lost product line as its full path and line number, and ends with a
summary line.

Exit codes:

- `0`: every product line covered before is covered now, or named in the allow map.
- `1`: a product line lost coverage and the map does not name it. The message is
  `<full path>:<line>: covered before, uncovered now (no reason in the map)`.
- `2`: bad input — a missing or unreadable file, a malformed lcov record, a map entry
  without a reason, or bad arguments. The message says which record, with the input file
  and its line number.

The allow map is JSON and names the line with a reason:

```json
{ "allow": [{ "file": "src/x.ts", "line": 42, "reason": "the check moved to the unit case of the parser" }] }
```

A path may be relative to the checkout or absolute. The map is for a line whose coverage
moved to a layer the run did not measure, or for a line that is now dead code; dead code
goes to `to-backlog` rather than staying in the map.
