# Repository facts come from ordinary disk and git plugins

Change: madarch-64o5.40
Base: 0148a638fa234accc37a871416f954d4ae3bcf15
Tasks: madarch-64o5.28
Kind: behavior

## Intent

Replace native repository-tree and history graph producers with ordinary disk
and git plugins. A fresh starter product ships both. Plugin declarations alone
select and order repository fact work. Files and Commits both require the
declared disk/git closure when current file keys include git history refinement. The engine hosts plugins and publishes their opinions but does not walk a
repository tree or interpret Git history to feed the graph.

## Out of scope

Real agent/model execution; unrelated agent-producer admission policy; changing
timeouts or performance bounds; reader exceptions for native kind names;
weakening any of the twelve madarch-64o5.28 contract rules; owner approval;
tracker closure or landing this branch.

## Rationale

The disk/git example in madarch-64o5.28 remained only an ordering example while
native foundational stages still populated the graph. Moving interpretation
inside ordinary plugins makes the selected work match the declarations and
removes a second graph-writing route. This forward-port starts at owner-pinned HEAD 6d19ce48 on
fix/madarch-64o5.30-28. Saved a2b0a60c is a source reference only; its
older planner and all-output grouping are not carried forward. This proposal
does not assert an approval receipt.

## Changes to requirements

- repository-fact-plugins/producers: add ordinary disk and git plugins with output-specific declarations, shipped by the starter.
- repository-fact-plugins/selection: add declaration-only Files and Commits selection and ordering.
- repository-fact-plugins/publication: add ordinary typed-opinion publication and generic readback without native interpretation.
- repository-fact-plugins/regression: add fixture-only regression and unchanged-workload speed evidence.
- fill-history/stage: replace the native registered history stage with the ordinary git plugin.
- fill-history/reads: replace native snapshot/fact SQL inputs with declared disk output reads and generic opinion publication.

- fill-history/ancestry: replace native stage wording while retaining the required history behavior through the git plugin.
- fill-history/task-keys: replace native stage wording while retaining the required history behavior through the git plugin.
- fill-history/incremental: replace native stage wording while retaining the required history behavior through the git plugin.
- fill-history/bound: replace native stage wording while retaining the required history behavior through the git plugin.
- fill-history/gaps: replace native stage wording while retaining the required history behavior through the git plugin.
Complete proposed capabilities: `capabilities/repository-fact-plugins.md` and
`capabilities/fill-history.md`.

## Preserved contracts

- fill-stages/graph: derive producer ordering from declarations rather than an engine-defined plugin category.
- fill-stages/starvation: refuse missing enabled prerequisites instead of silently omitting selected work.
- fill-orchestrator/plan: retain the orchestrator's stage registration and admission contract for runnable plugin work.


## Coverage

- fill-stages/graph: static, test, mutation, review
- fill-stages/starvation: static, test, mutation, review
- fill-orchestrator/plan: static, test, mutation, review
- repository-fact-plugins/producers: static, test, mutation, review
- repository-fact-plugins/selection: static, test, mutation, review
- repository-fact-plugins/publication: static, test, mutation, review
- repository-fact-plugins/regression: static, test, mutation, review
- repository-fact-plugins/partitions: static, test, mutation, review

- fill-history/stage: static, test, mutation, review
- fill-history/reads: static, test, mutation, review
- fill-history/ancestry: static, test, mutation, review
- fill-history/task-keys: static, test, mutation, review
- fill-history/incremental: static, test, mutation, review
- fill-history/bound: static, test, mutation, review
- fill-history/gaps: static, test, mutation, review

## Where it is seen

Kind: command
Place: A fresh starter product, madarch fill --entity KIND, and the product wiki kind pages

1. Create a starter product and inspect its declared disk and git plugins.
2. Select Files through the CLI or wiki; inspect the planned producer names and run the fill.
3. Read Files and Folders from the published plugin opinions.
4. Select Commits; observe disk completing before git, then read Commits, Authors and history.
5. Disable a required producer and request its output; observe a refusal before run acceptance rather than native fallback.

## Blocking questions

None.

## Design and decisions

Disk owns repository/tree interpretation. Git reads disk's declared output
and owns commit, author and history interpretation. Both are ordinary plugins
with plugin-and-kind scoped units, output-specific reads/fields and enforced
selected scope. Multiple entries remain one plugin identity, not one invocation
allowed to write all its outputs. Files selects its prerequisite closure only;
Commits selects its prerequisite closure and waits for successful disk units. Any low-level host facilities remain generic and do not turn tree
entries or Git records into graph facts. Existing .28/.30 declaration,
refinement, source-preservation and prerequisite rules remain applicable; all twelve
rules of .28 contract.md remain normative. Append-only integration notes do not
replace historical evidence.

### Canonical identity and host rights

Repository storage and all reads/writes use ordinary declared `code.*` kinds.
There are no native read/write aliases, dual identities, fallback writers or
native prerequisite exemptions. All existing typed fields, source/evidence and
retained history must survive. Generic host facilities expose read-only pinned
repository inputs and declared executable/tool rights, not graph interpretation.
Delete native tree/history stages and their publication path.

## Acceptance evidence

Pending. Red-first results, final checks, mutation/review findings and the same
training-workload speed measurement must be recorded against their actual
inputs. No real agent or model is used. No timeout or performance bound is
increased. No pending or skipped check is claimed as passed.

## DONE WHEN

A fresh starter ships ordinary disk and git producers. Files and Commits run
their declared disk/git prerequisite closure without an agent requirement
introduced by either deterministic producer. Their published data is readable
through the generic opinion readers. Native tree/history graph producers and
engine interpretation feeding the graph are absent. Fixture regressions and
the unchanged training workload provide actual evidence, with any remaining
blockers reported explicitly.


### Owner integration clarification: historical file identity

Historical file identity must be retained without an `ensureVertex` exception.
Git's ordinary `code.file` key output explicitly refines disk's key output.
Consequently Files requesting latest keys requires git as well as disk; the
previous disk-only Files expectation is superseded. The .28 rule retaining all
required current producers applies: no automatic downstream-refiner exemption,
unselected write permission or native historical-file identity path is added.
This is declaration-driven deterministic work and still requires no agent.
Source 6e7984f3 declares the refinement; this note records its contract consequence.

The shared schema revision changes from 5 to 6 for this storage migration.
The release-platform trusted Git pin digest is
`eb54b535467e0975c1284d4c4d08eea779aeb248a5d34b02e2ee171382e22201`.
These are declared migration/tool constants, not relaxed performance bounds.

### Coordinator-reported baseline evidence

The parent reports a completed internal-native before run of 10.444655832 seconds,
114 files, 583054 bytes, 72 commits and 55 directories at pinned revision
`0657ebc0eb2b0fcf4f5364976f8e3eae0a41d42e`.
Actual evidence: `/tmp/m28-before-valid/before.json`.
The after measurement and comparable before/after analysis remain pending.
This baseline is not a whole-suite-green, migration-completion or approval claim.


### Partial validation reported by coordinator

The fifth root check completed successfully: `/tmp/m28-check-fifth.log`, all six
checks exit 0. The existing 18 architecture baseline findings are unchanged.
Additional focused results reported by the coordinator are pure tests 24 passes /
69 assertions and chunk tests 5 passes / 17 assertions. These are partial results,
not acceptance or a whole-suite-green claim.

Whole validation remains blocked by glossary publication exceeding the unchanged
8 MiB cap: the measured canonical payload is 13.58 MB. The cap must not be raised
and facts, fields, evidence, identities and assertions must not be removed to fit.
The required design direction is ordinary plugin output partitioning under the
same generic publication contract, not a glossary/native special path. Partition
boundaries must preserve selected kind/field scope, dependency success gating,
producer-scoped atomic replacement/retraction and retained run/version evidence.
A transport partition is not independent successful completion of a partial
invocation. Runtime partition implementation and its validation are pending;
this record does not claim the oversized workload is repaired.


### Further partial validation reported by coordinator

Root check six exited 0 across all six checks in 84.2 seconds:
`/tmp/m28-check-sixth.log`. It ran before the latest test and reader commits;
the existing 18 architecture baseline findings remain unchanged. This result
must not be attributed to source committed after that run.

Partition regressions reported 0 passes / 5 failures. In focused execution all
three bounded 3 MiB child drafts passed, but the aggregate barrier failed:
post-publication store retention pruned opaque `plugin-partition` data through
`retainedProducerOutcomes` draft update and part deletion. The engine worker is
repairing retention of immutable partition and aggregate snapshots. The focused
child results do not establish complete-barrier success. No bound was changed.

Graph batch two reported 18 passes / 15 failures, followed by canonical-import
and midflight-declaration repairs. Batch three reported 34 passes / 3 failures.
Reader N+1 repair is source `3d9ddc9e`; historical replay test expectation repair
is `b0b8725d`. These source changes are not passing rerun evidence: reruns remain
pending. Whole-suite green and after-training timing remain unestablished.


### Partition and reader rerun evidence reported by coordinator

The complete partition regression run passed: 5 cases / 32 assertions in
119.93 seconds, `/tmp/m28-partitions-sixth.log`, after `5aa0cb02`, `8a41360e`
and `41cea5de`. It verified aggregate content over 9 MiB through bounded units,
prior-fact retention, dependent blocking, immutable first-generation reads and
successful empty retraction. The negative partition case verified the actual
refusal cause and attempted out-of-key write, not an unrelated prior-run block.
These results supersede the earlier partition failures for that tested revision,
without erasing those observations.

Latest pure tests passed 28 cases / 84 assertions. The reader relation regression
passed 1 case / 9 assertions with an actual three-SQL-query bound. Root check
seven encountered a TypeScript test-type failure; repair `ec74dd30` is committed
and root check eight is running, not yet a passing result. The parent's fourth
full six-case glossary run is also in progress (`/tmp/m28-glossary-fourth.log`).
No after-training timing or acceptance result is available. Whole-suite green
remains unestablished; no pending run is recorded as passed.


### Root check eight and remaining partition capacity issue

The coordinator reports root check eight green: all six checks in 71.89 seconds,
with the same 18 architecture baseline findings. The fourth glossary run's
first three cases failed with the same 15 requested children exceeding the
unchanged fanout of 8 (`/tmp/m28-glossary-fourth.log`); its remaining three cases
are still running. No whole-suite or acceptance result follows from root checks.

The approved generic remedy uses a bounded partition tree within existing
fanout 8 and maximum depth 3, at most 512 leaves, not unlimited capacity. Opaque
branches retain immutable partition references; leaves retain keys/writes. Only
the root aggregate publishes and snapshots recursively read successful exact
references. Runtime and graph edits are prepared but source commits are held
until the active PostgreSQL validation settles. Implementation/rerun evidence
is therefore pending. The engine fixture is to use nine keys of exactly 1 MiB
each, over 8 MiB in aggregate, to exercise fanout causally without weakening
assertions or changing bounds/timeouts. No child checks or runtime edits were
performed to record this clarification; after timing remains pending.


### Benchmark comparability audit and settled glossary run

Source audit `/tmp/m28-benchmark-comparability-audit.md` establishes that the
actual before and planned ordinary-plugin after have unequal total workloads.
The valid internal-native before remains 10.444655832 seconds, excluding
24.981595683 seconds of setup. Its training pin and facts are unchanged, but its
whole graph contains 117 files, 73 commits, 57 directories and two repositories:
the training repository plus a small manual product repository. It is an internal
native-pipeline measurement, not public starter admission success.

The ordinary-plugin product adds starter manifests and plugin closures. A
read-only filesystem inventory, not an independently verified pinned-tree count,
finds 2,165 regular product files / 13,086,460 bytes, excluding `.git` and the
`repos` link, in addition to the fixed training input. Disabling unrelated
producers does not remove their copied input files. The failed after artifact
at `/tmp/m28-after-valid/after.json` (86.467040113 seconds, zero training facts)
is not a valid successful after measurement. Its old ratio is not a performance
conclusion; the benchmark script now explicitly records unequal total workloads.

Training source is held fixed, but the ordinary-plugin product includes
additional closure/manifest files. These are integration timings for unequal
total input workloads, not an apples-to-apples speedup or slowdown estimate.
A valid after integration result still requires successful publication and exact
training facts, plus honest total/product counts. A controlled comparison needs
a new paired experiment with equal pinned trees, histories, publication scope,
workers and timing boundary; it cannot retroactively relabel the actual before.
No controlled speedup or slowdown is established.

Glossary run four settled at six failures in 267.11 seconds, all the same
15-children-over-8 fanout failure. Nested graph support `860b2ae5` and causal
nine-key test `44774579` are committed; runtime integration and rerun evidence
remain pending. These source commits do not prove repair or acceptance.


### Nested partition rerun evidence

The coordinator reports partition run seven green: all five cases / 44 assertions
in 207.69 seconds, `/tmp/m28-partitions-seventh.log`. This run exercises the
causal nine-key nested partition fixture across all five cases under unchanged
fanout, depth, unit and message limits. It supplies actual passing nested-runtime
evidence, unlike the earlier source-only support and failed fanout runs.
Static root check nine is also green with the existing 18 architecture baseline
findings unchanged.

The fifth glossary run is now the serialized PostgreSQL validation in progress
(`/tmp/m28-glossary-fifth.log`); source changes are held during that run.
Its result, a successful after integration timing and whole-suite acceptance
remain pending. Nested partition success is not a claim that those pending
validations passed, nor a controlled performance comparison.


### Glossary five diagnostic outcome

The fifth glossary run was cancelled and settled at exit -15 after its first
case failed at 210.5 seconds. It was not a completed six-failure run. Real-data
disk output now passed nested fanout; the new failure was git's `code.file`
`graph.files` input being unable to serve the required immutable earlier snapshot.
This does not justify substituting latest values for explicit earlier reads.

The coordinator released the source hold for a generic `files(pattern, snapshot?)`
implementation that reads actual captured root partition references, with no
latest-value fallback. Runtime/graph implementation and rerun evidence remain
pending. No successful after timing or acceptance result is available.


### Snapshot read validation and glossary six diagnostic

The coordinator reports pure snapshot tests green: 29 cases / 88 assertions in
7.43 seconds, `/tmp/m28-pure-snapshots-third.log`. Root check ten passed all six
checks with the existing 18 architecture baseline findings unchanged.

The sixth glossary run was focused on its first case: one failure, five filtered,
272.56 seconds, `/tmp/m28-glossary-sixth-first.log`. Git's explicit earlier file
read now passed. The new failure occurred in git commit's latest `graph.files`
read: an optional undefined second argument serialized as null, causing a
`snapshot.runId` crash. Runtime repair is to omit trailing undefined arguments
from serialization, including the existing fourth-argument `value` pitfall;
implementation/rerun evidence is pending. No latest-value substitution for an
earlier read is authorized by that transport repair.

The enumeration assertion added in `ce85d0a2` has not yet been PostgreSQL-validated.
A focused named-earlier regression is next before another full glossary run.
No successful after timing, whole-suite green or acceptance is established.


### Immutable enumeration PostgreSQL validation

The focused immutable enumeration regression passed: one case / 14 assertions
in 31.85 seconds, `/tmp/m28-partitions-eighth-snapshot.log`. This validates
`ce85d0a2` and `bbd55858`, including all nine earlier values after later
publication, and supersedes the previous unvalidated-assertion status.

Optional-argument runtime repair `fde5dcd7` is committed; the parent's fourth
pure-access run is in progress, not yet passing evidence. Glossary seven is
focused on its first case (`/tmp/m28-glossary-seventh-first.log`) with source
held stable during the run. Its result, successful after timing and acceptance
remain pending. No child checks or PostgreSQL commands were used for this record.


### Focused glossary and optional-argument transport results

Glossary seven's focused first case passed after `fde5dcd7`: one pass / one
assertion, five filtered, 290.07 seconds overall and 280.72 seconds for the case,
`/tmp/m28-glossary-seventh-first.log`. The existing 300-second bound is unchanged.
This is focused success, not the result of all six cases; the narrow remaining
time margin is a performance risk requiring causal optimization, not a bound
increase.

Pure access tests passed 10 cases / 29 assertions in 882 ms,
`/tmp/m28-pure-access-fourth.log`, including actual transport with the optional
argument absent. Full glossary run eight (`/tmp/m28-glossary-eighth-full.log`)
and static check eleven are active with source held stable. Their results remain
pending. A fresh after integration timing and then the whole 249-test suite are
planned, not completed evidence. No acceptance or controlled speed comparison
is established by these focused passes.


### Full glossary eight result and fresh after timing in progress

The coordinator reports full glossary eight settled at one pass, six failures
and one error. The second case hit the unchanged 300-second timeout; later
busy-run failures cascaded from that timeout. The earlier focused first-case
pass therefore does not establish a green full glossary run. Static check eleven
passed in 70.79 seconds; static success does not resolve those runtime failures.

A fresh ordinary-plugin after integration run is active in
`/tmp/m28-after-second-valid`, log `/tmp/m28-after-second.log`, with source held
stable. It measures actual current training publication before performance
optimizations so wall cost can be explained from observed work. It has not yet
produced a valid completed after result. Performance audit may read source and
plan, but no implementation changes are authorized while this run is active.
The unequal-total-workload comparison caveat remains mandatory. Whole-suite
green, successful after timing and acceptance remain pending.


### Successful ordinary-plugin after integration timing

The coordinator reports a successful completed after run at
`/tmp/m28-after-second-valid/after.json`: 298543.051 ms (298.543051 seconds),
`result.ok`, succeeded and settled true. The retained training pin is
`0657ebc0eb2b0fcf4f5364976f8e3eae0a41d42e`; readback verifies exactly 114 training
files, 583054 bytes, 72 commits and 55 directories, with shallow false.
Whole graph totals are 2282 `code.file` identities, 148 directories, 73 commits,
four authors, two repositories and zero gitlinks.

This is valid integration timing and training fact evidence, not a controlled
before/after performance estimate. The native before has 117 total file
identities versus 2282 after: the after graph includes 2168 product identities
alongside 114 training files. Graph identity counts may include historical keys;
a pinned-tree audit is still needed before calling those product identities a
current-tree file count. Product trees differ substantially. No speed ratio,
controlled speedup/slowdown or acceptance is claimed.

Runtime source audit of the full-glossary timeout found that a query answerer
was recreated per query, so repeated key/field reads reloaded the root and all
15 immutable partitions (about 13 MB). The approved repair direction is a
fill-scoped immutable-snapshot cache, never a cache of mutable current values,
plus path-selected disk and selected-output git read optimization. The source
hold is released with no PostgreSQL run active; implementation and validation
of these optimizations remain pending. Whole-suite green remains unresolved.


### Graph validation and committed read optimizations

The coordinator reports remaining focused graph coverage green: 16 cases /
130 assertions in 27.61 seconds, `/tmp/m28-graph-fourth-focused.log`. Coverage
includes historical replay through actual readers, one-schema behavior and the
three-SQL relation bound.

Immutable snapshot cache `655e31f4` and plugin read optimization `1a85667a` are
committed. The generic cache is fresh per reader/transaction and keyed by exact
snapshot plus kind; mutable current values are not cached. A causal test checks
that the actual helper loads once while a fresh reader reloads. Full glossary
nine (`/tmp/m28-glossary-ninth-full.log`), root check twelve and pure run five
are active with source held stable; their results are pending.

The successful 298.543051-second after integration timing remains valid for its
pre-optimization source. It is not final-source performance evidence for these
new commits; a fresh after run is needed to measure their actual effect. The
unequal-total-workload caveat and unresolved whole-suite acceptance remain.


### Delivery evidence and remaining gaps — source 4d482a87

The final focused glossary run is green: two passes, four filtered, zero failures,
18 assertions in 372.11 seconds (`/tmp/m28-glossary-eleventh-first-two.log`).
The first case took 166571.92 ms and the second 194528.58 ms, under unchanged
bounds. The exact one-journal assertion and all exercised listing, page and
request assertions passed. Static check twenty passed all six gates with the
same 18 architecture baseline findings. The concurrent sequence regression
passed one case / eight assertions in 12.11 seconds. These are the final focused
results for source `4d482a87`, not a claim that all six glossary cases passed.

The other four glossary cases are unverified on this source. Previous full run
ten settled at two passes, four failures and one error, 13 assertions in
987.44 seconds, with a third-case timeout and cascading busy-run failures.
The generic read/event repair preserves trace/read membership and locks while
reducing the path from six SQL statements in two write transactions to four
statements in the same two transactions. This is a source-level SQL reduction,
not a measured wall-time speedup or changed constant. No assertion, timeout or
performance bound was weakened.

### Incomplete whole-suite run — retained failures, not acceptance

The 249-file suite attempt at clean `2f59d09e` settled exit 143 after 658.19195
seconds with only 17 file headers loaded. The parent did not explicitly kill it;
the signal cause is unproven. There are no completed suite totals. Evidence is
`/tmp/m28-full-suite-final-root.log` and
`/tmp/m28-full-suite-final-incomplete-note.md`. Recorded unresolved observations:

- `test/mcp-records.test.ts`: unnamed hook timeout, 120005.21 ms.
- `test/graph-records.test.ts`: unnamed hook timeout, 5004.89 ms.
- `test/product-daemon.test.ts:185` and `:204`: preparation socket failures;
  doubled-slash case 7506.25 ms against 5000 ms and showcase hook 10029.61 ms.
- `test/product-daemon.test.ts:218`: products-home redirect expected 302, got 200.
  Root-route hook failed at 18712.25 ms; daemon free-port case at 5391.17 ms
  against 5000 ms.
- `test/fill-updates-run.test.ts:113`: no expected watcher update run,
  287794.94 ms.
- `test/product-cli.test.ts:454` and `:487`: subprocess status null rather than 0;
  init cases timed out at 5406.35 and 5405.92 ms against 5000 ms. Line 454 also
  appears as an unhandled error between tests.

These observations have not been proved repaired by the focused glossary run.
Earlier root/mixed-environment attempts are retained as invalid environment
runs, not production regression or passing aggregate evidence. Correctly
isolated coverage includes CLI 13/39, scenarios/lifecycle 5/56 (pre-batch source),
enforced-host 47/180, and graph eight 39/219. None substitutes for the incomplete
whole suite. The owner delegates remaining broad validation to CI; no further
broad run is required for this delivery, and no full-suite acceptance is claimed.

### Timing boundary and delivery status

The actual native before remains 10.444655832 seconds. The valid ordinary-plugin
after remains 298.543051 seconds with exact training facts, but it predates final
batch/cache/read-event changes. Total product input workloads differ, so no
ratio, controlled speedup/slowdown or final-source performance result is claimed.
A new equal-workload paired experiment is still required for a controlled
comparison. This bundle delivers the migration and focused validation with the
remaining runtime/CI and measurement gaps explicit; it is not an all-green
acceptance or process-approval receipt.
