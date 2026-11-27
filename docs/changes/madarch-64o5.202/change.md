# Resolve an anchored assertion's subject in one lateral probe

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

The measured cases, at the statistics `ANALYZE` leaves and compared with the same fixture on the same box:

- ten touched slots with `enable_seqscan=off` (the CI reproduction): 998.9 visited tuples against a bound of
  270 before, 109.9 after. The merge join over `assertion_edge_subject` and the 848-row `edge` scan are gone;
  every relation is an index probe.
- fifty-one touched slots at `catalog=200` with the default planner settings: 13 622.5 against 1 377 before,
  559.5 after. The sequential scan of `assertion_edge_subject` (612 rows) and the 12 453-row `edge` scan are
  gone.
- the same lookup fed every assertion in the graph stays out of bounds on both counts (3 103 drivers against
  153 expected, 7 611.5 visited tuples against 1 377), and the lookups as they stood before this change,
  replayed over the same drivers, return the same slots and leave the bound.

## Out of scope

The `touched` lookup and the reconciliation-wide (`affected === 'all'`) anchor lookup keep their plain
joins; neither is on the bounded path this change is about, and moving them would widen the diff without a
measurement behind it. No schema change, no new index, no second reader, and no change to the dispute model
of decision 0039: the same SQL is issued in the same place, with a plan that no longer escapes its driver
list.

## Preserved contracts

- `test/dispute-reconciliation-batch.test.ts` keeps every case and every assertion: the golden scenarios,
  the clock and endpoint counts, the statement and row counts of the affected-slot cases, the withdrawal
  outcome, and its own `drivers <= expected` and `work <= probes(plan) * expected` bounds for both the
  direct and the dependent lookup.
- Both lookups return the same rows in the same order, which the new file checks against the slots the
  fixture wrote, including an edge subject.
- The single-file timings baseline gains one entry, `test/dispute-anchor-plan.test.ts`, measured on the box
  at 24 221 ms for the whole file.

## Coverage

- madarch-64o5.202: static, test, review

## Where it is seen

Kind: internal
Reason: the plan and its work bound are the whole change; a person reading a dispute, a page or a command
sees the same rows as before.
1. Run `bun test test/dispute-anchor-plan.test.ts`: the reproduced case and the fifty-slot case stay inside
   the bound at the statistics `ANALYZE` leaves, and the whole-graph replay of the same lookup leaves it.
2. On the tree before this change the same file fails both positive cases: 998.9 against 270 and 13 622.5
   against 1 377, with the hash join and the sequential scan named above.

## Blocking questions

None.
