# Declaration-driven fill contract

This is the revised normative contract for madarch-64o5.28 and .30, following
`/tmp/codex28-answer.md` section 4. It specifies required behavior, not evidence
that implementation or checks are complete. Historical failures in change.md
remain evidence until independently resolved. The owner's quoted “Да, ок”
authorizes this task; it is not a tooling receipt or completed process approval.

## 1. Plugins interpret data

Only plugins interpret content. Every plugin may request the host agent service;
there are no engine agent/deterministic categories, numeric priorities or content
quality heuristics. Agent ID and token cap are invocation inputs. Tests use only
scripted adapters, never real models. Existing bounds and timeouts stay unchanged.

## 2. Availability is not participation

Every declared kind supports configured general-agent filling, including fields
normally written by another plugin. Availability alone never schedules an agent.
The ordinary general-agent plugin supplies configurable output declarations; it
is not a mandatory final phase or a hidden runtime fallback.

## 3. Product configuration determines the plan

Resolve enabled product plugins and expand declarations before admission. Only
actual planned invocations requesting an agent require a selected runnable agent.
Refuse a missing agent before acceptance, queueing or execution, naming its
absolute manifest path, 1-based line and how to choose --agent or a wiki agent.
The wiki uses the same plan, marks the selector required only when necessary,
and disables Run with an actionable reason when missing. No no-agent option or
waiting-for-agent state is introduced. Disabled/omitted executable stages cannot
admit plugin work. Fixtures retain valid kinds, typed fields and provider identity.

## 4. Kind prerequisites

`derives-from` is the required kind list, replacing `depends-on`. Users author
it for user-defined kinds. An empty list means no prerequisites. Required kinds
must be satisfied in this run; stale catalogue material is not successful work.

```yaml
kinds:
  document.summary:
    description: A grounded document summary.
    derives-from: [document.source, policy]
    agent:                         # optional explicit overlapping output
      plugin: general-agent
      fields: [description]
      refines: [summary-plugin]
```

The optional kind `agent` configuration requires `plugin`, identifying the
enabled ordinary plugin explicitly, and expands into its ordinary output entries. `fields` is `"*" or a nonempty declared field list; `refines`
names enabled producers of overlapping fields. Configuration replaces gap
coverage for those fields only, leaving other gap fields available. It is
inspectable before execution and never changes kind selection.

## 5. Exact prerequisite selection

CLI and wiki select exactly requested kinds plus their transitive
`derives-from` prerequisites, once each. They never select dependants. Both use
the same engine closure and expanded plan. Plugin execution is not permission
to publish all its outputs when only a subset is selected.

## 6. Output-specific declarations

A plugin.json retains name/version/entry/runtime and service rights. `produces`
is nonempty. Each entry owns `kind`, `fields`, `reads`, `refines`, and optional
`coverage`. There is no plugin-wide reads/refines fallback. Omitted reads and
refines mean empty lists. Multiple output entries do not split the plugin into
new plugins. Optional plugin `concurrency` is a positive simultaneous-unit limit,
not an ordering rule. Checks produce the catalogue's Problem kind.

```yaml
name: summary-plugin
produces:
  - kind: document.summary
    fields: [description]
    reads: [document.source, policy]
    refines: []
  - kind: audit.note
    fields: [description]
    reads: [audit.source]
    refines: []
concurrency: 1
```

A string read requires the current successful version of that input kind.
The only earlier-version form is explicit and names the exact producer:

```yaml
reads:
  - {kind: document.source, version: earlier, producer: source-index}
```

A refinement target is scoped to its output entry's kind and fields, not all
other outputs of either plugin. Wildcard kind `"*"` expands only over
product-declared kinds in the pinned manifest; `fields: "*"` expands declared
fields. Catalogue-only kinds do not become outputs.

## 7. Declaration gaps and explicit overlap

`coverage: gaps` subtracts fields claimed by other configured declared outputs
before ordering; absent coverage means ordinary declared output. The ordinary
general-agent wildcard uses `coverage: gaps`, with no universal refinement:

```yaml
name: general-agent
produces:
  - {kind: "*", fields: "*", reads: [], refines: [], coverage: gaps}
```

Expansion supplies prerequisite reads for generated general-agent entries from
the relevant kind's declared prerequisites. A gap means no configured producer
claims that field/kind, not that a runtime value appears inadequate. An explicit
kind agent configuration compiles the requested field overlap and refinement
relations into ordinary declarations. A complementary description field needs
no refinement unless another producer also claims description. A producer that
omits a claimed field does not trigger an agent; it reports an explicit outcome.
Two gap declarations still claiming the same field are unordered overlap unless
explicitly refined. The plan exposes the expanded fields, reads and refinement
edges before execution; the engine never judges content to choose a producer.

## 8. Expand and validate before execution

Refuse unknown kinds, fields, producers, earlier-version targets and refinement
targets; invalid concurrency/cap; missing output; missing runnable producer;
reads outside the output's prerequisite closure; unordered overlapping writers;
and dependency/refinement cycles. All refusals name the absolute declaring
filename, 1-based line, output/field and actionable correction. Related conflicts
name both locations. Read order alone does not authorize overlapping writers.
Declaring fields is not proof they were filled; startup proves consistency only.
Unavailable earlier-version snapshot support is a prestart refusal, never a
silent substitution of current or stale catalogue values.

## 9. Enforced invocation access and output scope

Validate every output's reads against that output kind's own transitive
prerequisite closure, not the union of a plugin's outputs. Explicit earlier
reads may additionally name the same output kind being refined; the named
producer must provide that kind in the refinement chain. A Problem check must
represent checked kinds in Problem's prerequisites; otherwise refuse and explain
the required correction. This may conservatively broaden Problem selection.

Invoke plugins with enforced selected kind/field scopes. Catalogue reads,
graph/value/files APIs, and the agent bridge all enforce the same declared
input scope. `catalogue: true` grants service availability, not unlimited reads.
Broad queries must filter to authorized kinds or refuse before reading.
Undeclared reads or writes outside selected declared output scope fail the
invocation with context; silently discarding forbidden writes is not enforcement.

## 10. Successful dependencies and explicit earlier versions

Units are plugin-and-kind scoped. Validate cycles on this unit graph; a coarse
plugin-only graph must not reject a valid multi-output unit DAG. Every required upstream producer unit must
complete successfully before its consumer starts, including another kind of
the same plugin. Readiness is not mere terminal status or planning completion.
Only the identical current unit is excluded as self. No automatic exemption
removes dependencies on downstream refiners. Normal reads retain all required
producers and therefore reject a real cycle. Explicit earlier reads retain the
named producer dependency and consume its immutable run/version snapshot;
only later versions of that particular input are excluded. They never use a
later overwritten value. Refinement orders named earlier producers first.
Unrelated ready units may run concurrently within declared limits.

## 11. Facts, resolution and lifecycle

Preserve plugin source, evidence and run/version identity for every fact,
including retained and superseded opinions. Existing run linkage and unit
generation may supply identity; a duplicate version column is not required.
Resolve a field by its declared refinement chain, never arrival time, engine
category or numeric priority. Facts of unrelated producers are not deleted.

Successful completed/empty publication atomically replaces that producer's
selected output scope: changed facts replace older versions, and omitted facts
or fields retract previous opinions from that scope. A zero-Problem check
therefore clears its old Problems. An unchanged outcome preserves equivalent
facts while recording successful verification of the current run/version.
Abstention/failure does not retract previous successful facts or publish partial
replacement. A partial invocation is non-success (abstained or failed with a
reason), never successful upstream completion or an authoritative retraction. Retained facts remain attributable to their previous successful
run, not falsely relabelled as current. Out-of-scope kinds/fields and other
producers' facts remain untouched. A later selected partial-field run replaces
only its declared selected fields, not the whole entity.

## 12. Authored satisfaction and observable outcomes

Authored material satisfies a prerequisite through an enabled ordinary plugin
that observes/publishes the authored version and explicitly reports success.
A kind does not need a generating agent when this authored-input producer
satisfies it. Merely finding catalogue rows, a native-kind exception, or a
special engine content interpreter does not satisfy it.

Every planned plugin/kind reports one outcome with plugin, kind, produced count
and run/version linkage: `completed`, `unchanged`, `empty`, `abstained`, or
`failed`. Abstained and failed require a reason. Completed means successful
publication; unchanged means successful equivalent verification; empty means
successful authoritative zero-result publication, including zero Problems.
Those three satisfy an upstream dependency. Abstained and failed do not; their
dependants cannot execute as if inputs succeeded. Expose blocked dependants and
their upstream reason. No omitted result or zero-unit plan is implicit success.
Outcome reporting describes actual work, not declared coverage. A selected
kind can finish explicitly empty without pretending it contains entities.

## Required regression scenarios (review section 1)

These are acceptance scenarios, not yet passing-test claims. Each must use
scripted adapters where an agent is exercised; no timeout/bound is increased.

| ID | Scenario and required assertion | Rules |
| --- | --- | --- |
| S1 | Index 2,603 files with deterministic declarations covering all selected fields; general-agent capability is available but no agent invocation/selection/token budget is required. Add explicit per-field overlap and assert only that configured refinement is scheduled. | 2, 3, 7 |
| S2 | A wildcard producer omits description or returns no entities; assert explicit per-kind completed/unchanged/empty/abstained/failed outcome as appropriate, never silent success or secretly activated agent. | 7, 8, 12 |
| S3 | Summary reads Policy but derives only from Document; refuse with source locations. Add Policy prerequisite and assert selection and successful fresh Policy completion precede Summary. | 4, 5, 9, 10 |
| S4 | One plugin produces A from X and B from Y; selecting A includes X, not B or Y. Validate A's reads against A's own closure, so B cannot hide an illegal read. | 5, 6, 9 |
| S5 | P produces Summary from Source and Q refines P's Source; ordinary required latest Source retains dependency and refuses a cycle. Explicit earlier named producer enables only a real immutable earlier snapshot, never latest substitution. Failed/abstained upstream blocks consumer. | 6, 8, 10 |
| S6 | Tracker authored Requirements feed Problems checks without a generating agent; an ordinary authored-input plugin reports successful satisfaction. Zero Problems is explicit empty success. | 1, 3, 12 |
| S7 | A plugin produces Files and dependent Summaries; selecting Files prevents Summary output. Attempted unselected writes and undeclared catalogue/agent reads fail rather than leak or silently discard. | 5, 9 |
| S8 | A check first publishes a Problem and then passes; successful empty replacement retracts its old Problem while preserving evidence/version history and other producers. Failed/abstained reruns preserve prior good facts; partial-field replacement touches only its scope. | 11, 12 |

## Evidence boundary

This contract supersedes the earlier universal-agent scheduling and implicit
earlier-refinement exemptions. It does not claim implementation is complete,
that process approval receipts exist, or that historical failures are repaired.
The existing native-stage migration limitation and unresolved schema-key,
performance/list, glossary journal and child-role shutdown observations remain
in change.md. No PostgreSQL or heavy checks were run to author this contract.
