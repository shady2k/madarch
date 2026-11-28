# The twelve files and the catalogue reduction, measured on the runners and on one box

Change: madarch-64o5.176-final-returns
Tasks: madarch-64o5.176
Kind: no-behavior

## What this record adds

The measurement record before this one
(`docs/changes/madarch-64o5.176-final/measurement.md`) settled eleven of the twelve files and named
two gaps: `test/agent-fill-e2e.test.ts` had one sample inside the bound and two outside, and the
scenario of publishing a catalogue after removing about 95 kinds had "no matched before/after pair
of its own". This record closes both with measurements taken afterwards, and accounts for all twelve
files one by one.

The runs cited here measured the tree this change delivers. The record's final commit edits these
two documents only — no inventory line, workflow line or test changes with it — so the numbers below
are the delivered tree's.

Two things were measured:

1. **Two further required runs of `main`** after the stream's last merge, whose `slow-files` jobs
   measure every staying file of the study again (both runs concluded `success`), and **the returning
   pull request's own required run**, whose shards carry the files that leave the list.
2. **The catalogue reduction**, as a matched pair: the same starter catalogue published once and
   then again after the catalogue is reduced, on the #353 merge baseline and on current `main`, one
   box, one process per revision, the same bracket around `publishValidatedManifests`.

## The two required runs of `main`

Runs [46099717218](https://github.com/shady2k/madarch/actions/runs/46099717218) (`f2c55b343`) and
[46102135712](https://github.com/shady2k/madarch/actions/runs/46102135712) (`c94b578ec`), both on
`ubuntu-24.04`, both `success`. The number is the `Ran N tests across 1 file. [X]` line of the job
that ran `bun run test --slow --only <path>` — Bun's own complete-file duration, the number the
repository compares with its 30 s bound.

| File | 46099717218 | 46102135712 | Outcome |
| --- | ---: | ---: | --- |
| `test/agent-fill-e2e.test.ts` | 26.76 s (2 pass, 59 `expect()`) | 27.38 s (2 pass, 59 `expect()`) | **inside the bound** |
| `test/catalogue-kind-relations.test.ts` | 28.01 s (1 pass, 244 `expect()`) | 27.63 s (1 pass, 244 `expect()`) | **inside the bound** |
| `test/plugin-agent-edge-order.test.ts` | 37.20 s | 38.11 s | above |
| `test/imports-path.test.ts` | 39.20 s | 38.98 s | above |
| `test/ordinary-plugin-partition.test.ts` | 45.70 s | 44.20 s | above |
| `test/source-follows-fill.test.ts` | 86.05 s | 63.53 s | above |
| `test/status-work.test.ts` | 62.33 s | 64.89 s | above |
| `test/roles-two-and-two.test.ts` | 75.88 s | 97.12 s | above |
| `test/owner-fill-path.test.ts` | 82.09 s | 80.08 s | above |
| `test/db-schema-path.test.ts` | 88.05 s | 87.50 s | above |
| `test/fill-trace.test.ts` | 34.45 s | 23.39 s | listed for another task (madarch-stm0.14); not of this study |
| `test/fill-run-recovery.test.ts` | not in the matrix then | listed for another task (madarch-47vw.7); 236.2 s |
| `test/architecture-repository.test.ts` | 25.31 s | 33.75 s | listed for another task (madarch-x9a7.12) |

Two samples inside the bound are what the list's own rule asks before a speed claim is taken; the
third thing its exit sentence asks — verified required-shard coverage — comes from the returning pull
request's own run, below.

## Returning the two files to the shards

The change returned both files: their entries left `test/slow-files.json`, their rows left the
`slow-files` matrix of `.github/workflows/ci.yml`, their committed single-file evidence recorded the
latest required-run sample (27 380 ms and 27 630 ms) and their shard weights went back into
`.github/workflows/test-timings.json`. The returning pull request is
[#401](https://github.com/shady2k/madarch/pull/401).

Two required runs of this pull request matter. The first,
[46105327705](https://github.com/shady2k/madarch/actions/runs/46105327705) (head `e4c22fc67`),
returned **both** files and concluded `success`: all five shard jobs, every `slow-files` job and the
aggregate `test` job green. Its five shard artifacts hold 91 / 92 / 91 / 89 / 90 files (453 files,
the two returned files included), and each returned file is named **exactly once** across them:

| Measure | 46105327705 (`e4c22fc67`) | 46107475379 (`d0046bd6d`) | 46108016522 (`4438e6ee0`) |
| --- | ---: | ---: | ---: |
| `test/catalogue-kind-relations.test.ts` in shard 1 | **27 119 ms** | **26 506 ms** | **24 486 ms** |
| `test/agent-fill-e2e.test.ts` in shard 1 | **35 185 ms** | not in the shards: listed again | not in the shards |

The catalogue file is inside the bound in the shard as well — three times, 27 119 ms, 26 506 ms and
24 486 ms in shard 1 — so it returns: its entry and its matrix row stay gone, and its one case runs in shard 1 of
every required run from now on. Its case count is unchanged (one case, 244 `expect()` calls in every
sample above), and the file is named once in each run, so its coverage is one required shard
execution.

`test/agent-fill-e2e.test.ts` fails the bound where the suite would run it: **35 185 ms in shard 1**,
5 185 ms over the bound, while both of its alone samples are inside it. Its entry, its matrix row
(`cases: 2`), its committed evidence (35 760 ms) and its shard weight therefore come back, and its
entry records the two alone samples and this shard sample. The list cannot carry it on the alone
samples either: `scripts/check-slow-tests.ts` refuses a listed entry at or below 30 s, and refuses an
entry whose seconds disagree with the committed single-file evidence by more than 100 ms, so a file
that is 26.76–27.38 s alone has no honest entry. What keeps it a named required job is its shard
cost, which the list's own growth rule reads only through a shard measurement **and** an independent
alone measurement above the bound; this run gives the shard half only.

The task's instruction is what this follows: return a file only if the required CI confirms it, and
retain the required job of one that fails the bound, citing the runner evidence.

## The returning pull request's own required runs

Two runs of this pull request carry the shard evidence; both are `ubuntu-24.04` and both concluded
`success`:

| Run | Head | Shard artifacts | Aggregate `test` |
| --- | --- | --- | --- |
| [46105327705](https://github.com/shady2k/madarch/actions/runs/46105327705) | `e4c22fc67` | 91 / 92 / 91 / 89 / 90 (453 files) | green (140858499500) |
| [46107475379](https://github.com/shady2k/madarch/actions/runs/46107475379) | `d0046bd6d` | 93 / 94 / 87 / 82 / 96 (452 files) | green (140864539847) |
| [46108016522](https://github.com/shady2k/madarch/actions/runs/46108016522) | `4438e6ee0` | 93 / 94 / 87 / 82 / 96 (452 files) | green |

- Shard jobs of the final head: 140863340306, 140863340258, 140863340244, 140863340265,
  140863340260; its `slow file test/agent-fill-e2e.test.ts` job is 140863340363.
- `test/catalogue-kind-relations.test.ts` is named exactly once in shard 1 of all three runs,
  27 119 ms, 26 506 ms and 24 486 ms; `test/agent-fill-e2e.test.ts` is named once in shard 1 of the
  first (35 185 ms) and in neither of the other two, where it is listed again and runs in its own
  required job.
- `test/plugin-fill-scenarios.test.ts` (the twelfth file of the study, already a shard file) measured
  21 197 ms in shard 4 of the first run and 18 208 ms in shard 3 of the second;
  `test/api-role-first-page.test.ts` measured 8 303 ms and 5 071 ms in shard 1 — all inside the bound
  and unchanged in placement.
- The files the matrix runs are absent from all five shard artifacts of both runs, as
  `scripts/run-tests.ts` intends.

## The eight staying files: what needs the workload

Each of the eight is its own end-to-end scenario; the assertion named is the one that cannot survive
a smaller fixture. The seconds are the two required runs above.

| File | The assertion that needs the workload |
| --- | --- |
| `test/db-schema-path.test.ts` | `test/db-schema-path.test.ts:112` — the file answers the tables, their columns, the index and the foreign key of a database the partial run abstained on and the final run published; two real fills (9.3 s of case time of 81.08 s) are the setup that makes both readable states exist. |
| `test/owner-fill-path.test.ts` | `test/owner-fill-path.test.ts:63` — the owner's own path: `madarch init`, `madarch serve`, the plan, the pressed fill and the reads of its result, one case (62.6 s of 66.10 s). |
| `test/status-work.test.ts` | `test/status-work.test.ts:108` — an explicitly published page moves the graph revision the status answer reads; the fill per published-page step is what moves that revision (two case fills of 18.6 s and 19.5 s). Its third case is in the repository's case-level quarantine (madarch-stm0.13), which is why the matrix keeps `cases: 2`. |
| `test/ordinary-plugin-partition.test.ts` | `test/ordinary-plugin-partition.test.ts:129` — the same commits fill across changed group boundaries without retractions or disputes; three real reconciliation runs with the deliberate 2 s extraction delay are the case (28.6 s and 26.1 s). |
| `test/roles-two-and-two.test.ts` | `test/roles-two-and-two.test.ts:105` — one press fills the product once, every unit publishes once, and both api instances answer from it: two api and two fill processes are the case. |
| `test/source-follows-fill.test.ts` | `test/source-follows-fill.test.ts:188` — a source read reports the commit of a fill **another process** published, with the text that fill left (18.8 s); the file's three cases keep their `cases: 3`. |
| `test/imports-path.test.ts` | `test/imports-path.test.ts:102` — it answers the imports of `src/graph/write.ts` with their places, forms and names and the package they name; the fill through the confined `imports` plugin is the assertion, not the setup. |
| `test/plugin-agent-edge-order.test.ts` | `test/plugin-agent-edge-order.test.ts:174` — the first fill publishes an edge in its later endpoint turn; the fill through a probe plugin with an agent turn is the case. |

No smaller fixture exists for any of them: the fixtures are already pruned (`useFixturePlugins`,
`withRepositoryPluginsOnly`), and one real fill pass of an already trimmed fixture costs 18.6–19.5 s
on the runner, so a file that needs two or three passes cannot reach the bound whatever its data.
The eight keep one named required job each, their case counts and their entries' medians.

## The twelve files, one by one

| File | Where it runs now | Evidence |
| --- | --- | --- |
| `test/plugin-fill-scenarios.test.ts` | shard 4 | 21 197 ms in shard 4 of run 46105327705; already a shard file before this change |
| `test/api-role-first-page.test.ts` | shard 1 | 8 303 ms in shard 1 of run 46105327705; returned in the previous change |
| `test/catalogue-kind-relations.test.ts` | shard 1 | 27 119 ms, 26 506 ms and 24 486 ms in shard 1 of runs 46105327705, 46107475379 and 46108016522; 28.01 s and 27.63 s alone in the two `main` runs; **returned by this change** |
| `test/agent-fill-e2e.test.ts` | its own required job, `cases: 2` | 35 185 ms in shard 1 of the return attempt; 26.76 s and 27.38 s alone; **retained by this change** |
| `test/db-schema-path.test.ts` | its own required job, `cases: 5` | 88.05 s and 87.50 s alone; two real fills are its setup |
| `test/owner-fill-path.test.ts` | its own required job, `cases: 1` | 82.09 s and 80.08 s alone; the CLI, the serve, the press and the reads are the case |
| `test/status-work.test.ts` | its own required job, `cases: 2` | 62.33 s and 64.89 s alone; a fill per published-page step; third case in the case-level quarantine madarch-stm0.13 |
| `test/ordinary-plugin-partition.test.ts` | its own required job, `cases: 16` | 45.70 s and 44.20 s alone; three reconciliation runs and the 2 s extraction delay |
| `test/roles-two-and-two.test.ts` | its own required job, `cases: 1` | 75.88 s and 97.12 s alone; two api and two fill processes |
| `test/source-follows-fill.test.ts` | its own required job, `cases: 3` | 86.05 s and 63.53 s alone; another process's fill is the case |
| `test/imports-path.test.ts` | its own required job, `cases: 5` | 39.20 s and 38.98 s alone; the confined `imports` plugin's fill is the assertion |
| `test/plugin-agent-edge-order.test.ts` | its own required job, `cases: 1` | 37.20 s and 38.11 s alone; the probe plugin's agent turn is the case |

No case is quarantined by this change. The only case-level quarantine that touches the twelve is
`test/status-work.test.ts`'s third case, `madarch-stm0.13` in `docs/quarantine.md`, which `main`
already carries and which this change neither adds to nor lifts.

## Publishing a catalogue after removing about 95 kinds

Two pairs were measured on box `alx1788-perf` (`agent-linux-02`, 4 vCPU, 8 GiB, Bun 1.4.2), one
revision per run, each with a fresh store, one process, `MADARCH_SKIP_PERF=1` and
`MADARCH_OWN_WIKI=off`, everything inside `scripts/plugin-sandbox-cgroup.sh`'s delegated slice. The
bracket is `publishValidatedManifests` alone; schema and store preparation are timed separately and
reported below. SQL statements are counted at the PostgreSQL client.

The revisions are the #353 merge baseline `4316c762dc07f0b08e961b857f505ec07740fc83`
(`main` after the 0039 foundation landed) and current `main`
`c94b578ec79346dc003512ab9c1d8c852988a0f9`. Both runs used the same starter catalogue — the
`everything` template, 144 declared kinds — the same retained kind sets and the same build mode
(workspace TypeScript run by Bun 1.4.2, no compiled binary on either side).

The recipe, with the repository's own helpers, is what both revisions ran:

```ts
const draft = createDraft({ template: 'everything', home, name: 'catalog-profile' });
const full = validateProductManifests(draft.folder).value;
const owner = await createDatabaseOwner({ store, btreeGist: true });
await prepareTestStore(owner, { contract: withManifestContract(graphContractOf(full.manifest)) });
const started = performance.now();
await publishValidatedManifests(owner, full, graphContractOf(full.manifest));   // initial publication
let reduced = full;
for (const step of steps) {                                                     // the catalogue is reduced
  step(draft.folder);                                                           // 1: prepareStoreAcceptanceFixture
  commitProduct(draft.folder, 'Reduce starter catalogue');                      // 2: keep 49 kinds
  reduced = validateProductManifests(draft.folder).value;
  await prepareTestStore(owner, { contract: withManifestContract(graphContractOf(reduced.manifest)) });
}
const reductionStarted = performance.now();
await publishValidatedManifests(owner, reduced, graphContractOf(reduced.manifest)); // reduced publication
```

### Pair 1 — the original scenario: the plugin-free store fixture

This is the reduction the stream's own diagnosis reported: `scripts/clean-install-fixture.ts` keeps the five
code-structure kinds with what they derive from and marks every kept field a person's write, which
leaves **6 declared kinds of 144** — 138 removed, more than the "about 95" the original report
described, because the starter catalogue has grown. Its retained kind set is the same committed
fixture on both revisions (the file is identical in both trees).

| Revision | Store preparation | Initial publication | SQL calls | Reduced publication | SQL calls | Reduced / initial |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `4316c762d` (#353 merge) | 10 009.8 ms | 16 176.4 ms | 196 | **398 723.9 ms** | 33 864 | 24.6× |
| `c94b578ec` (current `main`) | 10 459.7 ms | 14 867.9 ms | 186 | **11 392.0 ms** | 859 | 0.77× |

The reduced publication is **35.0 times faster** on current `main` than on the #353 merge, 97.5 %
fewer SQL statements (859 against 33 864), and on `main` it costs 0.77 of the initial publication,
which is the exit criterion's "about what the initial publication costs". The resulting graph is
identical on both revisions — 1 470 writes, 4 486 retirements, 14 201 nodes, 52 802 edges — so the
faster path publishes the same catalogue.

### Pair 2 — exactly 95 kinds removed

The criterion names "about 95 kinds", so the same pair was measured with exactly 95 removed: the six
fixture kinds plus the alphabetically first further kinds whose derivations reach **49 declared
kinds of 144**. The retained set is deterministic, identical on both revisions, and its declarations
are pruned the way the fixture prunes its own (relations, key-edge roles, edges and semantic bindings
that name a dropped kind go; kept fields become a person's write).

| Revision | Initial publication | SQL calls | Reduced publication | SQL calls | Reduced / initial |
| --- | ---: | ---: | ---: | ---: | ---: |
| `4316c762d` (#353 merge) | 16 167.4 ms | 196 | **374 305.1 ms** | 33 098 | 23.2× |
| `c94b578ec` (current `main`) | 15 563.0 ms | 186 | **11 615.4 ms** | 766 | 0.75× |

Identical resulting graph again: 1 941 writes, 4 015 retirements, 14 064 nodes, 53 310 edges. The
reduced publication is **32.2 times faster** on current `main` (374.3 s against 11.6 s) with 97.7 %
fewer SQL statements.

### The upper bound the baseline needed

The original report is that this publication "had not finished after 120 s". It is now measured: on
the #353 merge the reduced publication of 95 kinds takes **374.3 s** — 3.1 times the 120 s bound the
clean-install walk named — and of the fixture's 138 kinds **398.7 s**. Both runs finished inside the
900 s cap the harness was given (`timeout -k 10 900`), and neither hit it, so the numbers above are
complete measurements, not floors. On current `main` the same two publications are 11.6 s and 11.4 s.

The independent 505 → 7 pair PR #358 measured (16.15 s initial, 15.63 s reduced, same box family)
stands beside these as the larger fixture's sample; the two agree on the order of a few to about
fifteen seconds for a reduced publication on current `main`.

## Where the probes and logs are

The probes are in box `alx1788-perf` at `/work/input/m95-profile.ts` (Pair 1) and
`/work/input/probe-m95b.ts` (Pair 2), and their logs at `/work/reports/m95-base.log`,
`/work/reports/m95-main.log`, `/work/reports/m95b-base.log` and `/work/reports/m95b-main.log`. They
change nothing in the repository, so they are not committed; the recipe above reproduces Pair 1 with
committed helpers alone, and Pair 2's retained set and pruning rules are stated in full above.

## What is left

1. **`test/agent-fill-e2e.test.ts`** keeps its entry, its `cases: 2` and its required job: its
   required shard sample is 35 185 ms, above the bound, while its alone samples are inside it. The
   smallest next action is a required run whose shard 1 sample measures the file at or below 30 s; the
   file has no fixture to cut, so only a fall in its two agent fills' cost can produce it.
2. **The eight staying files** keep their jobs and their numbers; nothing about them is pending.
3. **The catalogue reduction** is measured on both revisions, at both sizes, and needs nothing.
