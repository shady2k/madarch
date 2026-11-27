# Both index orders of the anchor lookup fit a bound drawn from the touched slots

Change: madarch-x9a7.8
Base: a546a04a6698513d0eecbff9aa47d7dc99d7fb5f
Tasks: madarch-x9a7.8
Kind: no-behavior

## Intent

`test/dispute-reconciliation-batch.test.ts` compared the tuples its anchor lookup
visits for exact equality between a ten-question and a two-hundred-question
catalogue (`expect(large.anchorWork).toBe(small.anchorWork)`). The lookup reaches
those anchors through a `LATERAL` join of `edge candidate` and `assertion judged`
on `judged.assertion_id=candidate.to_node`, and PostgreSQL picks the inner order
of that pair from its statistics: `edge (0.5×20) → assertion_pkey (1×10)` visits
80 tuples, `assertion_pkey (1×20) → edge (0.5×20)` visits 90. Both are index
lookups that ignore the 190 unrelated questions, but the equality turned the
second order into a red `test shard 1` on commits that touched nothing near
disputes (main `adb2100e1`, run 45980826239; PR #361, run 45976152415). The
owner-facing cost is a merge that waits for a rerun it never needed.

## Rationale

The property the case states is that the lookup's work follows the slots the
operation touched, not the question catalogue. A lookup that visited at most one
tuple on each counted relation of its plan per driver row has exactly that
shape, and the driver rows are the touched slots' assertions or this operation's
evidence targets the operation's own writes reach, never the catalogue. Those
driver rows are counted from the case's fixture inputs and not from the `$4` list
the lookup under test assembles, so the plan's own probe count times them is a
bound neither the catalogue nor the lookup can move, and one further probe per
driver row — the cost of the other inner order — fits inside it. Measured: 80
visited tuples against a bound of 180 for the first order and 90 against 180 for
the second, at both catalogue sizes, and 35 376 against 180 once the lookup is
fed assertions from slots the operation never touched in the two-hundred-question
catalogue.

## Out of scope

- `src/graph/disputes.ts` and every other source file: the SQL is unchanged, and
  the bound is read from the plan the product's own query produces.
- The query-count (`large.total === small.total`), row-count (`large.rows ===
  small.rows`) and outcome (`OPEN`, `retracted === true`) assertions: kept as
  they were in both host cases.
- `ANALYZE` before the measurement and any pinning of the join order: both were
  offered as alternatives on the parent task and neither is needed once the bound
  comes from the fixture's inputs and the plan instead of from an equality
  between two catalogues.
- Mutation testing: the parent task limits this fix to the test file.
- Dispute reconciliation has no accepted capability document, so no coverage
  reference names this bound: the file's own cases hold it.

## Changes to requirements
None. No requirement changes: the case still proves that the anchor lookup's
work is bounded by the touched slots and independent of unrelated questions, and
only the expression of that bound changes.

## Preserved contracts
- graph-queries/as-of: every answer is still for a time on both axes, the dispute question's state is read as the history held it at each instant, and the lookup that finds those questions still visits no unrelated one; only the expression of its bound changes, from an equality between two catalogues to the probe count of the plan the product's own query produces.

## Coverage
- graph-queries/as-of: test

## Where it is seen
Kind: internal
Place: `bun test` and CI's test shards
Reason: only a test assertion changes; no screen, route, string, command or product behaviour differs.

1. Run `bun test test/dispute-reconciliation-batch.test.ts`: the two host cases
   pass whatever inner order PostgreSQL chooses for the anchor join, and the
   suite reports the visited tuples and their bound for each catalogue size.

## Blocking questions
None.

## Design and decisions
`visited` already counted the tuples of the lookup's counted relations
(`edge`, `node`, `assertion`, `assertion_vertex_subject`,
`assertion_edge_subject`). A second walk of the same plan, `probes`, counts those
relations instead of their tuples. Each anchor statement then asserts `work <=
probes × expected`, where `expected` is the case's own input count: two sources'
assertions on every touched slot for the direct lookup, and one identity per
touched write plus the two identity assertions the harness writes for the
dependency lookup. It also asserts that the lookup's `$4` list is no longer than
`expected`, so a lookup fed slots the operation never touched leaves the bound at
once. The `HOST-ANCHOR-PLAN` line prints `drivers`, `expected`, `work` and
`budget` beside the plan.

## Acceptance evidence
Filled at acceptance from the task `madarch-x9a7.8`.

## DONE WHEN
Both host cases pass for a ten- and a two-hundred-question catalogue under
either inner join order of the anchor lookup, and fail when the lookup is fed
assertions from slots the operation did not touch in the larger catalogue.
