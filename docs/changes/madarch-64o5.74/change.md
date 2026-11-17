# Atomic graph storage cutover

Change: madarch-64o5.74
Base: 46de49f39b3a622a92dcf2f8cd3e0a357338821b
Tasks: madarch-64o5.74, madarch-64o5.141
Kind: behavior

## Intent
Replace the old graph storage and every dependent reader in one atomic cutover against origin/foundation/madarch-64o5.141. The base supplies reusable value types, the catalogue changes and additive assertion prerequisites. Decision 0039 governs references as edges, parent-edge identity, typed per-source assertions, lineage, valid and recorded time, and value-pinned disputes and resolutions. There is no supported intermediate storage shape, retired API alias or wide-row read projection.

This change is work in progress and unaccepted. The working tree contains the whole cutover; neither this record nor earlier targeted checks establish final acceptance. The proposed graph-storage capability specifies endpoint checks, item-25 assertion selection, writer-owned judgements and the two-query page budget. Whole-cutover acceptance still includes the remaining surface below.

## Out of scope
- Migration of existing product data: current products are refilled after the cutover, rather than migrated from retired storage.
- Cross-server federation transport, onboarding and completeness scoring.
- Exhaustive graph filling, a real agent run or a production fill as part of preparing this record.

References, parent keys, assertion storage, source grants, immediate-operation receipts and fencing, disputes, mentions, catalogue relations and replacement readers are not deferred out of this atomic change.

## Preserved contracts
None.

## Coverage
- graph-storage/edge-endpoints: test, mutation
- graph-storage/assertion-selection: static, test, mutation, review
- graph-storage/writer-judgements: static, test, mutation, review
- graph-storage/page-query-budget: static, test, mutation, review

## Where it is seen
Kind: request
Place: The graph API and MCP read/write commands, and the wiki pages that read the same graph.
- Write a declared entity with its required parent edges, typed values and evidence through an authenticated producer.
- Observe immediate accepted facts with assertion source, author, operation, valid and recorded time, and evidence; malformed input or an unauthorised grant is refused atomically.
- Read the entity and its relations, filters, ordering and counts through the same effective assertion selection.
- Compare disagreeing source values, resolve a question, then repeat an observation or change its value or justification and inspect whether the resolution still applies.
- Write explicit mention tokens or plain entity names and inspect checked backlinks or non-binding candidate hints.

## Blocking questions
None.

## Design and decisions
The remaining issues are implementation and validation blockers under the recorded design, not unresolved owner choices.

- References are declared graph edges. Required parent edges and the entity's own typed scalar keys determine identity; parent deletion policy and final effective cardinality are checked as one operation.
- Every writer door requires a real opaque, host-issued ProducerBinding, not structural WriteSource principal metadata or a serialized copy. Its retained principal, source, product, context, contract, action and graph scope constrain admission. Descriptive producer scope is separate from the permission scope; activation must not silently widen either.
- Scalar keys are typed assertions with ordinary source, author, evidence, operation and mention ownership. Immutable identity requires those values to agree with the canonical birth tuple; a changed key creates a new identity. node.key is not a fallback source of facts. Any identity lookup projection must be checked and rebuildable from statements.
- Assertions retain typed values, source streams, valid intervals, recorded sequence and context-parent cutoffs. Readers select the same current values and relations; disagreement does not by itself replace the displayed value with null. Semantic resolution pins survive repeated equal observations but not changed values, scope or invalid justification.
- SQL admission and deferred constraints select existence directly from typed assertions under item 25, including recursive parent cutoffs. There is no dispute-selection projection or refresh API. Scalar false values and missing required relations are enforced by final constraints, not only hidden by a reader.
- The catalogue and shipped producers publish relations as edges; replacement readers traverse those edges. Mentions use the declared token grammar and assertion-owned occurrences; plain names return hints, not guessed edges.
- The root lockfile's 591 resolved dependency URLs were normalized to the public registry under the owner's 2026-11-16 rule. This does not authorize dependency-version changes or private registry references.
- Test bounds are not raised to make this cutover pass. The new bounded 100-entry metadata regression must demonstrate that metadata queries remain bounded rather than conceal work behind a larger timeout.

## Acceptance evidence

### ALX-101: one protected workflow-stage parent (0039 item 9)
The duplicate catalogue stage and `workflow-stages` edge are removed. Manifest
joining reuses `inheritProtectedContract`; catalogue validation refuses protected
names without explicit inheritance and required edges on protected YAML ends.
The catalogue's `operation` declaration now explicitly inherits its system base;
no reader-facing kind is removed there. Catalogue count is 500, down from 501.
The exact endpoint-pair count is 265, down from 266 solely because the duplicate
edge is removed; all pair-set equality and full-starter assertions remain.

This increment is **blocked**, not accepted: repeat publication still exceeds
its unchanged 300-second bound. The protected stage publication regression passes
unchanged, but the separate startup-binding case exceeded its 10-second bound.
A read-only review also found that explicit manifest nullable extensions parse
but contract generation loses inherited key/capability, and that protected edge
extensions are refused even with explicit inheritance. These remain unresolved;
no claim of complete extension support is made. No forbidden core file, table,
budget or timeout is changed. The ALX-101 hand-in records full per-file results.
This existing coverage entry is narrower than the whole cutover. Complete capability requirements and their coverage, current-revision checks and stage acceptance remain owed; the entry must not be read as coverage of all decision 0039 requirements.

### Current status: unaccepted work in progress
The atomic cutover is preserved in normal hooked local checkpoint commits, beginning with merge checkpoint a699a96a against f438fd54. No reset, discarded recovery stash, hook bypass, task closure or acceptance approval is claimed.

Current integration evidence (2026-11-16):
- Root `bun run check` run 34 passed: TypeScript, architecture 874/874, UI 0, catalogue 501 kinds/117 page-or-member kinds, four workflows and zero quarantined cases. The required-base architecture comparison has 1,241 entries; the current baseline gains zero entries.
- All 312 original root test files were attempted serially in fresh `bun --smol test <file>` processes: 215 files exited zero, 97 exited nonzero, including four processes killed with exit 137. The logs report 2,144 passing and 313 failing cases; timeout and cleanup cascades mean those are not counts of independent defects. This pass spans checkpoint changes and is not a passing suite of the final revision. The preceding single-process whole-suite attempt was killed by earlyoom and is incomplete.
- Current focused disputes, immutable scalar keys and public resolution coverage passed 9 tests and 106 assertions. Late-write forced constraints and savepoint rollback remain covered. Architecture gates passed 38 tests; strict record selectors passed six tests; subject/source/author/operation lineage passed three tests.
- The wiki app's full native suite passed 124 tests with 587 assertions; its check and build passed. These do not establish root-suite acceptance.
- The path registry now accepts valid POSIX whitespace while rejecting NUL, empty and non-string values; its native regression passed. Original relation, disk and fill time limits were not raised.

Known blockers remain:
- The original two-pass Git-fill case still times out at 120 seconds. A persisted first-fill trace recorded about 79,000 SQL statements; repeated metadata selection and forced constraints dominate aggregate span time. Batching preserves sequence allocation and rollback in two focused passing tests but has not solved this bound. Many full-catalogue fills also fail with stale queue attempts or excessive memory.
- A faithful schema-reader fixture now fails explicitly because forced migration blocks on the reader-held typed key table. It no longer hangs while waiting for a removed dictionary table.
- Canonical typed reader pagination does not meet its unchanged two/one-query budgets. Evidence fixtures, public identity/naming paths, internal lineage visibility, cancellation journaling and remaining failed integration fixtures still require work. No alternate resolver, hidden pre-query work, retired table or weaker assertion was introduced to make them pass.
- Consistency atomic/hook limits, a clean final-revision root suite, current-source mutation coverage, whole-cutover capability coverage, independent review and stage acceptance remain owed. Historical mutation survivors and unrun scopes remain gaps, not acceptance evidence.

Detailed per-file results, focused reruns, diagnostic reports, patch application proof and the exact delivered revision are retained with the patch series in `/tmp/madarch-64o5.74-patch-series`. The tracker-free document check still reports missing task/approval records; none is fabricated.

### Historical endpoint increment only
The following results belong to the earlier endpoint-only increment, not the present whole cutover or its current revision:
- Bun 1.4.2; PostgreSQL suites ran as an ordinary non-root account.
- bun run check passed with 1,229 then-listed architecture findings and no added debt.
- bun test test/graph-edge-endpoints.test.ts test/graph-write.test.ts test/plugin-agent-reference.test.ts reported 44 passed, zero failed and 202 assertions.
- wiki/app frozen install, check and tests reported 129 passed tests, zero failures and 622 assertions.
- Four bounded manual mutations disabled the declared-kind, uid-kind, context and removed-end guards individually; each failed the endpoint suite and was restored.

These historical results must not be reused as current acceptance receipts. Full backend suites, full-cutover mutation evidence and final stage acceptance were not established by that endpoint increment.


### ALX-39 binding amendment follow-up (2026-11-16)

Implementation base: `b067470173d85f56f0e2b6a2f3a78524865ae822`. The main-line Base header names the revision on the target history for the document gate; it is not the implementation diff base.

Resolutions are ordinary typed assertions from a stable source per principal, separate from ordinary edits. Writer reconciliation appends retractions and question-state assertions. Invalid or revoked justification closes the whole resolution scope. Merely stale evidence leaves the resolution active and appends a problem linked to its explanation. No judgement table, stored selection pointer or answer cache is permitted. Evidence display does not decide whether a resolution stands.

Read selection uses recursive context cutoffs, the nearest layer, per-stream newest recorded assertion and newest valid start/sequence in SQL. Equal observations retain their assertion header and append operation, unit and evidence lineage. Pinned children retain their snapshot; unpinned children follow parent writes and reconcile their persisted question state when affected.

Final ALX-39 implementation and validation are reported in `/work/reports/ALX-39.md` and its bundle hand-in; acceptance remains the coordinator’s stage decision. This record does not close the parent atomic cutover task or claim acceptance of unrelated integration failures.


### ALX-104 lineage test correction (2026-11-17)

Decision 0039 items 25–26 and amendment item 2 require one operation per
stating pass, not exactly one operation for an assertion's lifetime. Only the
record test changes. Its independent tree/history fixture states the same
vertices and edges in two explicit passes, compares the complete operation
sets, and reads the creator operation and unit through `loadAssertions`.
Subject, source, author, context and recorded time checks remain required.

Bounded manual mutations removed reuse lineage and reversed scalar lineage
order; each made the rewritten case fail, and both production files were
restored. The final focused case passes (1 test, 102 assertions); static checks
pass. The full touched file still fails at the unchanged 120-second two-fill
budget and other cases; the broader `0039.25` filter includes an unrelated
language-history failure. No deadline or production implementation changes.
Exact commands and counts are in the ALX-104 hand-in report. No stage
acceptance or tracker receipt is claimed.

### ALX-101 follow-up (blocked, not acceptance)

Explicit protected kind extensions now retain their base identity, fields and producer through YAML conversion and installation. Protected edge extensions share the same nullable-field merger; endpoint, identity and required-field replacement remain refused. The original workflow-stage regression is unchanged. Snapshot and starter-value publication now compares existing assertions instead of always writing them again.

The corrected protected-extension tests were red before implementation, then passed 8 cases and 58 assertions. Full manifest publication passed 14 cases and 105 assertions, including an added declaration/snapshot no-op assertion-count test; endpoint declaration coverage passed one case and 32 assertions. No timeout, budget, catalogue-size expectation or forbidden core file changed.

The full-catalogue performance gate remains blocked: an instrumented baseline first publication took 221.24 s and the repeat exceeded the existing 300 s case budget; after avoiding repeated snapshot/starter writes, first publication still took 220.18 s and the overall case again timed out. Forced relation constraints alone took 75.87 s for declarations and 28.83 s for startup in the baseline. The stack points to the full relation walk generated by `src/adapters/schemas/graph-contract.ts:127-165`, a file excluded from this task's permitted changes. No constraint was bypassed. This increment is not stage acceptance; current-source mutation coverage remains owed.


### ALX-101 parent-scoped starter identity correction

The previous starter comparison excluded every draft with key edges unless it belonged to manifest metadata. Starter entries therefore rewrote all six assertions and their parent assertion. The comparison now resolves parent-scoped identity through the existing entity reference resolver. The renamed value-set regression reproduces 6 -> 12 vertex-subject rows and 1 -> 2 edge-subject rows before the fix; after the fix publication returns zero and both counts stay unchanged. Full-catalogue timing and committed-copy verification are recorded in the delivery report, not assumed from this focused test. No test deadline or fixture was reduced.

### ALX-174 publication fingerprint transaction correction (not accepted)

The publication fingerprint is written in the same READ COMMITTED transaction
as declarations and the startup page. Its fast path reads under the graph
write lock; source scope is checked against the store product identity. Current
publication reads retain PostgreSQL timestamp precision. The glossary defines
the invariant. Manifest authority is deferred to ALX-175.

The held recovery test is unchanged and now passes. Abort-after-declarations,
abort-after-page, and queued different declarations/pages are covered. Manual
mutations moving the mark outside the transaction and reading it before the
lock both fail the targeted cases. Independent gpt-6.1-terra review found two
issues (timestamp precision and page-coherence coverage), both corrected.

This increment is **not accepted**: full-starter runs exceeded the unchanged
300-second limit on two retries, the full publication suite has timeout
failures, and stop-databases has six daemon-start failures. Static checks pass
with architecture 874/874 and no new debt. Smaller fast-path reads are bounded
and equal (2 statements, 51 rows, zero writes/constraints), but final
full-starter equality has not been established. Detailed commands, wall times,
EXPLAIN and limits are in the ALX-174 hand-in report.

### Quiet-node rerun of ALX-174 acceptance

The earlier publication and full-starter timeout blockers are cleared without
code changes or relaxed limits: manifest-publication is 33/0 in 239.62 s;
catalog-any-growth is 7/0 in 257.74 s, with its full-starter case at 235.92 s
under 300 s. Full-starter and larger-store repeats both use 2 statements and
51 rows with no writes or immediate constraint checks, and unchanged graph
sizes within each repeat. EXPLAIN ANALYZE BUFFERS for both final statements
is retained in the hand-in evidence. Static architecture remains 874/874.

Acceptance remains blocked by stop-databases: 10/6 in 140.42 s, with the same
six failures on base c068ddb46 (10/6 in 134.25 s). All six fail alone under
unchanged bounds as well. They fail daemon startup at 8 s or the serve-address
wait at 20 s, not the outer 120 s case limit. This increment does not introduce
those failures, but does not waive them. See the hand-in report for each test
name, measured time, base comparison and evidence path. No task is closed.


### ALX-215 review corrections for publication fingerprint E

The single-waiter regression queues A behind a holder that publishes B and
checks that waiter's declarations, product page, publication fingerprint and
result before another publication can repair its state. Removing the explicit
publication read cutoffs fails with `Expected: "B" / Received: "A"`; the
production cutoffs are restored. AssertionSqlSelector now exposes
`currentStatement: true`, used by the startup fingerprint read instead of
rewriting SQL text. Its behavior test checks transaction time, statement time
and explicit cutoffs. The startup page already uses explicit cutoffs.

The sandbox rerun passes manifest publication (34 tests, 196 assertions),
assertion reads (6 tests, 30 assertions) and catalogue growth (7 tests,
111 assertions). The full-starter repeat case has observed sandbox times of 232.67 s,
251.19 s (latest focused rerun), 258.70 s (lead's focused rerun) and 281.17 s
(lead's full-file run) on this box: range 232.67–281.17 s, with worst observed
headroom of 18.83 s under the unchanged 300 s bound. The latest focused run
passes with 51/51 reads (1 test, 38 assertions).

Known fragility for the lead's decision: the lead's first full-file run on
`a73af0e2e` failed exact read equality at
`test/catalog-any-growth.test.ts:133`: Expected 51 / Received 55, case
281.17 s (whole file: 7 tests, about 305 s). The focused rerun passed 51/51
at 258.70 s. The lead captured `readPublicationFingerprint` SQL with a stub
executor on `729c2b6` and `a73af0e2e`; the strings are byte-identical (empty
diff). This is evidence that the fragility is not caused by this change;
exact read equality is sensitive to plan and visibility-map state. The
assertion is not relaxed and no behavior is changed.

Static checks pass with architecture 874/874 and no new debt. This is review
correction evidence, not stage acceptance; the pre-existing stop-databases
failures remain outside this increment.

### Foundation integration, 2026-11-16

This checkpoint merges origin/main into eff3e64f5ba48bde791567101c7ec0d76917c5ab.
Decision 0039 storage remains binding: typed assertions, parent-key edges, immediate checked operations, immutable blob evidence, graph orchestration and queue fencing/retry behavior. No stage acceptance is claimed.

Validation: bun run check passes with 560 inherited architecture findings, zero io-spans and zero catalogue-pointer findings. No added debt. App check/build pass; app tests 221 pass. Focused schema/plugin/manifest suites 68 pass; loop/logging/semantic/architecture suites 68 pass. Full executor suite remains non-green: undeclared-kind label and large diagram/database behavior also fail on the unmodified snapshot. The batching bound changes from 12 to 14 to account for constant typed-template assertion-read overhead (12 statements observed), not per-row reads. The source cache and stderr logs are retained; stderr limit remains 64 KiB. Recovery lease is queue-owned, 24 hours with 30-second renewal, not a new engine control table.

### Main merge conflicts

| File | Resolution |
| --- | --- |
| `.architecture/violations.json` | Retained only inherited active union entries; removed stale findings; added none. |
| `catalog/code/structure/code.file.yaml` | Kept snapshot typed assertions and key-edge storage; ported main API/read functionality without retired tables. |
| `catalog/templates/pages/code-file.yaml` | Ported main reader/UI content onto snapshot typed graph, localized UI, and Kind-prefixed schema. |
| `catalog/templates/pages/home.yaml` | Ported main reader/UI content onto snapshot typed graph, localized UI, and Kind-prefixed schema. |
| `plugins/db-schema/main.ts` | Kept snapshot immediate checked writes, parent identities and graph orchestration; ported main plugin, tracing and localization behavior. |
| `plugins/disk/main.ts` | Kept snapshot immediate checked writes, parent identities and graph orchestration; ported main plugin, tracing and localization behavior. |
| `plugins/glossary/main.ts` | Kept snapshot immediate checked writes, parent identities and graph orchestration; ported main plugin, tracing and localization behavior. |
| `plugins/imports/main.ts` | Kept snapshot immediate checked writes, parent identities and graph orchestration; ported main plugin, tracing and localization behavior. |
| `plugins/test-quarantine/main.ts` | Kept snapshot immediate checked writes, parent identities and graph orchestration; ported main plugin, tracing and localization behavior. |
| `scripts/check/architecture/gates.ts` | Kept snapshot typed assertions and key-edge storage; ported main API/read functionality without retired tables. |
| `scripts/graphql-starter.ts` | Kept snapshot typed assertions and key-edge storage; ported main API/read functionality without retired tables. |
| `src/adapters/agent-usage.ts` | Kept snapshot typed assertions and key-edge storage; ported main API/read functionality without retired tables. |
| `src/adapters/pg-boss-queue.ts` | Kept snapshot typed assertions and key-edge storage; ported main API/read functionality without retired tables. |
| `src/adapters/prepare-store.ts` | Kept snapshot typed assertions and key-edge storage; ported main API/read functionality without retired tables. |
| `src/adapters/schemas/fill-state.ts` | Kept snapshot deletion; retired storage surface stays removed. |
| `src/adapters/schemas/graph-contract.ts` | Kept snapshot typed assertions and key-edge storage; ported main API/read functionality without retired tables. |
| `src/adapters/schemas/graph.ts` | Kept snapshot typed assertions and key-edge storage; ported main API/read functionality without retired tables. |
| `src/adapters/schemas/orchestrator.ts` | Kept snapshot deletion; retired storage surface stays removed. |
| `src/adapters/schemas/queue.ts` | Kept snapshot typed assertions and key-edge storage; ported main API/read functionality without retired tables. |
| `src/fill/fsm.ts` | Kept snapshot immediate checked writes, parent identities and graph orchestration; ported main plugin, tracing and localization behavior. |
| `src/fill/orchestrator-host.ts` | Kept snapshot immediate checked writes, parent identities and graph orchestration; ported main plugin, tracing and localization behavior. |
| `src/fill/orchestrator-store.ts` | Kept snapshot deletion; retired storage surface stays removed. |
| `src/fill/orchestrator.ts` | Kept snapshot immediate checked writes, parent identities and graph orchestration; ported main plugin, tracing and localization behavior. |
| `src/fill/plugin-turns.ts` | Kept snapshot immediate checked writes, parent identities and graph orchestration; ported main plugin, tracing and localization behavior. |
| `src/fill/producer-outcomes.ts` | Kept snapshot immediate checked writes, parent identities and graph orchestration; ported main plugin, tracing and localization behavior. |
| `src/fill/stage.ts` | Kept snapshot immediate checked writes, parent identities and graph orchestration; ported main plugin, tracing and localization behavior. |
| `src/fill/stages/plugin-contract.ts` | Kept snapshot immediate checked writes, parent identities and graph orchestration; ported main plugin, tracing and localization behavior. |
| `src/fill/state-store.ts` | Kept snapshot deletion; retired storage surface stays removed. |
| `src/graph/authored.ts` | Kept snapshot typed assertions and key-edge storage; ported main API/read functionality without retired tables. |
| `src/graph/claims.ts` | Kept snapshot deletion; retired storage surface stays removed. |
| `src/graph/consistency.ts` | Kept snapshot typed assertions and key-edge storage; ported main API/read functionality without retired tables. |
| `src/graph/graph-writes.ts` | Kept snapshot typed assertions and key-edge storage; ported main API/read functionality without retired tables. |
| `src/graph/graphql-read.ts` | Kept snapshot typed assertions and key-edge storage; ported main API/read functionality without retired tables. |
| `src/graph/manifest-publication.ts` | Kept snapshot typed assertions and key-edge storage; ported main API/read functionality without retired tables. |
| `src/graph/one-graph.ts` | Kept snapshot typed assertions and key-edge storage; ported main API/read functionality without retired tables. |
| `src/graph/plugin-turns.ts` | Kept snapshot typed assertions and key-edge storage; ported main API/read functionality without retired tables. |
| `src/graph/producer-outcomes.ts` | Kept snapshot typed assertions and key-edge storage; ported main API/read functionality without retired tables. |
| `src/graph/records.ts` | Kept snapshot typed assertions and key-edge storage; ported main API/read functionality without retired tables. |
| `src/graph/start-entity.ts` | Kept snapshot typed assertions and key-edge storage; ported main API/read functionality without retired tables. |
| `src/graph/write.ts` | Kept snapshot typed assertions and key-edge storage; ported main API/read functionality without retired tables. |
| `src/graphql/names.ts` | Kept snapshot typed assertions and key-edge storage; ported main API/read functionality without retired tables. |
| `src/graphql/schema.ts` | Kept snapshot typed assertions and key-edge storage; ported main API/read functionality without retired tables. |
| `src/graphql/starter.graphql` | Kept snapshot typed assertions and key-edge storage; ported main API/read functionality without retired tables. |
| `src/knowledge/fill-role.ts` | Kept snapshot typed assertions and key-edge storage; ported main API/read functionality without retired tables. |
| `src/knowledge/graph-read.ts` | Kept snapshot typed assertions and key-edge storage; ported main API/read functionality without retired tables. |
| `src/knowledge/product.ts` | Kept snapshot typed assertions and key-edge storage; ported main API/read functionality without retired tables. |
| `src/loop/plan.ts` | Kept snapshot typed assertions and key-edge storage; ported main API/read functionality without retired tables. |
| `src/loop/views.ts` | Kept snapshot typed assertions and key-edge storage; ported main API/read functionality without retired tables. |
| `src/page-contract/schema.ts` | Kept snapshot typed assertions and key-edge storage; ported main API/read functionality without retired tables. |
| `src/plugin/agent.ts` | Kept snapshot immediate checked writes, parent identities and graph orchestration; ported main plugin, tracing and localization behavior. |
| `src/plugin/host.ts` | Kept snapshot immediate checked writes, parent identities and graph orchestration; ported main plugin, tracing and localization behavior. |
| `src/plugin/product-files.ts` | Kept snapshot immediate checked writes, parent identities and graph orchestration; ported main plugin, tracing and localization behavior. |
| `src/product/cli.ts` | Kept snapshot immediate checked writes, parent identities and graph orchestration; ported main plugin, tracing and localization behavior. |
| `src/product/daemon-fills.ts` | Kept snapshot immediate checked writes, parent identities and graph orchestration; ported main plugin, tracing and localization behavior. |
| `src/product/fill-stages.ts` | Kept snapshot immediate checked writes, parent identities and graph orchestration; ported main plugin, tracing and localization behavior. |
| `src/product/manifest/kinds.ts` | Kept snapshot immediate checked writes, parent identities and graph orchestration; ported main plugin, tracing and localization behavior. |
| `src/product/store-preparation.ts` | Kept snapshot immediate checked writes, parent identities and graph orchestration; ported main plugin, tracing and localization behavior. |
| `test/architecture-gates.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/catalog-check.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/catalog-read.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/consistency-plugin.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/db-schema-path.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/fill-already-running.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/fill-fsm.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/fill-orchestrator.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/fill-runs.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/fill-serial-stage.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/fill-state-store.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/fixtures/starter-catalog-sources.json` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/graph-one-schema.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/graph-records.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/graph-write.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/graphql-executor.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/graphql-schema-route.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/graphql-schema.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/graphql-writes.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/graphql/fixture.golden.graphql` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/imports-path.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/page-contract.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/plugin-agent-bridge.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/plugin-agent-reference.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/plugin-fill-access.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/plugin-host.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/plugin-output-partitions.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/problems-wiki.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/producer-outcomes.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/product-serve.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/product-wiki-serve.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/schema-stamp.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/source-follows-fill.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/test-quarantine-plugin.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `test/workflows-read.test.ts` | Kept snapshot storage assertions and ported main reader/API intent to current graph contract. |
| `wiki/app/src/components/bars.tsx` | Ported main reader/UI content onto snapshot typed graph, localized UI, and Kind-prefixed schema. |
| `wiki/app/src/components/catalogue.tsx` | Ported main reader/UI content onto snapshot typed graph, localized UI, and Kind-prefixed schema. |
| `wiki/app/src/components/command.ts` | Ported main reader/UI content onto snapshot typed graph, localized UI, and Kind-prefixed schema. |
| `wiki/app/src/components/diagram.tsx` | Ported main reader/UI content onto snapshot typed graph, localized UI, and Kind-prefixed schema. |
| `wiki/app/src/components/overview.tsx` | Ported main reader/UI content onto snapshot typed graph, localized UI, and Kind-prefixed schema. |
| `wiki/app/src/components/problems.tsx` | Ported main reader/UI content onto snapshot typed graph, localized UI, and Kind-prefixed schema. |
| `wiki/app/src/components/run.tsx` | Ported main reader/UI content onto snapshot typed graph, localized UI, and Kind-prefixed schema. |
| `wiki/app/src/components/source.tsx` | Ported main reader/UI content onto snapshot typed graph, localized UI, and Kind-prefixed schema. |
| `wiki/app/src/components/ui/controls.test.tsx` | Ported main reader/UI content onto snapshot typed graph, localized UI, and Kind-prefixed schema. |
| `wiki/app/src/components/ui/graph.tsx` | Ported main reader/UI content onto snapshot typed graph, localized UI, and Kind-prefixed schema. |
| `wiki/app/src/components/ui/select.tsx` | Ported main reader/UI content onto snapshot typed graph, localized UI, and Kind-prefixed schema. |
| `wiki/app/src/compose.test.ts` | Ported main reader/UI content onto snapshot typed graph, localized UI, and Kind-prefixed schema. |
| `wiki/app/src/kit-page.tsx` | Ported main reader/UI content onto snapshot typed graph, localized UI, and Kind-prefixed schema. |
| `wiki/app/src/locales/en.json` | Ported main reader/UI content onto snapshot typed graph, localized UI, and Kind-prefixed schema. |
| `wiki/app/src/locales/ru.json` | Ported main reader/UI content onto snapshot typed graph, localized UI, and Kind-prefixed schema. |

Document gate is blocked by the inherited Base f438fd54a15b664d97e502f8de50e6118a7fcf9b not belonging to local main target history. No proposal acceptance is claimed.
