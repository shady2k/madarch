# Resolve an anchored assertion and its subject in one probe each

Change: madarch-64o5.202
Base: 7f1bb9aac
Tasks: madarch-64o5.202
Kind: no-behavior

## Intent

A CI run of the catalogue stream failed the touched-slot case of
`test/dispute-reconciliation-batch.test.ts`: the anchor lookup of `reconcileDisputes` visited 1 523 tuples
against a driver-derived bound of 180 for twenty anchors. The plan was not an `EXPLAIN` artifact. Under the
planner's own statistics after an `ANALYZE`, the direct lookup (`src/graph/disputes.ts`, the `direct` query)
read every `assertion_edge_subject` row and 1 369 `edge` rows through a hash join and a merge join, and at
fifty-one anchors it reached 13 622 visited tuples against a bound of 1 377. The same fault was in the
dependent lookup (`dependent`), which every run with evidence dependencies takes.

The direct lookup also read one row twice: it joined `assertion` inside its anchor lateral, to prove the
anchor names an assertion, and again outside that lateral, to read the row's property and language. The
second read cost a further probe of `assertion` per driver row, and under the default planner settings on
the ten-question fixture a sequential scan of the whole table for every anchor — 6 360 of the 10 877.9
visited tuples that the review of this change measured there. The anchor now names its target node alone
and one `CROSS JOIN LATERAL (... OFFSET 0)` probe reads the anchored assertion, so the anchor edge and the
assertion it names cost one probe each.

Both lookups state the subject of the anchored assertion as five plain joins: `assertion_vertex_subject`
to its attachment edge and node, and `assertion_edge_subject` to its edge. PostgreSQL reassociates
`(A LEFT JOIN B) LEFT JOIN C` and is free to join the two subject tables over their whole tables before
applying the driver list, which is what the failing plan did. Each subject table is now resolved by one
grouped `LEFT JOIN LATERAL (... OFFSET 0) ... ON true` probe, so the planner keeps one probe per driver row
and the lookup visits at most one tuple of each relation it names per driver row. The rows, their order,
their values, the source queries and the graph contracts are unchanged.

## Rationale

`OFFSET 0` inside the lateral is the codebase's existing fence — `graph_checks_pass` holds its own subject
reads the same way (`src/adapters/schemas/graph-definition.ts`) — and it is what stops the pull-up that
produced the join. Two grouped laterals rather than five separate ones keep one branch per subject table:
the vertex branch is one index probe on `assertion_vertex_subject`'s primary key and two lookups on its
attachment, and the edge branch is one on that table's primary key. A vertex assertion therefore never
probes the edge branch and an edge assertion never probes the vertex one, which the plan shows as
`actual loops = 0` on the branch that does not apply. `LEFT ... ON true` keeps a missing subject a null
row rather than dropping the anchor, as the plain joins did.

The anchored assertion is fenced for the same measured reason: joined outside the anchor lateral, the
planner pulls both reads of `assertion` into one hash join over `assertion_vertex_subject`, which visits
281.9 tuples against a bound of 240 where the fenced form visits 79.9.

The measured cases, at the statistics `ANALYZE` leaves and compared with the same fixture on the same box:

- ten touched slots of the ten-question fixture with `enable_seqscan=off` (the CI reproduction): 998.9
  visited tuples against a bound of 270 before, 79.9 against 240 now. The merge join over
  `assertion_edge_subject` and the 848-row `edge` scan are gone, and the plan counts eight relations
  instead of nine because the anchored assertion is one probe where it was two.
- ten touched slots at `catalog=200` with the default planner settings: 79.9 against 240, with no
  sequential scan in the plan. This is the small slot count the review asked for, on a store whose tables
  are past PostgreSQL's sequential-scan crossover.
- fifty-one touched slots at `catalog=200` with the default planner settings: 13 622.5 against 1 377
  before, 406.49 against 1 224 now. The sequential scan of `assertion_edge_subject` (612 rows) and the
  12 453-row `edge` scan are gone.
- the ten-question fixture under the default planner settings still visits 4 517.9 against 240: four of its
  five counted tables hold one to three pages, where PostgreSQL 18.6 prices a sequential scan below a random
  index probe, so the fixture has a floor of 298 rows — 248 of `node` plus the fifty its anchors resolve —
  whatever the SQL says. The reproduction therefore keeps replaying it at `enable_seqscan=off`, the setting
  `test/dispute-reconciliation-batch.test.ts` already used for that fixture, and the bound stands at the
  default settings in the two cases above.
- the same lookup fed every assertion in the graph stays out of bounds on both counts (3 103 drivers against
  153 expected, 4 509.2 visited tuples against 1 224; 3 131 drivers against 30, 4 543.9 against 240), and
  the lookups as they stood before this change, replayed over the same drivers, return the same slots and
  exceed the bound wherever they did (10 917.9 against 270 on the ten-question fixture, 13 622.5 against
  1 377 at fifty-one slots).

## Out of scope

The `touched` lookup and the reconciliation-wide (`affected === 'all'`) anchor lookup keep their plain
joins; neither is on the bounded path this change is about, and moving them would widen the diff without a
measurement behind it. No schema change, no new index, no second reader, and no change to the dispute model
of decision 0039: the same SQL is issued in the same place, with a plan that no longer escapes its driver
list.

## Preserved contracts

- graph-queries/as-of: every anchored assertion resolves to the same subject, kind and property at the asked valid time and recorded time, in the same order, for a vertex subject and an edge subject alike — `test/dispute-reconciliation-batch.test.ts` keeps every case and every assertion (the golden scenarios, the clock and endpoint counts, the statement and row counts of the affected-slot cases, the withdrawal outcome, and its own `drivers <= expected` and `work <= probes(plan) * expected` bounds for both the direct and the dependent lookup), `test/dispute-anchor-plan.test.ts` compares the direct lookup's slot rows, sorted, with the slots the operation wrote, including an edge subject, the dependent lookup keeps its coverage in the withdrawal case of `test/dispute-reconciliation-batch.test.ts`, which walks an evidence dependency through the same subject statements, and the single-file timings baseline keeps its entry for `test/dispute-anchor-plan.test.ts`, remeasured on the box at 20 430 ms for the whole file.

## Coverage

- graph-queries/as-of: static, test, mutation, review

## Where it is seen

Kind: internal
Place: the store's dispute reconciliation, on the deferred path that runs after an operation's own
   assertions; it has no command, page or route of its own.
Reason: the plan and its work bound are the whole change; a person reading a dispute, a page or a
   command sees the same rows as before.
1. Run `bun test test/dispute-anchor-plan.test.ts`: the reproduced case at `enable_seqscan=off` and the two
   default-settings cases on the 200-question catalogue stay inside the bound at the statistics `ANALYZE`
   leaves, and the whole-graph replay of the same lookup leaves it.
2. On the tree before this change the same file fails the reproduced case (998.9 against 270) and the
   fifty-one-slot case (13 622.5 against 1 377), with the hash join and the sequential scan named above.

## Blocking questions

None.
