# Graph verdicts

Capability: graph-verdicts

## Purpose
Every current node and edge of a filled product carries a verdict with a reason: deterministic rules
decide what they can check, bounded judge tiers decide ambiguity, and a failed or unjudged item stays
unreviewed and inspectable. A coverage report counts the verdicts per kind and names the budgets.

## Requirement: verdicts — Every node and edge has a verdict and a reason
When a filled product's graph is validated, every current node and edge shall be `valid`, `invalid`
or `unreviewed`, with a one-line reason and the rule or judge that decided it. An item no rule or
judge decided shall be `unreviewed`, and it shall remain inspectable with its reason.

### Scenario: every-item-has-a-verdict
- Given: a filled product with current nodes and edges
- When: validation finishes
- Then: every current node and edge has one of the three verdicts and a reason

### Scenario: an-unjudged-item-is-unreviewed
- Given: an item whose judge could not run
- When: validation finishes
- Then: the item is unreviewed with the failed judge as its reason, never valid

## Requirement: tiers — Rules first, then bounded judge tiers
Deterministic rules shall run first for every kind and decide only the item's shape and the bytes it
cites at the fill's commit. A structurally sound item whose neighbourhood is anomalous shall go to a
judge instead of passing on its span check alone. Undecided items shall be judged in batches of at
most 50: jev first, then classification, then analysis; what analysis still cannot decide shall
reach a person. Evidence that cannot be resolved shall stay unreviewed and a judge shall not overrule
it.

### Scenario: unresolved-evidence-is-never-valid
- Given: an item citing a file the fill's commit does not hold, or lines or a digest the bytes contradict
- When: the item is validated
- Then: it is unreviewed, whatever a judge would answer

### Scenario: an-anomalous-neighbourhood-goes-to-a-judge
- Given: a database node with no table edge
- When: the deterministic rules run
- Then: the item is escalated to a judge rather than passing on its span check

## Requirement: cache-and-budgets — Reuse only an unchanged neighbourhood
The verdict cache shall key an item by its evidence hash, the rule-set hash and the judge's identity,
so an unchanged neighbourhood under an unchanged rule set and judge reuses its verdict and a changed
node or edge revalidates itself and its incident edges. Budget deferrals and retryable judge failures
shall be requeued for the next run even when the snapshot is unchanged. The `itemsPerRun` and
`modelCallsPerRun` budgets shall be enforced and saved beside the graph; a run with no assigned
judge shall say where to assign one and judge nothing.

### Scenario: a-changed-neighbourhood-revalidates
- Given: a graph whose item and its incident edge are unchanged, then an edit to the item
- When: validation runs again
- Then: the unchanged items reuse their verdicts and the changed item and its edge are validated again

### Scenario: a-budget-deferral-is-requeued
- Given: more undecided items than `itemsPerRun` admits
- When: the next validation runs
- Then: the deferred items are taken up again rather than reused as decided

## Requirement: coverage — Counts, reasons and budgets are served
The server shall serve the graph verdict coverage at `GET /api/k/graph-verdicts`, and the product
settings shall show one graph-verdicts section with per-kind counts, reasons, the two budgets and an
explicit run press. Validation shall run when a fill completes.

### Scenario: coverage-is-served
- Given: a filled product with verdicts
- When: `GET /api/k/graph-verdicts` is read
- Then: it reports the verdict counts per kind with their reasons

### Scenario: the-settings-section-runs-a-validation
- Given: the graph-verdicts section of the settings
- When: its run press is used
- Then: a validation runs and the coverage shown reflects its result
