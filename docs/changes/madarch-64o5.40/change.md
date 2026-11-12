# Repository facts come from ordinary disk and git plugins

Change: madarch-64o5.40
Base: 6d19ce48
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

## Canonical identity and host rights

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


## Owner integration clarification: historical file identity

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

## Coordinator-reported baseline evidence

The parent reports a completed internal-native before run of 10.444655832 seconds,
114 files, 583054 bytes, 72 commits and 55 directories at pinned revision
`0657ebc0eb2b0fcf4f5364976f8e3eae0a41d42e`.
Actual evidence: `/tmp/m28-before-valid/before.json`.
The after measurement and comparable before/after analysis remain pending.
This baseline is not a whole-suite-green, migration-completion or approval claim.


## Partial validation reported by coordinator

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


## Further partial validation reported by coordinator

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


## Partition and reader rerun evidence reported by coordinator

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


## Root check eight and remaining partition capacity issue

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


## Benchmark comparability audit and settled glossary run

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


## Nested partition rerun evidence

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


## Glossary five diagnostic outcome

The fifth glossary run was cancelled and settled at exit -15 after its first
case failed at 210.5 seconds. It was not a completed six-failure run. Real-data
disk output now passed nested fanout; the new failure was git's `code.file`
`graph.files` input being unable to serve the required immutable earlier snapshot.
This does not justify substituting latest values for explicit earlier reads.

The coordinator released the source hold for a generic `files(pattern, snapshot?)`
implementation that reads actual captured root partition references, with no
latest-value fallback. Runtime/graph implementation and rerun evidence remain
pending. No successful after timing or acceptance result is available.
