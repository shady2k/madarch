# One more slow test returns to the blocking shards, and the catalogue reduction gets its matched pair

Change: madarch-64o5.176-final-returns
Base: 195862fb2
Tasks: madarch-64o5.176
Kind: no-behavior

## Intent
Close the twelve-file tail of the speed-up stream. Two further required runs of `main` after the
stream's last merge measure `test/catalogue-kind-relations.test.ts` at or below the 30 s bound alone,
and five required runs of the returning pull request confirm it in a shard — the last at the reviewed
head, 24 820 ms — so its entry and its matrix row go and it runs in the shards.
`test/agent-fill-e2e.test.ts` has the same two alone samples inside the bound but its required shard
sample is 35 185 ms, so its entry, its matrix row and its committed evidence stay; it ran in its own
required job in the four runs after that attempt, both cases each time, and the runner evidence is
recorded in them. The other eight files of the study keep their named required jobs, each with the
assertion that needs its end-to-end workload. The same record carries the matched pair the stream
owed for publishing a catalogue after removing exactly 95 kinds — one pinned starter tree on both
revisions — which the measurement record before this one named as missing.

## Out of scope
- The assertion model of decision 0039, the single graph writer, the deferred graph check, the
  database schema and `.architecture/violations.json`: none of them changes here.
- The 30 s threshold, `SLOW_EXIT_SECONDS` and the required-check aggregate. No case is quarantined
  here: `test/status-work.test.ts` keeps its third case's existing case-level quarantine
  (madarch-stm0.13) and its two active cases in its own job.
- Any fixture reduction of the nine staying files: their measurement record (PR #380) shows their
  volume is the subject, and this change does not weaken a case.
- The other tasks' slow entries (`fill-trace`, `fill-run-recovery`, `architecture-repository`), their
  numbers and the nightly summaries.

## Rationale
The exit sentence of every slow-list entry asks for "a green complete-file runner measurement … at
or below 30 seconds, confirmed on a fresh run, with verified required-shard coverage".

`test/catalogue-kind-relations.test.ts` has all three: 28.01 s and 27.63 s alone in two required runs
of `main` after the stream's last merge, and **27 119 ms, 26 506 ms, 24 486 ms, 28 437 ms and
24 820 ms in shard 1** of the returning pull request's five required runs, where it is named exactly
once in one shard artifact of each run. Its one case and its 244 `expect()` calls are unchanged.

`test/agent-fill-e2e.test.ts` has the first two (26.76 s and 27.38 s alone) and fails the third: the
first attempt measured it **35 185 ms in shard 1**, 5 185 ms over the bound. Its entry therefore came
back with the two alone samples and that shard sample recorded in it, and it ran in its own required
job in the four runs after the attempt — 26.75 s, 39.19 s, 34.05 s and 38.47 s, both cases each time.
The list cannot carry it on the alone samples: `scripts/check-slow-tests.ts` refuses a listed entry
at or below 30 s and refuses one whose seconds disagree with the committed single-file evidence by
more than 100 ms, so a file at 26.76–27.38 s alone has no honest entry, and its shard cost is what
keeps its named required job. Keeping it as a separate required check is the decision recorded on
28 November in ALX-2061, under the owner's combined variant of 27 November.

| File | `main` 46099717218 (`f2c55b343`) | `main` 46102135712 (`c94b578ec`) | Five required runs of the pull request |
| --- | ---: | ---: | --- |
| `test/catalogue-kind-relations.test.ts` | 28.01 s (1 pass, 244 `expect()`) | 27.63 s (1 pass, 244 `expect()`) | **27 119 / 26 506 / 24 486 / 28 437 / 24 820 ms in shard 1 — returns** |
| `test/agent-fill-e2e.test.ts` | 26.76 s (2 pass) | 27.38 s (2 pass) | **35 185 ms in shard 1 of 46105327705; then 26.75 / 39.19 / 34.05 / 38.47 s in its own job — retained** |

The nine staying files keep their named required jobs, and the reason is not a fixture that could be
smaller: one real fill pass of an already trimmed fixture costs 18.6–19.5 s on a runner, so a file
that needs two or three of them sits at or above the bound. `test/agent-fill-e2e.test.ts` is the one
two-pass file that once fitted (24.18 s, with both cases, in run 46044618928), which is why its
retention rests on its median 35.76 s and its shard sample, not on an arithmetic impossibility.
Measurement.md names, for each of the eight, the assertion that needs the end-to-end workload and why
the fixture volume is the subject rather than incidental data.

## Changes to requirements
None. No product requirement, contract or capability text changes; this is the project's own test
inventory, its evidence and one measurement record.

## Preserved contracts
- product-wiki/serve: a product served by the api role still answers its pages and its status at the address it printed, and the store the role reads is the product's own.
- fill-orchestrator/host: the api role still owns the process and its one database owner, and the status answer still reports the store's run and its trace.

## Coverage
- product-wiki/serve: test
- fill-orchestrator/host: test

## Where it is seen

Kind: internal
Place: `test/slow-files.json`, `.github/workflows/ci.yml`, `.github/workflows/single-file-timings.json`, `.github/workflows/test-timings.json`
Reason: the project's slow-test inventory and the evidence behind it, with no visible product behavior.

1. Read `test/slow-files.json`: `test/catalogue-kind-relations.test.ts` is no longer listed, and
   `test/agent-fill-e2e.test.ts`'s entry records its two alone samples and its 35 185 ms shard sample;
   the eight staying stream entries and the other tasks' entries keep their medians and their exits.
2. Read the `slow-files` matrix of `.github/workflows/ci.yml`: twelve lines, the catalogue row gone
   and `test/agent-fill-e2e.test.ts` back at `cases: 2`, with the comment naming the runs.
3. Run `bun run check:slow-tests`: no finding; no measured file is over 30 s outside the list and no
   listed entry disagrees with its committed evidence.
4. Run the suite: `test/catalogue-kind-relations.test.ts` is named once in a shard artifact and runs
   there, where the list's exclusion used to leave it out; `test/agent-fill-e2e.test.ts` runs in its
   own required job.

## Blocking questions
None.

## Design and decisions
- **A return is confirmed in the shards, not by the alone samples.** The list's own growth rule
  refuses a speed claim from one sample, and `SLOW_EXIT_SECONDS` exists because a runner varies on
  one tree. Both files had two consecutive required runs of `main` below the bound alone; the
  deciding sample is the one where the file would run — the shards — and it moves the catalogue file
  back, while the agent fill file's shard sample kept it where it was.
- **The catalogue file's committed evidence is its latest alone sample.** Its entry leaves the
  list, so nothing compares it; `.github/workflows/single-file-timings.json` records 27 630 ms for it
  — the `c94b578ec` required-run sample — and its shard weight in
  `.github/workflows/test-timings.json` is the same 27 630 ms, so Bun's own `--shard` selection
  balances the file it now carries. The five shard samples, 24 486–28 437 ms, sit around it.
- **`agent-fill-e2e` keeps the median it had.** Its entry's seconds stay 35.76 s, the median of three
  F4 samples, which its committed evidence records; the two newer alone samples and the shard sample
  are recorded in the entry's own words. The check compares the entry with the committed evidence,
  not with the newest run.
- **The catalogue measurement is a measurement, not a change.** It changes no code, and the record
  states the pinned input's hashes, the recipe, the retained sets and the bracket so a reader can
  repeat it. The first version of the pair started from two different starter trees, which a review
  of this record found (ALX-2060); the pair in the record now publishes one pinned tree on both
  revisions, and the earlier pair is kept beside it with that difference named.

## Acceptance evidence

The runs cited below measured the tree this change delivers; the record's final commit edits these
documents only.

### The returned file and the retained one

Five required runs of this pull request carry the evidence, all `ubuntu-24.04` and all `success`:
[46105327705](https://github.com/shady2k/madarch/actions/runs/46105327705) (head `e4c22fc67`, shard
artifacts of 92 / 95 / 86 / 84 / 96 files — 453 — both files in the shards),
[46107475379](https://github.com/shady2k/madarch/actions/runs/46107475379) (head `d0046bd6d`),
[46108016522](https://github.com/shady2k/madarch/actions/runs/46108016522) (head `4438e6ee0`),
[46108461893](https://github.com/shady2k/madarch/actions/runs/46108461893) (head `9f486034c`) and
[46108978562](https://github.com/shady2k/madarch/actions/runs/46108978562) (head `eac39521e`, the
reviewed head); the last four hold 93 / 94 / 87 / 82 / 96 shard files (452). In the last four the
catalogue file is returned and `test/agent-fill-e2e.test.ts` runs in its own required job.
`test/catalogue-kind-relations.test.ts` is named exactly once in shard 1 of all five, 27 119 ms,
26 506 ms, 24 486 ms, 28 437 ms and 24 820 ms; `test/agent-fill-e2e.test.ts` is named once in shard 1
of the first, 35 185 ms, and is absent from the shards of the other four, where its own job measured
26.75 s, 39.19 s, 34.05 s and 38.47 s with both cases.

The five are one placement and its correction, not five repeats of the same thing. The first trial,
`e4c22fc67`, is the placement before the correction: both study files in the shards. The four runs
after it carry the delivered placement — the catalogue file back in the shards and
`test/agent-fill-e2e.test.ts` in its own named job — and are what verifies it. The correction commit
`d0046bd6d`, and the rebuilt heads after it, also changed explanatory text rather than placement alone:
the `slow-files` matrix comment in `.github/workflows/ci.yml` (twelve named jobs, the retained file's
shard sample and the catalogue file's return) and the `source` field of `test/slow-files.json`. Those
four runs therefore exercised the delivered metadata as well as the delivered placement.

The two required runs of `main` that measured the alone samples are
[46099717218](https://github.com/shady2k/madarch/actions/runs/46099717218) (`f2c55b343`) and
[46102135712](https://github.com/shady2k/madarch/actions/runs/46102135712) (`c94b578ec`); their
`slow file` jobs (140839164545, 140839164780, 140846719721, 140846719625) carry the numbers above.
The agent fill file's three earlier single-file samples — 24.18 s, 36.96 s and 35.76 s, whose median
is the entry's committed 35.76 s — are runs 46044618928, 46045922097 and 46046625374, each with both
of its cases.

### The nine staying files in the same two runs

Each stays listed and keeps one named required job; their numbers in the two runs are in
measurement.md ("The two required runs of `main`"), together with the assertion that needs each
file's end-to-end workload ("The eight staying files: what needs the workload").

### The catalogue reduction

See measurement.md ("Publishing a catalogue after removing about 95 kinds") for the pinned input's
hashes, the revisions, the recipe, the retained set, the counts and the times of both publications at
both sizes on both revisions, and for the complete baseline measurement that replaces the "never
finished" note: on the #353 merge the reduced publication of 95 kinds takes 411.8 s against 14.1 s on
current `main`, with matching graph counts at both publication sizes on both revisions.
