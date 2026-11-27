# The fast file returns to the shards and the slow list records runner timings

Change: madarch-64o5.176-final
Base: 9b0b16da3
Tasks: madarch-64o5.176
Kind: no-behavior

## Intent
Close the speed-up stream's slow-test tail. The file the stream brought under the bound returns to the
blocking shards, the files that stay above it keep one named required job each with the runner
evidence that explains why, and the api role's first-page test stops paying for a fill whose facts it
never reads.

## Out of scope
- The assertion model of decision 0039, the single graph writer, the deferred graph check and the
  database schema: none of them changes here.
- The 30 s threshold and the required-check aggregate; the only case count that moves is
  `source-follows-fill`'s, from 2 to 3, to match the three cases the file holds.
- A reduction of any fixture whose volume is the case's own subject.

## Rationale
Three independent runner samples of the F4 tree measure all twelve files of the study — the ten
listed here, `test/catalogue-kind-relations.test.ts` and `test/plugin-fill-scenarios.test.ts`, which
is already a shard file. One of them, `test/catalogue-kind-relations.test.ts`, is at or below the
bound in all three, so the slow list cannot keep it: a listed entry must carry more than 30 s, and
the shard suite is where a file that fits belongs. Ten stay listed, each with one named required
job: eight are above the bound in every sample (31.62–108.39 s), and `test/agent-fill-e2e.test.ts`
(median 35.76 s) and `test/api-role-first-page.test.ts` (median 38.09 s) are above it at the median
but not in every sample, so neither returns yet. The reason is not a fixture that could be smaller:
one fill pass of an already trimmed fixture costs 18.6–19.5 s on a runner, so a file that
needs two or three passes cannot reach the bound whatever its data. Their entries therefore stop
explaining themselves with the pre-stream box trace and record the three-sample median instead, in
the slow list and in the committed single-file evidence together, because the slow-list check
compares the two.

The one safe reduction left is `test/api-role-first-page.test.ts`: its setup filled the product only
to publish its manifest and to have a store to read, and its case asserts `/api/status` and reads no
filled fact. The setup now prepares the store and publishes the fixture manifest through the helpers
the other api tests already use, and records one finished run so the page still reports `filled` and
`manifest: ok`; the run the case asserts stays the newest and in state `created`.

## Changes to requirements
None. No product requirement, contract or capability text changes; this is the project's own test
inventory and the evidence behind it.

## Preserved contracts
- product-wiki/serve: a product served by the api role still answers its pages and its status at the address it printed, and the store the role reads is the product's own.
- fill-orchestrator/host: the api role still owns the process and its one database owner, and the status answer still reports the store's run and its trace.

## Coverage
- product-wiki/serve: static, test
- fill-orchestrator/host: test

## Where it is seen

Kind: internal
Place: `test/slow-files.json`, `.github/workflows/single-file-timings.json`, `.github/workflows/ci.yml`, `test/api-role-first-page.test.ts`
Reason: the project's slow-test inventory and one test's setup, with no visible product behavior.

1. Read `test/slow-files.json`: ten entries of the stream; `test/catalogue-kind-relations.test.ts`
   is not among them, and each remaining entry records the median of its three runner samples.
2. Read the `slow-files` matrix of `.github/workflows/ci.yml`: ten lines, nine `cases` values
   unchanged and `source-follows-fill` raised from 2 to 3, and a comment naming the ten files and the
   three sample runs their medians come from.
3. Run `bun run check:slow-tests`: no finding; every listed entry is over 30 s and agrees with its
   committed evidence within 100 ms.
4. Run `bun run test --slow --only test/api-role-first-page.test.ts`: one case passes with both
   latency bounds active, and the store holds the published fixture manifest and a finished run.

## Blocking questions
None.

## Design and decisions
- **The median of three samples is the recorded number.** One runner sample varies by up to 40 % on
  one tree (`owner-fill-path` 66.10 s against 108.39 s), so a single number cannot be called the
  file's time; the median of three independent samples of the same tree is defensible, and the entry
  names all three with their runs so a reader can check it.
- **No reclassification without runner evidence.** The catalogue file returns because all three
  samples are at or below 30 s. `api-role-first-page` (29.35–42.70 s over three samples) and
  `agent-fill-e2e` (24.18–36.96 s) each have one sample inside the bound and two outside, so neither
  returns from this change: the return needs a complete green runner measurement at or below 30 s,
  a fresh confirmation and verified required-shard coverage, and the follow-ups are written in
  `measurement.md`.
- **The setup change is not a weakened assertion.** The case reads the status page, not a filled
  fact: the manifest is published by the same helper the product uses, and the finished run stands
  in the store exactly as a fill's own record does, so `filled` and `manifest: ok` still come from
  the store's record rather than from the fixture's opinion.

## Acceptance evidence
- `bun run check` on a 4 vCPU / 8 GiB box on agent-linux-02, on the delivered tree, with
  `MADARCH_SKIP_PERF=1`: exit 0
  (`tsc --noEmit`, `check:architecture` 499/499, `check:ui` 0, `check:catalog`,
  `check:workflows` 4, `check:slow-tests` "64 listed, 503 measured files, no finding",
  `check:quarantine`, `check:tests` 0 violations).
- `bun run test --slow --only test/api-role-first-page.test.ts` on the same box, twice, with
  `MADARCH_SKIP_PERF` unset: 1 pass, 0 fail, 9 `expect()` calls, 37.15 s and 36.26 s, the case
  3.00 s and 2.77 s.
- The same file's setup as it stood at `9b0b16da3` (a full in-process fill) on the same box: it
  stops at the 120 s setup bound, 130.34 s, 0 pass, 1 fail.
- `measurement.md` in this change carries the three-sample table, the per-file reasoning, the
  catalogue publication pair and the follow-ups owed to the runners.
