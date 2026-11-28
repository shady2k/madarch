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

A review of this record's first version found two things that are corrected here. The pair measured
publishing a catalogue from **two different starter trees**, because each run built its draft from
its own revision's `everything` template; the pair below is repeated on one pinned starter tree, and
the earlier pair is kept beside it, labelled with that difference. The record also attributed
required-run artifacts to the wrong runs and explained the slow-files matrix against samples that
contradict it; every run cited below is now named with its own head, and the matrix paragraph states
what its samples measured.

Two things were measured:

1. **Five required runs of the returning pull request** — the first attempt and the four runs after
   it, the last at the reviewed head — whose shard artifacts carry the file that leaves the list,
   and **two further required runs of `main`** after the stream's last merge, whose `slow-files`
   jobs measure every staying file of the study again (all seven runs concluded `success`).
2. **The catalogue reduction**, as a matched pair: one pinned starter catalogue published once and
   then again after the catalogue is reduced by exactly 95 kinds, on the #353 merge baseline and on
   current `main`, one box, one process per revision, the same bracket around
   `publishValidatedManifests`.

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
request's own runs, below.

The nine study files' earlier single-file series, which the matrix below rests on, is three runs of
the F4 tree: 46044618928 (head `7b9499138`), 46045922097 (merge `46be90c4a`) and 46046625374
(`9b0b16da3`). Eight of the nine were above the bound in all three samples. The ninth,
`test/agent-fill-e2e.test.ts`, was not: it measured **24.18 s**, 36.96 s and 35.76 s — median
35.76 s — and each of those runs held both of its cases. Its first sample is therefore the proof
that two agent fills can fit inside 30 s; what keeps its named required job is the median and the
shard sample, not an impossibility.

## Returning the catalogue file to the shards

The change returns `test/catalogue-kind-relations.test.ts` to the shards — its entry leaves
`test/slow-files.json` and its row leaves the `slow-files` matrix of `.github/workflows/ci.yml` —
and keeps `test/agent-fill-e2e.test.ts` in its named required job. The returning pull request is
[#401](https://github.com/shady2k/madarch/pull/401), and five of its required runs carry the shard
evidence; all are `ubuntu-24.04` and all concluded `success`.

| Run | Head | Shard artifacts (files) | `test/catalogue-kind-relations.test.ts` in shard 1 | `test/agent-fill-e2e.test.ts` |
| --- | --- | --- | ---: | --- |
| [46105327705](https://github.com/shady2k/madarch/actions/runs/46105327705) | `e4c22fc67` | 92 / 95 / 86 / 84 / 96 (453) | **27 119 ms** | in shard 1, **35 185 ms** |
| [46107475379](https://github.com/shady2k/madarch/actions/runs/46107475379) | `d0046bd6d` | 93 / 94 / 87 / 82 / 96 (452) | **26 506 ms** | its own required job, 26.75 s |
| [46108016522](https://github.com/shady2k/madarch/actions/runs/46108016522) | `4438e6ee0` | 93 / 94 / 87 / 82 / 96 (452) | **24 486 ms** | its own required job, 39.19 s |
| [46108461893](https://github.com/shady2k/madarch/actions/runs/46108461893) | `9f486034c` | 93 / 94 / 87 / 82 / 96 (452) | **28 437 ms** | its own required job, 34.05 s |
| [46108978562](https://github.com/shady2k/madarch/actions/runs/46108978562) | `eac39521e` — the reviewed head | 93 / 94 / 87 / 82 / 96 (452) | **24 820 ms** | its own required job, 38.47 s (two cases) |

The shard number is the file's own cost inside the shard, read from the shard job's log as the span
between the file's header line and the next file's header (for the last file of a shard, up to the
`Ran N tests` line); the `test/agent-fill-e2e.test.ts` 35 185 ms figure was read the same way. The
named-job numbers are the `Ran N tests across 1 file. [X]` lines of those jobs. The catalogue file
is named exactly once across the five shard artifacts of every run; `test/agent-fill-e2e.test.ts` is
named once in the first attempt's shard 1 and in no shard of the four later runs, where its own
required job runs it. Each file therefore has exactly one required execution per run, and no case
count changed anywhere.

The catalogue file is inside the bound in the shard as well — **five times**: 27 119 ms, 26 506 ms,
24 486 ms, 28 437 ms and 24 820 ms — so it returns: its entry and its matrix row stay gone, and its
one case (244 `expect()` calls, unchanged) runs in shard 1 of every required run from now on.

`test/agent-fill-e2e.test.ts` passed through the shards once, in the first attempt, at **35 185 ms in
shard 1**, 5 185 ms over the bound. It went back to its own required job in the four runs after it,
where both of its cases ran and the file measured 26.75 s, 39.19 s, 34.05 s and 38.47 s. Its entry,
its matrix row (`cases: 2`), its committed evidence (35 760 ms) and its shard weight therefore stay,
and its entry records the two alone samples, the shard sample and the named-job samples.

The list cannot carry it on the alone samples either: `scripts/check-slow-tests.ts` refuses a listed
entry at or below 30 s, and refuses an entry whose seconds disagree with the committed single-file
evidence by more than 100 ms, so a file at 26.76–27.38 s alone has no honest entry. Its committed
35.76 s is the median of its three F4 samples (24.18 s, 36.96 s and 35.76 s), which is the number
the check compares with. Keeping the two cases as a named required job was decided on 28 November in
ALX-2061, under the owner's combined variant of the stage approved on 27 November: an end-to-end
scenario that cannot hold the bound inside the shards stays a separate required check rather than
losing a case.

The files the matrix runs are absent from all five shard artifacts of every run, as
`scripts/run-tests.ts` intends.

## The other two study files in the same runs

`test/plugin-fill-scenarios.test.ts` is a shard file throughout: it measured 21 197 ms in shard 4 of
the first attempt (46105327705) and 18 208 ms, 18 725 ms, 22 034 ms and 19 693 ms in shard 3 of the
four later runs, in that order. `test/api-role-first-page.test.ts` measured 8 303 ms, 5 071 ms,
4 779 ms, 7 966 ms and 4 808 ms in shard 1 of the same five runs. Both are inside the bound and
neither changed placement.

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
`withRepositoryPluginsOnly`). One real fill pass of an already trimmed fixture costs about
18.6–19.5 s on the runner, so a file that needs two or three of them sits at or above the bound —
`test/agent-fill-e2e.test.ts` is the one two-pass file that once fitted (24.18 s), which is why its
retention rests on its median and its shard sample rather than on an arithmetic impossibility. The
eight keep one named required job each, their case counts and their entries' medians.

## The twelve files, one by one

| File | Where it runs now | Evidence |
| --- | --- | --- |
| `test/plugin-fill-scenarios.test.ts` | a shard file: shard 4 in the first attempt, shard 3 in the four later runs | 21 197 ms in shard 4 of 46105327705; 18 208 / 18 725 / 22 034 / 19 693 ms in shard 3 of 46107475379 / 46108016522 / 46108461893 / 46108978562; already a shard file before this change |
| `test/api-role-first-page.test.ts` | shard 1 | 8 303 / 5 071 / 4 779 / 7 966 / 4 808 ms in shard 1 of 46105327705 / 46107475379 / 46108016522 / 46108461893 / 46108978562; returned in the previous change |
| `test/catalogue-kind-relations.test.ts` | shard 1 | 27 119 / 26 506 / 24 486 / 28 437 / 24 820 ms in shard 1 of those five runs; 28.01 s and 27.63 s alone in the two `main` runs; **returned by this change** |
| `test/agent-fill-e2e.test.ts` | its own required job, `cases: 2` | 35 185 ms in shard 1 of the first attempt; 26.75 / 39.19 / 34.05 / 38.47 s in its own job in the four later runs; 26.76 s and 27.38 s alone in the two `main` runs; **retained by this change** |
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

The `slow-files` matrix of `.github/workflows/ci.yml` therefore holds **twelve** named jobs: the nine
study files of the table above that stay (`test/agent-fill-e2e.test.ts` and the eight) and the three
entries of other tasks, `test/fill-trace.test.ts`, `test/fill-run-recovery.test.ts` and
`test/architecture-repository.test.ts`.

## Publishing a catalogue after removing about 95 kinds

The pair below is the matched one this record owes: **one pinned starter tree, published on both
revisions.** The first version of this section measured two different starter trees, and a review of
it (ALX-2060) found the difference: each run had built its draft with its own revision's
`everything` template, and those templates differ — the starter `madarch` tree of `4316c762d` hashes
`fba98bcfd7b1e1dffaa6e6279339f53c906a69c8` and that of `c94b578ec` hashes
`c3132b0085dfe3e4c02fb081ecd9694e3e30b76a`, in `madarch/catalog.yaml` and `madarch/plugins.lock`
(on `c94b578ec` the edge `product.uses-repository` carries `capability: disk`, a field of the
published contract). The publication reads the graph it is given and does not build the manifest, so
the two runs had been measuring reductions of two different starting graphs.

The box is `alx1788-perf` (`agent-linux-02`, 4 vCPU, 8 GiB, Bun 1.4.2), one revision per run, a
fresh store each, one process, `MADARCH_SKIP_PERF=1` and `MADARCH_OWN_WIKI=off`, each run standing in
a scope of the delegated `madarch.slice` — the slice the plugin sandbox needs. The bracket is
`publishValidatedManifests` alone; schema and store preparation and the reduction step are timed
separately. SQL statements are counted at the PostgreSQL client.

### One pinned input

One draft of the `everything` template was created once, at the #353 merge baseline `4316c762d`,
committed, and copied byte for byte into each run's products home, so both revisions publish the
same tree. Each run prints the input's hash at each publication:

| Input | `madarch` tree | `catalog.yaml` sha256 | `plugins.lock` sha256 | Working tree |
| --- | --- | --- | --- | --- |
| Initial, both revisions | `fba98bcfd7b1e1dffaa6e6279339f53c906a69c8` | `c61e1e8a780e5df7` | `39377b1a6e3169a4` | clean |
| Reduced, both revisions | `d65ac4f109d57ae9526f1072b628864105430390` | `db852f84b10aa568` | absent | clean |

The `sha256` column is the first 16 hex digits of the file's SHA-256 digest. Both runs printed the
same hashes, and each also printed `HEAD^:madarch` at the reduced publication, which equals the
initial tree above.

The pinned tree is the baseline's, and both revisions were checked against it before the pair ran:
each validates it and derives the same contract from it (144 vertices, 164 edges), which is what a
pair on one input needs. The newer template is not the pinned one because only its own revision has
produced it; the baseline's tree is the input both revisions were shown to read.

The pinned tree declares 144 kinds. The kept set is the plugin-free store fixture's six kinds —
`code.repository`, `code.directory`, `code.file`, `code.commit`, `code.author` and
`product-profile` — plus the first further kinds in catalogue-name order whose derivations reach
**49 declared kinds**: `accounting`, `activity`, `activity-node`, `business-process`,
`c4.component`, `chaos-experiment`, `code-convention`, `code.blob`, `code.broker`,
`code.ci-workflow` and the kinds they derive from, which the retained set names in full in the logs.
Exactly 95 of the 144 kinds are removed. The set is computed from the pinned tree, so both revisions
keep the same kinds, and both runs printed the same two retained lists.

The reduction is the store fixture's own pruning, applied to the larger retained set:
`scripts/clean-install-fixture.ts`'s `prepareStoreAcceptanceFixture` states the six kinds and the
field treatment, and the probe keeps the extra kinds with the same rules — relations, key-edge roles,
edges and semantic bindings that name a dropped kind go, and every kept field becomes a person's
write. The run commits the result (`Remove 95 starter kinds`) before publishing it, which is why the
reduced tree has a hash of its own.

### The pair

| Revision | Initial publication | SQL calls | Reduced publication | SQL calls | Reduced / initial |
| --- | ---: | ---: | ---: | ---: | ---: |
| `4316c762d` (#353 merge) | 17 182.6 ms | 196 | **411 799.0 ms** | 33 098 | 23.96× |
| `c94b578ec` (current `main`) | 18 595.3 ms | 186 | **14 086.3 ms** | 766 | 0.757× |

The reduced publication is **29.2 times faster** on current `main` than on the #353 merge (411.8 s
against 14.1 s), 97.7 % fewer SQL statements (766 against 33 098), and on `main` it costs 0.757 of
the initial publication — the exit criterion's "about what the initial publication costs". The
initial publication itself costs about the same on both revisions (18.6 s and 17.2 s, within the
box's run-to-run spread).

The graph counts match on both revisions at both publication sizes:

| Publication | Writes | Retirements | Nodes | Edges |
| --- | ---: | ---: | ---: | ---: |
| Initial | 6 164 | 0 | 9 600 | 36 155 |
| Reduced | 1 941 | 4 015 | 14 064 | 53 310 |

The recorded evidence is a comparison of the counts each publication wrote and of the input hashes
each run printed. The counts agree at both sizes, so neither revision wrote a different number of
records, retirements, nodes or edges. That is a match of counts, not an inspection of the full graph,
and it does not cover the starting state either — the pinned input is what fixes that.

Schema and store preparation sit outside the bracket: 10 095.5 ms and 2 220.0 ms on the baseline,
13 367.4 ms and 2 935.8 ms on `main` (initial and reduced), and the reduction step plus its commit
took 1 330.3 ms and 1 645.6 ms. The baseline run's wall clock was 05:15:52–05:23:49 UTC and the
`main` run's 05:23:56–05:25:28 UTC on 28 November; both exited 0.

### The earlier, unmatched pairs, kept with their difference

The first version of this record measured two pairs this way, each run building its own starter
tree, so their initial publications started from different graphs. They are kept as corroboration,
with that difference stated:

| Pair | Revision | Initial publication | SQL calls | Reduced publication | SQL calls | Revisions' starter trees |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 1 — the store fixture's own reduction, 138 of 144 kinds removed | `4316c762d` | 16 176.4 ms | 196 | 398 723.9 ms | 33 864 | `fba98bcf` |
| 1 | `c94b578ec` | 14 867.9 ms | 186 | 11 392.0 ms | 859 | `c3132b00` |
| 2 — exactly 95 kinds removed | `4316c762d` | 16 167.4 ms | 196 | 374 305.1 ms | 33 098 | `fba98bcf` |
| 2 | `c94b578ec` | 15 563.0 ms | 186 | 11 615.4 ms | 766 | `c3132b00` |

The hash `d65ac4f109d57ae9526f1072b628864105430390` belongs to the 95-kind reduction and its matched
rerun: both runs of the matched pair printed it at their reduced publication, and on both revisions.
Pair 2 removes exactly the same 95 kinds and keeps the same 49, and its own counts are the matched
pair's (1 941 writes and 4 015 retirements, 14 064 nodes and 53 310 edges), but its log prints no tree
hash, so the hash is claimed here for the matched rerun that recorded it and not for Pair 2. Pair 1 is
a different reduction — 138 of the 144 kinds removed, the fixture's six kept — so its reduced tree is
not the 49-kind result's: its graph is 1 470 writes and 4 486 retirements, 14 201 nodes and 52 802
edges. What both earlier pairs share with the matched pair is the direction and order of the times,
not a tree; that, rather than the reduction, is why only their starting state suffered from the
difference. Their times agree with the matched pair on order and direction: a reduced publication of
this catalogue costs about four hundred seconds on the #353 merge and about eleven to fourteen seconds
on current `main`.

### The upper bound the baseline needed

The original report is that this publication "had not finished after 120 s". It is now measured: on
the #353 merge the matched pair's reduced publication of 95 kinds takes **411.8 s** — 3.4 times the
120 s bound the clean-install walk named — and the earlier pair's 138-kind reduction 398.7 s. Both
runs finished inside the 900 s cap the harness was given (`timeout -k 10 900`), and neither hit it,
so these are complete measurements, not floors. On current `main` the same publications are 14.1 s and
11.4 s.

The independent 505 → 7 pair PR #358 measured (16.15 s initial, 15.63 s reduced, same box family)
stands beside these as the larger fixture's sample; the two agree on the order of a few seconds for
a reduced publication on current `main`.

## Where the probes and logs are

The two scripts are in box `alx1788-perf` at `/work/input/mkpinned.ts` and
`/work/input/probe-m95c.ts`, copied into each revision's checkout. They change nothing in the
repository, so they are not committed; the recipe below is what they do, with the repository's own
helpers.

```sh
# one pinned starter tree, created once in the baseline checkout
cd /work/base   # 4316c762d, clean
sudo -u box env HOME=/home/box.guest MADARCH_SKIP_PERF=1 MADARCH_OWN_WIKI=off \
  bun mkpinned.ts /work/pinned/everything

# one revision per run, fresh store and fresh copy of the pinned tree
timeout -k 10 900 /work/run-in-slice.sh m95cbase \
  "cd /work/base && HOME=/home/box.guest MADARCH_PLUGIN_CGROUP=/sys/fs/cgroup/madarch.slice \
   MADARCH_SKIP_PERF=1 MADARCH_OWN_WIKI=off \
   bun probe-m95c.ts /work/tmp/m95c-base /work/pinned/everything/catalog-profile-95"
timeout -k 10 900 /work/run-in-slice.sh m95cmain \
  "cd /work/m95 && HOME=/home/box.guest MADARCH_PLUGIN_CGROUP=/sys/fs/cgroup/madarch.slice \
   MADARCH_SKIP_PERF=1 MADARCH_OWN_WIKI=off \
   bun probe-m95c.ts /work/tmp/m95c-main /work/pinned/everything/catalog-profile-95"
```

The probe copies the pinned folder into its scratch products home (asserting a clean working tree and
printing the tree hash), validates it, prepares the store and publishes it inside the timed bracket,
reduces the catalogue with the rules above, commits it, prints the reduced tree hash, prepares and
publishes again, and prints the counters. `mkpinned.ts` creates the draft with
`createDraft({ template: 'everything', home, name: 'catalog-profile-95' })`, sets the identity,
commits, and copies the folder out of the products home.

The logs are `/work/reports/m95c-base.log` and `/work/reports/m95c-main.log`. The earlier pair's logs
are `/work/reports/m95-base.log`, `m95-main.log`, `m95b-base.log` and `m95b-main.log`, with their
probes at `/work/input/m95-profile.ts` and `/work/input/probe-m95b.ts`.

## What is left

1. **`test/agent-fill-e2e.test.ts`** keeps its entry, its `cases: 2` and its required job: its shard
   sample was 35 185 ms, above the bound, while its alone samples are inside it, and its acceptance
   as a separate required check is the decision in ALX-2061. The smallest next action, should the
   stage want it back in the shards, is a required run whose shard sample measures the file at or
   below 30 s; the file has no fixture to cut, so only a fall in its two agent fills' cost can
   produce it.
2. **The eight staying files** keep their jobs and their numbers; nothing about them is pending.
3. **The catalogue reduction** is measured on both revisions from one pinned input, at both sizes,
   and needs nothing.
