# The slow server and model cases run inside their bound, or name one on purpose

Change: slow-tests
Base: dbf138d80a8a83a4b60f691e39fd18ee369dcf14
Tasks: madarch-cznn
Kind: no-behavior

## Intent
The cases of the server, view and model-check test files that took 4.4-9.2 s on
GitHub's runners (test/server-graphs.test.ts, test/server-views.test.ts,
test/server-http.test.ts, test/server-sources.test.ts, test/views-one-view.test.ts,
test/views-likec4.test.ts, test/model-check-requirements.test.ts,
test/model-check-problems.test.ts) each take about a second or two again, and
the few whose work is genuinely long name their own bound in the test. No case
changes what it asserts: the same fixtures, the same expected values, the same
shapes under test.

## Rationale
The margin cost shard reruns (madarch-cznn): CI run 39171437383 failed shard 2 on
a case at 5 005 ms whose neighbours in the same block took 3.0-3.5 s, and the
same case timed out at 5 529 ms on the pod. Measured on the 2-CPU pod on
2026-10-20, the cause is the databases a case opens, not its assertions: one
PGlite instance is 1.66 s to boot (a bare `new PGlite()`; the adapters' schema
adds 0.07 s), and the slow cases opened two or three of them — two histories and
a query database, or a per-case history and a per-case query database beside the
server. `test/server-graphs.test.ts` went from 31 cases of 1.7-6.4 s (seven of
them over the pod's five seconds) to 31 cases of 1.65-2.5 s.

The suite-wide default of ten seconds does not carry these cases either:
measured the same day, `setDefaultTimeout` from the preload holds for a run of
one test file (a throwaway case sleeping 6 s passed three times in a row) and not
for every file of a run holding several (the same case was stopped at 5 000 ms
beside another test file), and CI shard run 39351539188 stopped a case with no
bound at 5 036 ms while its own file's cases naming 15 000 ran 5.9 s and passed.
A case whose work is long therefore names its bound.

## Out of scope
- The product code: no adapter, server or check changes. The per-row git reads
  inside the model check stay as they are; the case that meets them names a bound
  instead.
- The suite-wide default itself (madarch-tzte.36): it stays ten seconds, and its
  measurement now says what it does and does not reach.
- The cases that already name their own bound and stay long by design (the
  fill-crash suite, the wiki builds, the reference system's LikeC4 walks).

## Changes to requirements
None. This change touches tests only; every requirement they cover keeps its
behaviour and its expected values.

## Preserved contracts
- graph-queries/rebuild: one owner per case, lent to its history and its query database; the cases still build from the history and still answer from a rebuilt projection
- server/store: the server still stores and restarts on its own data folder; the cases still send real requests to a server started per case
- server/identities: a source keeps its id across sends and a restart (the case keeps its restart)
- server/sources: the listing after a stop and a new start is unchanged
- server/view: the answers compared against an independently built engine are byte-identical, and the comparison still asks an engine of its own
- views/one-view: the one-view answers and their expected texts are unchanged
- views/likec4: the workspaces are still validated by the pinned likec4 itself
- model-check/requirements-resolve: each fence sub-case keeps its own repository, expected report and message, now as a test of its own
- model-check/problems: the hub case keeps its eleven elements and ten relations

## Coverage
- graph-queries/rebuild: test
- server/store: test
- server/identities: test
- server/sources: test
- server/view: test
- views/one-view: test
- views/likec4: test
- model-check/requirements-resolve: test
- model-check/problems: test

## Design and decisions
- One database per case, shared by its ports (decision 0027's shape): a case
  opens `createPGliteDatabaseOwner({ vector: true })` and lends it to
  `createPGliteHistory({ owner, clock })` and
  `createPGliteQueryDatabase({ owner, clock })`, closing it in `afterEach`. A
  case that needs two histories opens a second owner, because one database holds
  one history — the union and clash cases of test/server-graphs.test.ts, which
  therefore name their own 20 s bound (measured 3.4-5.1 s).
- A bound is named where the work itself is long: two source databases, the real
  `likec4` validator on a node process, or the model check reading a repository
  of many evidence rows.
- Measured before and after on the 2-CPU pod, with the same command per file.

## Acceptance evidence
Measured on the 2-CPU SkyPilot pod, 2026-10-20, per file, before and after
(`madarch-sky-test --cmd`, the same command both ways; "stopped" is bun's
five-second stop of a case with no bound of its own):

- test/server-graphs.test.ts: 31 cases of 1.7-6.4 s, seven of them stopped, file
  about 143 s — 31 cases of 1.65-2.5 s, the two-source cases 3.4-5.1 s under
  their own 20 s bound, file 73.7 s, 31 pass.
- test/server-views.test.ts and test/server-http.test.ts: 71 cases, 254.6 s with
  one stopped at 5 932 ms — 71 pass, file pair 132.8 s, the longest case 8.4 s
  under its own bound (three renders), the median 2.2 s.
- test/views.test.ts: 35 pass, file 27.5 s (its slowest case was 4.05 s on CI).
- test/views-one-view.test.ts: 24 pass, file 36.3 s against 60.9 s before.
- test/views-likec4.test.ts: the case that validates with the real likec4 at
  5.0 s on the pod under its own 15 s bound (4.8 s on CI).
- test/model-check-requirements.test.ts: the fence cases stopped at 5 332 and
  5 026 ms — six tests of their own, 2.1-3.1 s each.
- test/model-check-problems.test.ts: the hub at 6.4 s on the pod and the
  shallow-clone cases at 4.1-5.2 s, under their own 20 s bound; 44 pass across
  the two model-check files.

The whole set of changed files: 282 cases, all passing on the pod, and `bun run
check` clean with them. CI on the pushed revision is the gate.

## DONE WHEN
Every case of the files above runs in about two seconds on the 2-CPU pod, or
names its own bound with the measurement that justifies it, `bun run check`
passes, and CI is green on the pushed revision.
