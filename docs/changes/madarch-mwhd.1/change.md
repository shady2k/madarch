# Every graph node and edge gets a validation verdict, with its reason and a coverage report

Change: madarch-mwhd.1
Base: 881fd278fe98a766d7065515ffa15e3dad3be466
Tasks: madarch-mwhd.1
Kind: behavior

## Intent
Every current node and edge of a filled product now gets `valid`, `invalid` or `unreviewed` with a one-line reason and the rule or judge that decided it. Deterministic rules run first for every kind and decide only what they can check: the item's shape and the bytes the item cites at the fill's commit. Evidence that cannot be resolved — no pinned reader, a missing file, a digest or line range the bytes contradict — stays unreviewed and is never valid. A structurally sound item whose neighbourhood is anomalous goes to a judge rather than passing on its span check alone.

Undecided items go to a judge in batches of at most 50, jev first, then classification, then analysis; what analysis still cannot decide reaches a person. A judge that could not run leaves its items unjudged, never valid. Budget-deferred items and retryable judge failures are requeued for the next run. The cache is keyed by the item's evidence hash, the rule-set hash and the judge identity, so a refill revalidates only changed neighbourhoods. `itemsPerRun` and `modelCallsPerRun` are enforced and saved beside the graph; a run with no assigned judge says where to assign one and judges nothing.

Coverage is served by `GET /api/k/graph-verdicts` and shown in one settings section with per-kind counts, reasons, budgets and an explicit run press.

## Out of scope
- Changing the graph's schema, its node or edge kinds, or the compiled model's shape.
- Making a semantic judge override unresolved evidence; the evidence is checked first and wins.
- Starting a real model in a test; the tests use fake judges.

## Rationale
The owner asked that every graph node and edge be reviewed and validated, and suggested something like jev. Running one agent per item would be neither bounded nor repeatable, so deterministic rules decide what they can and only ambiguity reaches a judge in bounded batches. Keeping every failed or unjudged item unreviewed and inspectable, with its reason, means coverage is countable rather than claimed, and requeueing budget-deferred work means a later run does not silently reuse an incomplete answer.

## Changes to requirements
- graph-verdicts/verdicts (new): every current node and edge is valid, invalid or unreviewed with a one-line reason and the deciding rule or judge. Scenarios: `every-item-has-a-verdict`, `an-unjudged-item-is-unreviewed`.
- graph-verdicts/tiers (new): deterministic rules run first; undecided items go through jev, classification, analysis and then a person in batches of at most 50; evidence is pinned and cannot be overruled. Scenarios: `unresolved-evidence-is-never-valid`, `an-anomalous-neighbourhood-goes-to-a-judge`.
- graph-verdicts/cache-and-budgets (new): the cache reuses a verdict only under an unchanged evidence, rule set and judge identity; budget deferrals and failed judges are requeued; the two budgets are enforced. Scenarios: `a-changed-neighbourhood-revalidates`, `a-budget-deferral-is-requeued`.
- graph-verdicts/coverage (new): a served coverage report and one settings section show per-kind counts, reasons, budgets and a run press. Scenarios: `coverage-is-served`, `the-settings-section-runs-a-validation`.

## Preserved contracts
- compiled-model/shape: the compiled model keeps its published schema and kind vocabulary; verdicts are recorded beside the graph, not added to the model's shape.

## Coverage
- graph-verdicts/verdicts: test
- graph-verdicts/tiers: test
- graph-verdicts/cache-and-budgets: test
- graph-verdicts/coverage: test
- compiled-model/shape: test

## Where it is seen

Kind: internal
Place: the graph verdict run after a fill, its coverage report, and the graph-verdicts section of the product settings
Reason: the merge carries server and browser assertions, not a committed mockup; the screen is the settings section the product already serves, and the verdicts and coverage are held by those assertions.

1. Fill the training product and read one verdict per node and edge, with valid, invalid or unreviewed and its reason.
2. Open the settings section for graph verdicts: per-kind counts, reasons, the two budgets and a run press; press it and see the coverage change.
3. Plant a database with no edge or a route with no handler and see it go to a judge rather than pass on its span check; leave a judge unassigned and see the items unreviewed with where to assign one.

## Blocking questions
None.

## Design and decisions
The rules are data in `graph-verdict-rules.ts`, so a rule edit invalidates what it decided through the rule-set hash. Evidence is read at the fill's commit: a cited file must exist, its span must be inside it, and the graph's declared lines and digest must match. Escalation conditions send an anomalous neighbourhood to a judge: a database with no table, a route with no handler, an operation no route serves, a channel with no consumer, an interface with no implementation, a test that tests nothing, a deployment with no image, a table nobody reads or writes, a node with no edge, and a read-undefined or defined-unread environment variable. Cache entries carry the evidence hash, the rule-set hash and the judge's role, agent, model, reasoning and version. Budget deferrals and failed judges are requeued even when the snapshot is unchanged. The ACP judge reads pinned excerpts and neighbourhood facts, and a valid answer requires resolved evidence.

## Acceptance evidence
- PR #193 (`fc303d14`) added the rule set, judge tiers, verdict cache, budgets and coverage in `src/knowledge/graph-verdicts.ts`, `src/knowledge/graph-verdict-rules.ts`, `src/knowledge/graph-verdict-store.ts` and the ACP judge.
- `test/graph-verdicts.test.ts`, `test/graph-verdict-rules.test.ts`, `test/graph-verdict-acp-judge.test.ts` and `wiki/app/src/knowledge/settings.test.tsx` hold the verdicts, the pinned-evidence refusals, the requeue, the budgets and the coverage section.
