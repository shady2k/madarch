# The twelve files of the study measured on the runners after F4

Change: madarch-64o5.176-final (measurement record; no behaviour)
Tasks: madarch-64o5.176
Kind: no-behavior

## What was measured, and on which revision

This record covers the twelve files of the study: one is already back in the blocking shards before
this change (`test/plugin-fill-scenarios.test.ts`), one returns to them in the follow-up commit that
carries the pull request's first run (`test/api-role-first-page.test.ts`), one has its return pending
confirmation (`test/agent-fill-e2e.test.ts`), eight are above the bound in every sample, and
`test/catalogue-kind-relations.test.ts` returned to the shards first and came back to its own named
required job when both of its required shard samples measured above the bound. The ten files the slow
list carried before this change each had one named required job in the `slow-files` matrix; eleven
rows carry one after the catalogue file's return, counting `main`'s own `test/fill-trace.test.ts`
(the status-work quarantine work).

The baseline is the approved F4 change as it landed: PR #375 merged into `main` as
`46be90c4a913f524262e88f531f047be6108b403`. The merge commit's tree is
`83e9ef8fbe3cd5977a9ab116268b5ef374be7efd`, identical to the approved PR head
`7b94991382851431c085df41937f25588fd6a8cb`, so the pull request's own run and the push run of the
merge commit measure the same tree — two independent samples of one revision. A third sample was
taken on the next `main`, `9b0b16da3` (PR #373, the bounded current-evidence read), to show that the
merge that followed F4 did not move the numbers.

| Sample | Revision | CI run | Tree |
| --- | --- | --- | --- |
| A | `7b9499138` (PR #375 head) | [46044618928](https://github.com/shady2k/madarch/actions/runs/46044618928) | `83e9ef8f` |
| B | `46be90c4a` (`main`, F4 merge) | [46045922097](https://github.com/shady2k/madarch/actions/runs/46045922097) | `83e9ef8f` |
| C | `9b0b16da3` (`main` after PR #373) | [46046625374](https://github.com/shady2k/madarch/actions/runs/46046625374) | `9b0b16da3` |

The earlier columns of the table below are the measurements the slow list itself cites: run
[45758277151](https://github.com/shady2k/madarch/actions/runs/45758277151) for the seven files PR #353
listed, run [45809866011](https://github.com/shady2k/madarch/actions/runs/45809866011) for
`agent-fill-e2e`, run [45910624124](https://github.com/shady2k/madarch/actions/runs/45910624124) for
`catalogue-kind-relations`, and run
[46028247464](https://github.com/shady2k/madarch/actions/runs/46028247464) (PR #372, F5-fill, before
F4) as the last stream measurement before the merge.

The elapsed time of a file is Bun's own complete-file duration, the `Ran N tests across 1 file. [X]`
line of the job that runs `bun run test --slow --only <path>` on `ubuntu-24.04`; that is the number
the repository compares with its 30 second bound. The job's wall time is not comparable: it adds
about 15–25 s of checkout, `bun install` and cgroup delegation before the file starts, and it moved
between the samples of one tree.

## The rule being applied

- `SLOW_THRESHOLD_SECONDS` is 30 s (`scripts/run-tests.ts`); a file over it that the list does not
  carry fails CI only when a shard measurement **and** an independent single-file measurement both
  exceed 30 s (`scripts/check-slow-tests.ts`, `slowFindings`).
- The exit sentence of every listed entry asks for "a green complete-file runner measurement … at or
  below 30 seconds, confirmed on a fresh run, with verified required-shard coverage".
- `SLOW_EXIT_SECONDS` is 15 s: a file at exit speed may double (`15 × 1.70 < 30`) and stay inside the
  bound. A file measured at 25–30 s has no such room, and these samples show ±40 % between two runs
  of one tree (`owner-fill-path` 66.10 s in B against 108.39 s in C), so the margin, not only the
  bound, decides whether a return to the shards is safe.
- A listed entry must carry more than 30 s and must agree with the committed single-file evidence
  within 100 ms. A file whose honest measurement is now at or below 30 s therefore cannot stay in the
  list: the entry is either removed or fails `bun run check:slow-tests`.

## Measurements

Both before-columns are runner measurements; the entry of each file quotes the same numbers in its
`defect` field.

| File | Before the stream | PR #372 (pre-F4) | A | B | C | Outcome (A/B/C) | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `test/catalogue-kind-relations.test.ts` | 31.43 | 27.88 | 29.18 | 27.86 | **27.81** | green/green/green | returned to the shards, then **back to its own required job** (33 641 and 34 019 ms in shard 1, 37 781 ms alone) |
| `test/api-role-first-page.test.ts` | 51.42 | 31.49 | 38.09 | 42.70 | 29.35 | green/green/green | not confirmed (1 of 3) |
| `test/agent-fill-e2e.test.ts` | 31.28 | 26.23 | 24.18 | 36.96 | 35.76 | green/green/green | not confirmed (1 of 3) |
| `test/plugin-agent-edge-order.test.ts` | 53.82 | 39.36 | 40.01 | 32.72 | 31.62 | green/green/green | stays |
| `test/imports-path.test.ts` | 56.94 | 45.19 | 33.64 | 43.69 | 34.51 | green/green/green | stays |
| `test/ordinary-plugin-partition.test.ts` | 57.56 | 47.26 | 45.08 | 58.21 | 57.30 | green/green/green | stays |
| `test/source-follows-fill.test.ts` | 90.65 | 51.78 | 52.77 | 51.40 | 49.89 | green/green/green | stays |
| `test/status-work.test.ts` | 125.50 | 74.59 | 69.62 | 69.38 | 69.74 | green/green/green | stays |
| `test/roles-two-and-two.test.ts` | 84.55 | 53.45 | 82.17 | 52.48 | 78.82 | green/green/green | stays |
| `test/owner-fill-path.test.ts` | 120.85 | 71.83 | 82.00 | 66.10 | 108.39 | green/green/green | stays |
| `test/db-schema-path.test.ts` | 129.45 | 107.55 | 84.13 | 81.08 | 82.53 | green/green/green | stays |
| `test/plugin-fill-scenarios.test.ts` | 66.06 alone | — | 19.53 | 25.10 | 18.04 | green/green/green | already a shard file; stays there |

## The pull request's first run

The delivered tree ran required on `ubuntu-24.04` in
[46063935769](https://github.com/shady2k/madarch/actions/runs/46063935769) (`ab0a24d2e`); all five
shard artifacts and every matrix job are accounted for below. A shard number is Bun's own per-file
entry in the artifact manifest of the shard that ran the file (`test-files-<n>/shard-<n>.json`); an
alone number is the `Ran N tests across 1 file. [X]` sentence of the job that ran
`bun run test --slow --only <path>`.

| Measure | Value | Job |
| --- | --- | --- |
| `test/catalogue-kind-relations.test.ts` in shard 1 | 33 641 ms | 140724610884 |
| `test/plugin-fill-scenarios.test.ts` in shard 4 | 16 561 ms | 140724610877 |
| `test/api-role-first-page.test.ts` alone | 9.32 s (1 pass, 0 fail) | 140724610904 |
| `test/agent-fill-e2e.test.ts` alone | 27.30 s (2 pass, 0 fail) | 140724610951 |
| `test/source-follows-fill.test.ts` alone | 62.73 s (3 pass, 0 fail) | 140724610973 |
| `test/status-work.test.ts` alone | 95.10 s (3 pass, 0 fail) | 140724611310 |
| `test/api-role-first-page.test.ts` alone, growth gate | 6.877 s and 6.900 s (2 attempts, exit 0) | 140726623318 |
| `test/agent-fill-e2e.test.ts` alone, growth gate | 26.759 s (exit 0) | 140726623318 |
| `test/status-work.test.ts` alone, growth gate | 124.80 s (2 pass, 1 fail: case 3, 60 000.17 ms) | 140726623318 |

Every other shard and slow-file job of the run passed. The run's conclusion is red all the same: the
aggregate `test` job (140726623318) failed on the two growth findings quoted below, the first-page
entry and the `status-work` timeout. The catalogue file is named exactly once across the five
artifacts (88 of 448 files in shard 1), so its required-shard coverage is visible in this run; what
is not met is the shard time, 33 641 ms against the 30 s bound, on the first shard sample of a file
the three standalone samples put at 27.81–29.18 s.

The growth gate (job 140726623318) measured the green speed claims of the list alone, and its two
findings are the record's own. `test/api-role-first-page.test.ts` measured 6.877 s and 6.900 s — both
at or below `SLOW_EXIT_SECONDS` (15 s), which the list's rule reads as "not slow" — and the follow-up
below settles that finding by returning the file to the shards. `test/status-work.test.ts` repeated
the third-case 60 s timeout (60 000.17 ms, case 2 at 27.914 s on the same run), which is a separate
production question owned elsewhere and not a claim of this change; `main` now quarantines that case
(madarch-stm0.13), so the merged tree's required job runs the file's two active cases.

`test/plugin-fill-scenarios.test.ts` is the twelfth file: it returned to the blocking shards in
`f1c275289` and has no slow-list entry. Its numbers above are its shard measurement (Bun's per-file
manifest entry of shard 4), not a single-file run.

Per-file job links, if a reader needs the log rather than the run:

| File | A job | B job | C job |
| --- | --- | --- | --- |
| `catalogue-kind-relations` | 140660644636 | 140665060345 | 140667390668 |
| `api-role-first-page` | 140660644675 | 140665060330 | 140667390809 |
| `agent-fill-e2e` | 140660644735 | 140665060613 | 140667390677 |
| `plugin-agent-edge-order` | 140660644821 | 140665060411 | 140667390845 |
| `imports-path` | 140660644890 | 140665060470 | 140667390446 |
| `ordinary-plugin-partition` | 140660644817 | 140665060482 | 140667390759 |
| `source-follows-fill` | 140660644568 | 140665060511 | 140667390998 |
| `status-work` | 140660644736 | 140665060527 | 140667390846 |
| `roles-two-and-two` | 140660644774 | 140665060623 | 140667390771 |
| `owner-fill-path` | 140660644824 | 140665060479 | 140667390693 |
| `db-schema-path` | 140660644782 | 140665060528 | 140667390605 |

The job URL is `https://github.com/shady2k/madarch/actions/runs/<run>/job/<job>` with the run id of
the sample's column.

## The reviewed head's required run

The reviewed head's own required run, [46069935373](https://github.com/shady2k/madarch/actions/runs/46069935373)
(`7aafaa899`), passed all five shard jobs on `ubuntu-24.04` and named both returned files exactly once
each in shard 1 (`test-files-1/shard-1.json`):

| Measure | Value |
| --- | --- |
| `test/api-role-first-page.test.ts` in shard 1 | 4 795 ms |
| `test/catalogue-kind-relations.test.ts` in shard 1 | 25 315 ms |

That is the required-shard confirmation both returns owe: the first page's reduced setup costs well
under the bound in a shard, and the catalogue file fits the 30 s shard bound on this sample, where its
first shard sample was 33 641 ms. The run's aggregate `test` job failed only on the third `status-work`
case, which `main` now quarantines, so no finding of that run belongs to this change. The next
required run measured the catalogue file above the bound again and returned it to its own job (see
below).

## The run that returned the catalogue file to its own job

The required run of the merged tree, [46078818727](https://github.com/shady2k/madarch/actions/runs/46078818727)
(`25ac52ca`), failed its aggregate `test` job
([140775221403](https://github.com/shady2k/madarch/actions/runs/46078818727/job/140775221403)) on two
growth findings about files the shards carried:

| Measure | Value | Job |
| --- | --- | --- |
| `test/catalogue-kind-relations.test.ts` in shard 1 | 34 019 ms | 140772756105 |
| `test/catalogue-kind-relations.test.ts` alone, run confirmation | 37 781 ms (1 pass, 0 fail, 244 `expect()` calls, exit 0) | 140775221403 |
| `test/api-role-first-page.test.ts` in shard 1 | 7 248 ms | 140772756105 |
| `test/architecture-repository.test.ts` in shard 1 | 31 789 ms | 140772756105 |
| `test/architecture-repository.test.ts` alone, run confirmation | 39 058 ms (1 pass, 0 fail, 5 `expect()` calls, exit 0) | 140775221403 |
| Five shard artifacts | 85 / 98 / 87 / 85 / 96 files, 451 files |  |

The gate's own words were `test/catalogue-kind-relations.test.ts took 34019 ms in shard and 37781 ms
alone, both more than 30 s, and is not in test/slow-files.json` and
`test/architecture-repository.test.ts took 31789 ms in shard and 39058 ms alone, both more than 30 s,
and is not in test/slow-files.json`.

The catalogue file is the one the inventory answers: this is the second required shard sample above the
bound (after 33 641 ms in run 46063935769), the run itself measured the complete file 37 781 ms alone,
and its case checks the real starter catalogue, every relevant File relation and the reader-visible
effects of successive publications, so the fixture and its assertions stay. It returns to
`test/slow-files.json` and to its own named required job, with its committed single-file evidence at
the 37 781 ms alone measurement. The three F4 standalone samples (29.18, 27.86 and 27.81 s) and the
reviewed head's 25 315 ms stay historical.

`test/architecture-repository.test.ts` is not of this change and nothing here reclassifies it: the same
file measured 22 989 ms in shard 1 of `main`'s own run
([46079872951](https://github.com/shady2k/madarch/actions/runs/46079872951), `7f1bb9aac`), so 31 789 ms
and 39 058 ms are the runner's spread on a file the suite carries. Its placement is left to fresh CI
evidence if the observation recurs.

`test/api-role-first-page.test.ts` is in shard 1 at 7 248 ms, named exactly once across the five
artifacts, so its return to the shards holds on this sample as well. The shard job of shard 1 also
failed two case-level tests that belong to work running independently of this diff:
`test/diagram-budget.test.ts`'s folder fold and `test/dispute-reconciliation-batch.test.ts`'s fixed
touched slots.

## Where the remaining time goes

Sample B's case timings, the case sum taken from the log and the rest attributed to the file's setup:

| File | File | Cases | The case or setup that costs |
| --- | --- | --- | --- |
| `db-schema-path` | 81.08 | 9.3 | setup: one draft and **two real fills** (the partial run that abstains, then the final run) |
| `owner-fill-path` | 66.10 | 62.6 | one case: `madarch init`, `madarch serve`, the plan, the pressed fill, the reads |
| `status-work` | 69.38 | 39.0 | two fills inside the cases (18.6 s and 19.5 s); setup adds the startup fill |
| `ordinary-plugin-partition` | 58.21 | 54.8 | two cases (28.6 s, 26.1 s), each driving three real reconciliation runs with a 2 s extract delay |
| `roles-two-and-two` | 52.48 | 42.7 | one case: two api and two fill processes, one press, one fill |
| `source-follows-fill` | 51.40 | 20.5 | its three cases: the setup fill's query budget, a page's source through the read worker, and the follow of a fill another process published (18.8 s) |
| `imports-path` | 43.69 | 0.8 | setup: one fill through the confined `imports` plugin |
| `api-role-first-page` | 42.70 | 1.6 | setup: one fill (about 19 s of it), the 150 000-line trace and one run |
| `agent-fill-e2e` | 36.96 | 33.7 | two agent fills (24.1 s and 9.6 s) |
| `plugin-agent-edge-order` | 32.72 | 30.8 | one fill through a probe plugin with an agent turn |
| `catalogue-kind-relations` | 27.86 | 26.0 | one case: five `publishValidatedManifests` of the extended starter catalogue, GraphQL and two diagrams |

One real fill pass of a small, already trimmed fixture costs 18.6–19.5 s on the runner
(`status-work`'s two case fills, sample B) — the same order as `main`'s 19.3 s median for that
fixture before 0039. A file that needs two passes therefore cannot reach 30 s whatever its data.

## Verdict per file

**Returns to its own required job: `test/catalogue-kind-relations.test.ts`.** Three independent green
runs of one tree at 29.18, 27.86 and 27.81 s put the file at or below the bound alone, so it returned
to the shards; both of its required shard samples then measured it above the bound, 33 641 ms and
34 019 ms, and the second run measured the complete file 37 781 ms alone. Its volume is its subject —
it publishes the real extended starter catalogue — so no reduction is asked for, and the file returns
to the slow list with one required passing case in its own named job. The three standalone samples stay
as historical evidence of what the file costs alone on a runner outside the suite.

**Not confirmed: `test/agent-fill-e2e.test.ts` (24.18 / 36.96 / 35.76).** It has one sample inside
the bound and two outside. The list's own growth rule requires both of two runs to stay at or below
the bound before a speed claim is taken, so it does not return yet: it is 5.76 s above the bound at
the median of its three samples, and both of its cases are agent fills, which cannot be cut. The
reduced `test/api-role-first-page.test.ts` did return, on the three alone samples of the pull
request's first run (the "The pull request's first run" section).

**Stays: the eight files above the bound in every sample** — `db-schema-path`
(81.08–84.13), `owner-fill-path`
(66.10–108.39), `status-work` (69.38–69.74), `ordinary-plugin-partition` (45.08–58.21),
`roles-two-and-two` (52.48–82.17), `source-follows-fill` (49.89–52.77), `imports-path`
(33.64–43.69), `plugin-agent-edge-order` (31.62–40.01). All are green in every sample; none is
within the doubling margin of the bound.

**Already a shard file: `test/plugin-fill-scenarios.test.ts`** at 18.04–25.10 s in shard 4, green in
all three samples.

## Fixture volume: incidental, or the subject

The fixtures of these files are already pruned: `useFixturePlugins` drops every kind whose producers
leave the manifest and turns the rest into a person's own writing, `withRepositoryPluginsOnly` keeps
`disk` and `git` plus the page kinds, and the fills the files spend are of those trimmed products.
No fixture in the set carries data its assertions do not read, so a smaller fixture does not recover
the 3–55 s the staying files miss. The one reduction that is still safe:

- **`test/api-role-first-page.test.ts`** — the setup fills the product only to publish its manifest
  and to have a store to read; the case itself asserts `/api/status` (`manifest: ok`, the run
  `fill-20261109T000000000Z` in state `created`, 150 000 spans, one step) from the trace file the
  setup writes, and asserts no filled fact. The smallest safe reduction is to publish the fixture
  manifest into the store instead of running a fill pass, keeping the 150 000-span trace, the run and
  the 5 s bound as they are. That removes about 18 s of the 42.70 s and would put the file near the
  bound; the closing PR carries it, with its own confirming runner measurement (see "The api role's
  first page after the setup change" below).

Everything else in the set is material and cannot be reduced without weakening a case:

- `agent-fill-e2e` — two agent fills (evidence over two files; a product whose agent plugin was
  removed);
- `db-schema-path` — the partial run that abstains and the final run that publishes what the readable
  SQL declares;
- `status-work` — a fill per published-page step, which is what moves the graph revision the case
  reads;
- `source-follows-fill` — a second process's fill, which is the case;
- `owner-fill-path`, `roles-two-and-two` — the real CLI, serve and role processes are the subject;
- `ordinary-plugin-partition` — three reconciliation runs and the real worker concurrency per heavy
  case, with a deliberate 2 s extraction delay;
- `imports-path`, `plugin-agent-edge-order`, `catalogue-kind-relations` — the fill of the plugin or
  catalogue under test is the assertion.

## The evidence for keeping the named required checks

Each staying file does work no shard can carry: `test/slow-files.json` and
`.github/workflows/ci.yml`'s `slow-files` matrix are the only required coverage of a file the shards
exclude, and each job proves its file ran (one header, one file, at least the listed number of
passing cases, zero failures). The measured 31.62–84.13 s of the staying files is not one slow case
that a bound could clip: it is the file's own scenario count and its real fills and processes, so the
only way to keep them in the blocking set is one required job each, which is what the matrix gives.

## Coordination with the `MISSING_ENDPOINT` investigation

`test/plugin-fill-scenarios.test.ts` is the file that investigation reports as flaky (`MISSING_ENDPOINT
plugin|system.unit`, 2 of 9 runs on `f1c275289`). It was green in all three samples and no
`MISSING_ENDPOINT` appears in their logs; its fix candidate `676647fe8` is not in `main` at
`9b0b16da3`. The fix is expected to change publication correctness and not the cost, and its shard
measurement (18–25 s) leaves room under the bound. If the fix is in `main` before the closing PR, the
shard timing of that file should be read again in the closing PR's own run; nothing else in this
report depends on it.

## What the closing PR changed

1. **`test/catalogue-kind-relations.test.ts` returned to the shards and then came back to its own
   named required job.** Its entry in `test/slow-files.json` and its line (`file`, `cases: 1`) in the
   `slow-files` matrix of `.github/workflows/ci.yml` went with the three standalone samples at 29.18,
   27.86 and 27.81 s, and both of its required shard samples then measured it above the bound:
   33 641 ms in shard 1 of run 46063935769 and 34 019 ms in shard 1 of run 46078818727, with the
   second run's own confirmation at 37 781 ms alone. So the entry and the matrix line are back, with
   one required passing case, its existing 30 s exit and its fixture and assertions unchanged; the
   matrix comment now names eleven files.
2. **Its committed single-file evidence is 37 781 ms**, the run's own alone measurement of the
   complete file (1 pass, 0 fail, 244 `expect()` calls, exit 0). The three standalone samples
   (29 180, 27 860 and 27 810 ms) stay in the table above as historical evidence of what the file
   costs alone outside the suite; a shard finding needs both the shard and the alone measurement
   above the bound, and both shard samples were.
3. **The nine staying entries record the three-sample median**, in `test/slow-files.json` and in
   `.github/workflows/single-file-timings.json` together, because the slow-list check compares them
   within 100 ms: `agent-fill-e2e` 35.76 s, `plugin-agent-edge-order` 32.72 s, `imports-path`
   34.51 s, `ordinary-plugin-partition` 57.30 s, `source-follows-fill` 51.40 s, `status-work`
   69.62 s, `roles-two-and-two` 78.82 s, `owner-fill-path` 82.00 s and `db-schema-path` 82.53 s.
   `api-role-first-page` left the list in the follow-up that carries the first runner run's evidence
   and records 9 320 ms there. The numbers these entries carried before were the 0039 candidate's box
   numbers (313, 507, 194 s …) or, for `agent-fill-e2e`, the 31.283 s of run 45809866011; the trace
   they explained is superseded, so each entry now names the passes it pays and why they are its
   subject. The catalogue entry is the tenth, and it records the 37 781 ms alone measurement of the
   run that returned it to the list, not a three-sample median.
4. **The `api-role-first-page` setup publishes the fixture manifest instead of filling.** The store
   is prepared by the test store preparation the other api tests use, the fixture manifest is
   published with `publishValidatedManifests`, and one finished run stands before the run the case
   asserts so the page still reports `filled` and `manifest: ok`. The real api role, the store path,
   the asserted run and its `created` state, the 150 000-span trace, all nine expectations and both
   latency bounds (5 s and 50 ms) are unchanged.
5. **The catalogue file's named required job is back; one required job is gone: the first page's.
   The case counts that move are `source-follows-fill`'s and `status-work`'s.** The eleven matrix
   lines are the catalogue file at `cases: 1`, the nine stream entries with eight `cases` values
   unchanged, `source-follows-fill` raised from 2 to 3 to match the three cases the file holds, and
   `status-work` at the two cases `main`'s third-case quarantine leaves (1, 2, 5, 1, 16, 1, 5, 1, 2,
   3), plus `main`'s `fill-trace` at 2; the blocking aggregate is unchanged, minus the first page's
   row and plus the catalogue file's, whose file leaves the shards.

## Shard selection after the catalogue file's return

The files the shards carry after the catalogue file's return are 450 (the 64 the slow list names are
excluded). A replay of Bun's own `--shard` selection over those 450 files with the committed weights of
`.github/workflows/test-timings.json` names `test/api-role-first-page.test.ts` exactly once, in shard
1, and `test/catalogue-kind-relations.test.ts` not at all, and leaves the five shards at
88 / 96 / 86 / 84 / 96 files. That is the 85 / 98 / 87 / 85 / 96 of the merged tree's 451 files with
the catalogue file's one line out of shard 1 and the first page rebalanced to shard 1, so the shards
still carry every file exactly once and the catalogue file's only required coverage is its matrix job.

## The api role's first page after the setup change

Measured on a 4 vCPU / 8 GiB box on agent-linux-02, one file at a time inside the
`scripts/plugin-sandbox-cgroup.sh` slice, `MADARCH_SKIP_PERF` unset so both latency bounds are
asserted:

- **Before** (the setup at `9b0b16da3`, a full in-process fill): the file stops at the 120 s bound
  its setup names — 130.34 s, 0 pass, 1 fail, "a beforeEach/afterEach hook timed out for this test".
  That is the same stop the old entry reported on box `madarch-0039-fix2`.
- **After** (this PR): `bun run test --slow --only test/api-role-first-page.test.ts` twice — 37.15 s
  and 36.26 s, 1 pass, 0 fail, 9 `expect()` calls both times, and the case itself 3.00 s and 2.77 s
  (the first answer inside its 5 s bound, the unchanged second answer inside 50 ms).
- **Where the after time goes**, one instrumented run of the same file: store and graph schema
  preparation 13.9 s, manifest publication 4.4 s, the 150 000-line trace 1.7 s, run recording and
  server start 0.3 s, the case 2.9 s, the rest the file's teardown. The fill this replaces costs
  18.6–19.5 s on a runner, and the box's non-fill part is about 3.6 times a runner's, so the reduced
  file is expected to measure about 10–20 s on ubuntu-24.04.
- **Not measured on a runner here.** The file's own slow-files matrix job and the merge-base growth
  gate both run it alone in the closing PR's CI, and that measurement is the deciding evidence for
  its return.

## The catalogue publication evidence

The stream's second exit criterion asked for publishing a reduced catalogue to cost about what the
initial publication costs. The matched pair this record carries is the one PR #358 measured with the
extended starter catalogue on the same box: the same fixture publishes **16.15 s** initially,
then **498 of its kinds are removed** (505 kinds left 7; 1 132 vertices retired) and the same fixture
is republished in **15.63 s**, where the same removal took 302.7–405.3 s before the fix. The SQL calls
fell from 33 860 to 859 and the resulting graph was identical (1 470 records, 4 486 retirements,
14 201 vertices, 52 802 edges). That is the removal faster than the initial publication, on one
fixture and one box, not a runner sample.

The scenario originally reported — publishing a catalogue after removing **about 95 kinds**, which
had not finished after 120 s on Linux x64 on 2026-11-26 — has **no matched before/after pair of its
own**. What the pair above proves is the same code path (batched retirement in the graph writer under
the existing write lock) at a larger removal (498 kinds against 95). A direct repeat of the ~95-kind
scenario would need the starter catalogue reduced by about 95 kinds, the publication timed end to end
before and after this stream's commits, on the same machine and fixture; nothing in this record
substitutes for it.

## Follow-ups this record leaves open

1. **`api-role-first-page` returned to the shards.** Its own job measured the reduced file 9.32 s
   (job 140724610904), and the growth gate of the same run measured it alone twice more, at 6.877 s
   and 6.900 s (job 140726623318, attempts 1 and 2): three green alone samples, and two of them at or
   below `SLOW_EXIT_SECONDS` (15 s), which the list's own rule reads as "not slow". The entry and
   its matrix line (`cases: 1`) are gone, the shards carry the file again,
   `.github/workflows/single-file-timings.json` records 9 320 ms, and the next required run's shard
   artifact shows the file named once as its coverage: 4 795 ms in shard 1 of the reviewed head's
   required run, 46069935373. A replay of Bun's own `--shard` selection
   with the committed timings over the 450 files the change leaves in the suite names it exactly once
   and the catalogue file not at all (see "Shard selection after the catalogue file's return").
2. **`agent-fill-e2e`**: its median is 35.76 s (24.18 / 36.96 / 35.76), and the pull request's first
   run measured 27.30 s green (job 140724610951) besides 26.759 s from the same run's growth gate —
   both inside the bound, neither at or below `SLOW_EXIT_SECONDS` (15 s). Its entry, its two agent
   fill scenarios and its `cases: 2` stay until a fresh confirmation and verified shard coverage
   arrive.
3. **`catalogue-kind-relations` returned to the slow list and its own required job.** The file ran in
   the pull request's shards and both of its required shard samples were above the bound: **33 641 ms**
   in shard 1 of run 46063935769 (job 140724610884) and **34 019 ms** in shard 1 of run 46078818727
   (job 140772756105), where the run's own confirmation measured the complete file **37 781 ms** alone
   (job 140775221403, 1 pass, 0 fail, 244 `expect()` calls, exit 0). Its three standalone samples of
   the F4 tree, 29.18, 27.86 and 27.81 s, and the reviewed head's 25 315 ms in shard 1 (46069935373)
   stay in this record as historical evidence; the committed single-file evidence and the slow-list
   entry now carry the 37 781 ms alone measurement, the entry has one required passing case in the
   `slow-files` matrix, and the file's weight left `.github/workflows/test-timings.json` with its shard
   coverage. It returns to the shards only after a green complete-file runner measurement at or below
   30 s, a fresh confirmation and verified required-shard coverage.
4. **Nothing else moves**: the eight files whose median is 32.72–82.53 s keep their named required
   jobs, their case counts and the nightly summary unchanged.
