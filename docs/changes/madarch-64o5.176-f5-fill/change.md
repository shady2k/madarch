# Read the current values, not the history, on the fill's own path

Change: madarch-64o5.176-f5-fill
Base: b7c33e596
Tasks: madarch-64o5.176
Kind: no-behavior

## Intent

Make the one typed assertion read (`src/graph/assertion-read.ts`) narrow its rows before it pays for
values, lineage and repository targets, and give callers that only read current values an explicit
mode that returns the selected assertion of each stream and the ones that still stand. Account graph
changes once per statement instead of once per row, and answer a producer's facts, a catalogue value
and a snapshot's key-edge references in one statement each.

## Out of scope

- The database schema: no new index, no denormalised `(subject, property)` storage, no change to the
  graph tables, their constraints or their triggers other than the change-accounting trigger.
- The selection rule of decision 0039 item 25: the same base, source layer, recorded and valid-time
  windows, in the same order.
- Foreign keys on `edge`, the provenance edges of every assertion and every repeat,
  `assertion_vertex_subject`, the immutability triggers, `recorded_sequence`, the single writer under
  `acquireGraphWriteLock` and the bounds of the deferred check of item 28.

## Rationale

An in-process `status-work` fill makes about 12,100 statements and spends about 82 s of the process's
wall inside `db.statement` (box `alx1788-perf`, `b7c33e596`, two rounds). Typed assertion reads are
1,721 of those statements and 31.7 s of that time; the insert batch of every publish is 24.9 s.

The read left its whole history inside `raw`: every row carried its typed value, its five provenance
edges aggregated into six lineage fields, and its subject's repository targets, and the unit filter was
counted twice per row because the narrowed rows were a CTE referenced from several places.

The read now leaves `raw` a narrow header — assertion, subject, property, context, language, operation,
valid and recorded bounds, sequence, the source of one index pass and one unit flag — and attaches
values, lineage and repository targets to the rows the selection kept. `repository_targets` is answered
once per subject rather than once per row, and a subject-bounded read follows the subject's own
attachment instead of letting the planner trade that for a walk over every assertion of the kind. The
history read is unchanged in what it returns; the current-values mode is a filter on the same selection,
and only a caller that reads `selected`, `active`, `values`, `selectedAssertions` or `activeSources`
turns it on.

The change-accounting trigger ran four `set_config` calls per inserted row. It now runs once per
statement over the rows the statement inserted and leaves the same least id, the same value tables and
one revision per row. A statement's rows are accounted after its row triggers fire, so a check that
immediate constraints fire inside the statement sees the accounting without them; the accounting
repeats that check once the rows are in.

The fill also read a producer's facts one kind per statement, a catalogue value's key-edge references
one row per statement, and a run's incident edges through a plan that could follow the store rather than
the ids it was given; each of the three now follows its own input.

## Preserved contracts

- graph-queries/as-of: a history read returns the same rows, flags and lineage as before, and the current-values mode returns exactly the rows of that history that are selected or active.
- fill-orchestrator/publish: every assertion, its provenance and its subject still enter through the one writer, and the deferred graph check still refuses an invalid commit.
- graph-queries/view: evidence and its attachments are still read from the selected and historical rows a reader asks for, and a producer's own facts still gather evidence over its whole history.

## Coverage

- graph-queries/as-of: test
- fill-orchestrator/publish: test
- graph-queries/view: test

## Where it is seen

Kind: internal
Place: `src/graph/assertion-read.ts`, `src/adapters/schemas/graph-definition.ts`, `src/graph/fill-state.ts`, `src/graph/producer-facts.ts`, `src/graph/plugin-turns.ts`
Reason: the change shortens the work behind the fill's own reads and the graph write barrier.

1. Fill the status fixture: the same assertions are written and the same current values are answered.
   On the box the fill takes 128.2 s against 135.5 s, the insert batch of a publish 22.2 s against
   24.9 s, and a typed read answers 90,945 rows against 106,537 while spending the same 31 s.
2. Read one kind's history and the same kind's current values: the second answer is the first one
   filtered to the rows that are selected or active.
3. Insert the same rows in one statement and one by one: the change accounting the graph check reads
   is identical, and a statement that inserts no row changes nothing.
4. Read the fill state of a run beside two unrelated runs of fifty units: the read follows its subject,
   not the store.

## Blocking questions

None.
