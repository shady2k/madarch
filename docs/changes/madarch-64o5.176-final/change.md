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
- The 30 s threshold and the required-check aggregate; the case counts that move are
  `source-follows-fill`'s, from 2 to 3, to match the three cases the file holds, and
  `status-work`'s, from 3 to 2, which `main`'s own quarantine of its third case (madarch-stm0.13)
  settles, not this change.
- A reduction of any fixture whose volume is the case's own subject.

## Rationale
Three independent runner samples of the F4 tree measure all twelve files of the study — the ten files
the slow list carried then, `test/catalogue-kind-relations.test.ts` and
`test/plugin-fill-scenarios.test.ts`, which was already a shard file. One of them,
`test/catalogue-kind-relations.test.ts`, is at or below the
bound in all three, so the slow list cannot keep it: a listed entry must carry more than 30 s, and
the shard suite is where a file that fits belongs. Nine stay listed, each with one named required
job: eight are above the bound in every sample (31.62–108.39 s), and `test/agent-fill-e2e.test.ts`
(median 35.76 s) is above it at the median but not in every sample, so it does not return yet. The
integration with `main` adds a tenth listed file and row from the status-work quarantine work,
`test/fill-trace.test.ts`, and settles `test/status-work.test.ts` at the two cases that remain after
its third case's quarantine; both are recorded under "Integration with main" below. The
first runner run then returned `test/api-role-first-page.test.ts` as well, on three alone samples of
one run (9.32 s, 6.877 s and 6.900 s). The reason the rest stay is not a fixture that could be
smaller:
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

1. Read `test/slow-files.json`: nine entries of the stream; `test/catalogue-kind-relations.test.ts`
   and `test/api-role-first-page.test.ts` are not among them, and each remaining entry records the
   median of its three runner samples. The list also carries `test/fill-trace.test.ts`, which `main`'s
   status-work quarantine work added, and `test/authored-http.test.ts` is no longer listed because
   `main` moved that coverage into the blocking suite.
2. Read the `slow-files` matrix of `.github/workflows/ci.yml`: ten lines, eight `cases` values
   unchanged, `source-follows-fill` raised from 2 to 3, `status-work` at its two active cases, and
   `fill-trace` at 2; a comment naming the ten files and the three sample runs the stream's medians
   come from, together with `fill-trace`'s own run, and the same comment saying that eight of the
   nine stream files were above the bound in every sample while `agent-fill-e2e` is above it at the
   median only.
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
  `measurement.md`. The catalogue file's own shard measurement is a separate question from those
  three standalone samples, and its first shard run measured 33 641 ms, so nothing here claims the
  file meets the 30 s bound in a shard.
- **The setup change is not a weakened assertion.** The case reads the status page, not a filled
  fact: the manifest is published by the same helper the product uses, and the finished run stands
  in the store exactly as a fill's own record does, so `filled` and `manifest: ok` still come from
  the store's record rather than from the fixture's opinion.

## Acceptance evidence

### The pull request's first runner run

The pull request's first required run ([46063935769](https://github.com/shady2k/madarch/actions/runs/46063935769),
`ab0a24d2e`) measured the delivered tree on `ubuntu-24.04`: all five shard jobs and all ten
slow-file jobs the matrix then carried passed, and the five shard artifacts hold 88 / 95 / 86 / 83 /
96 files in shard order (448 files). The run's conclusion is nevertheless **red**: the aggregate
`test` job
([140726623318](https://github.com/shady2k/madarch/actions/runs/46063935769/job/140726623318))
failed on two findings of its growth gate, both below, and only the first of them belongs to this
change. These measurements matter here.

- **`test/catalogue-kind-relations.test.ts` ran in shard 1 at 33 641 ms**
  (`test-files-1/shard-1.json`, job
  [140724610884](https://github.com/shady2k/madarch/actions/runs/46063935769/job/140724610884)),
  named exactly once across the five artifacts. That is above the 30 s bound the shard jobs are held
  to, on a first sample, while its three standalone samples of the F4 tree were 27.81–29.18 s. So
  this change records the weight as measured and does **not** claim the shard bound passed on that
  sample; the next required run of the reviewed head measured it at 25 315 ms in shard 1 (see
  "The reviewed head's required run"), and the three standalone samples stay as historical evidence.
- **`test/plugin-fill-scenarios.test.ts` measured 16 561 ms in shard 4** (`test-files-4/shard-4.json`):
  still a shard file, and its `MISSING_ENDPOINT` flakiness stays a separate investigation.
- **`test/source-follows-fill.test.ts` ran all three of its cases green in 62.73 s** (job
  [140724610973](https://github.com/shady2k/madarch/actions/runs/46063935769/job/140724610973),
  "Ran 3 tests across 1 file"), which is the complete-file confirmation of the `cases: 3` the matrix
  now names for it.
- **`test/api-role-first-page.test.ts` measured 9.32 s** in its own job (job
  [140724610904](https://github.com/shady2k/madarch/actions/runs/46063935769/job/140724610904), 1
  pass, 0 fail, both latency bounds active), and the run's own growth gate then measured the same
  reduced file alone twice more, at **6.877 s and 6.900 s** (`--growth`, attempts 1 and 2 of job
  [140726623318](https://github.com/shady2k/madarch/actions/runs/46063935769/job/140726623318)). Three
  green alone samples of one run, two of them at or below the 15 s `SLOW_EXIT_SECONDS` (6.877 s and
  6.900 s against 15 000 ms), cannot stay behind a slow-list entry: the growth gate's own rule reads
  a file that fast as "not slow" and refuses the entry. The entry, its matrix line and its named job
  are gone in this follow-up, the file returns to the shards, and
  `.github/workflows/single-file-timings.json` carries 9 320 ms.
- **`test/agent-fill-e2e.test.ts` measured 27.30 s** (job
  [140724610951](https://github.com/shady2k/madarch/actions/runs/46063935769/job/140724610951), 2
  pass, 0 fail) besides the 26.759 s of the same growth gate, both inside the bound but above half of
  it: its entry, its matrix line and its two agent fill scenarios stay until a fresh confirmation and
  verified required-shard coverage arrive.
- **Every other shard and slow-file job passed**, including `test/status-work.test.ts` at 95.10 s
  with 3 pass (job
  [140724611310](https://github.com/shady2k/madarch/actions/runs/46063935769/job/140724611310)),
  whose third case was 21.09 s. The growth gate's second finding is that same file alone: 2 pass,
  1 fail, its third case reaching its own 60 s timeout (job
  [140726623318](https://github.com/shady2k/madarch/actions/runs/46063935769/job/140726623318), case 3
  60 000.17 ms, case 2 at 27.914 s). That timeout is a separate production question owned elsewhere
  and is not part of this diff; `main` now answers it with the case-level quarantine of that case
  (madarch-stm0.13, `docs/quarantine.md`), so the merged tree runs the file's two active cases and
  the aggregate no longer fails on it.

### The reviewed head's required run

The reviewed head's own required run
([46069935373](https://github.com/shady2k/madarch/actions/runs/46069935373), `7aafaa899`) passed all
five shard jobs on `ubuntu-24.04` and named both returned files once each in shard 1
(`test-files-1/shard-1.json`):

- **`test/api-role-first-page.test.ts` at 4 795 ms** — the reduced setup, in the shards as required
  coverage, far below the bound; this is the shard confirmation the follow-up owes.
- **`test/catalogue-kind-relations.test.ts` at 25 315 ms** — inside the 30 s shard bound on a
  required run, where the first run's single sample was 33 641 ms. The weight in
  `.github/workflows/test-timings.json` stays 33 641 ms, the measured worst case of the two, so the
  five shards stay balanced against the file as it is, and both shard samples are recorded here.

The run's aggregate `test` job failed only on the third `status-work` case, which is the case `main`
now quarantines; nothing in that finding belongs to this change, and the integration below carries
the quarantine into this tree.

- `bun run check` on a 4 vCPU / 8 GiB box on agent-linux-02, on the delivered tree, with
  `MADARCH_SKIP_PERF=1`: exit 0
  (`tsc --noEmit`, `check:architecture` 499/499, `check:ui` 0, `check:catalog`,
  `check:workflows` 4, `check:slow-tests` "64 listed, 503 measured files, no finding",
  `check:quarantine`, `check:tests` 0 violations). The follow-up that returns the first page to the
  shards runs the inventory checks again on its own tree: `check:slow-tests` "63 listed, 504 measured
  files, no finding" and `check:workflows` 4 workflows, both exit 0, with `git diff --check` clean
  and `test/workflows-check.test.ts` 4 pass, 0 fail.
- `bun run test --slow --only test/api-role-first-page.test.ts` on the same box, twice, with
  `MADARCH_SKIP_PERF` unset: 1 pass, 0 fail, 9 `expect()` calls, 37.15 s and 36.26 s, the case
  3.00 s and 2.77 s.
- The same file's setup as it stood at `9b0b16da3` (a full in-process fill) on the same box: it
  stops at the 120 s setup bound, 130.34 s, 0 pass, 1 fail.
- `measurement.md` in this change carries the three-sample table, the per-file reasoning, the
  catalogue publication pair and the follow-ups owed to the runners.

## Integration with main

`main` at `6d176f981` (PR #386) was merged into the reviewed head `7aafaa899` with one ordinary merge
commit whose first parent is the reviewed head, so this pull request carries both histories. Two
files conflicted; both were resolved by keeping each side's intent, not by preferring one side:

- **`.github/workflows/ci.yml`.** The `slow-files` matrix keeps this change's nine stream rows
  (`status-work` at its two active cases, `source-follows-fill` at 3) and takes `main`'s tenth row,
  `fill-trace` at 2; the comment says ten files, and it names `fill-trace`'s own measurement.
- **`test/slow-files.json`.** The list keeps this change's nine stream entries with their three-sample
  medians, takes `main`'s `fill-trace` entry, and drops the `authored-http` entry, whose coverage
  `main` moved into the blocking suite. `status-work`'s entry records the quarantine of its third
  case beside the three-case measurements it already carried.

The two timing files merged without conflict and were checked against both parents: the single-file
evidence keeps every stream median this change records plus 9 320 ms for `api-role-first-page`, and
carries `main`'s `authored-http` 4 791 ms, `fill-trace` 33 686 ms and its other new files; the shard
weights keep the catalogue's 33 641 ms and take `main`'s `authored-http` 4 791 ms. Nothing of one
side is dropped by the automatic merge, and no test implementation, requirement or threshold moved.

On the merged tree, on a 4 vCPU / 8 GiB box on agent-linux-02: `git diff --check` clean,
`check:workflows` 4 workflows, `check:slow-tests` "63 listed, 506 measured files, no finding",
`check:quarantine` exit 0 and `check:tests` 0 violations, all exit 0. A replay of Bun's own `--shard`
selection with the committed shard weights over the 451 files the shards carry names
`test/api-role-first-page.test.ts` and `test/catalogue-kind-relations.test.ts` once each, both in
shard 1 (`measurement.md`, "Shard selection after the integration").
