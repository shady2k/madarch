# Resolve the fill engine's own vertices by identity, and bind its writer once

Change: madarch-64o5.176
Base: 4316c762dc07f0b08e961b857f505ec07740fc83
Tasks: madarch-64o5.176
Kind: no-behavior

## Intent
Keep the behaviour of decision 0039's fill and publication exactly as it stands and stop paying for
reading it. A run's name, a chain's product and a unit generation name one vertex for the life of a
store, so the engine remembers the identity a name resolved to instead of walking the name's value
table to it in every transaction; a producer's installation — its product, its plugin and the rights
it writes under — is discovered once per contract revision and granted permissions, checked against
the store before it is used, and bound from what the process installed. Service reads also read their
own writes at the statement's own start instead of paying a `clock_timestamp()` round-trip each.

## Out of scope
- The model of decision 0039 (items 25, 30 and 31): one writer, an operation per transaction, a
  verifiable assertion for every record, and the engine's state as graph vertices are unchanged.
- The deferred graph check (item 28's `graph_checks_pass`) and the catalogue kind removal path: both
  stay as they are, and the stream's later PRs own them.
- What a unit's generation, a run's state or a chain's step means, and every refusal those machines
  make.

## Rationale
The fill's trace put 12 438 of 14 824 statements and 53.1 s in the engine reading itself:
`system.run` 774 times, `system.unit` 598 times, the write rights rebuilt 154 times in 10.9 s. Those
are defects of how the engine reads itself, not of the model, so they are fixed in the reading.

## Preserved contracts
- fill-orchestrator/admit: the count is taken under the run's own lock, and the pass's snapshot answers a candidate's slots only while the store's stamp still holds under that lock.
- fill-orchestrator/staleness: a run's reads and its units' cache keys are rechecked as before, and a generation is answered as the one in force only while its own record says so.
- fill-orchestrator/publish: one publication per unit generation, attributed to the operation its transaction opened.
- graph-queries/as-of: every answer is for a time on both axes and item 25's selection stands unchanged; a read of a transaction's own writes stands at the statement's start, after every statement before it.

## Coverage
- fill-orchestrator/admit: static, test
- fill-orchestrator/staleness: static, test
- fill-orchestrator/publish: static, test
- graph-queries/as-of: static, test

## Where it is seen

Kind: internal
Place: `src/graph/fill-state.ts`, `src/graph/manifest-publication.ts`, `src/graph/records.ts`
Reason: the engine's own reads and its writer's binding change cost, not behaviour.

1. Run one fill of a product and read the graph it published: the same run, units, steps and
   operations stand as before.
2. Run a store's start over and fill again: the new store's installation is discovered again.
3. Ask a status page while a fill runs: the same run, units and progress are answered.

## Blocking questions
None.

## Design and decisions
`src/graph/store-identity.ts` holds the store's identity — the oid of the graph's own table, which a
start over replaces — and what a process remembers about that store, so a reset empties it. Fill state
remembers `run_name` → uid, `product_name` → chain uid and (unit name, generation) → uid, and reads the
record by its id; the generation a bare name stands on is answered from memory only while that
generation's own record carries no replacement and stands in no state a run gives up on (a stale
generation, or one a run may retry), which is the only way a replacement is opened. Publication
remembers a producer's installation per contract revision and granted permissions, and reads the
product and the plugin's metadata as one batch before it binds from it, so a changed installation
(another version, a lost identity, another store) is discovered and repaired as before. What one
transaction finds or makes about a store is remembered only when that transaction commits
(`TransactionMemory`, published through the owner's `afterCommit`), so a planning transaction that
rolled back leaves no generation to be answered as standing by the next one. Reads that must see a
transaction's own writes ask for `currentStatement` instead of reading a clock first, and the
fill's service reads do so.

Measured on box alx1788-perf, one in-process fill of the status-work fixture: 15 103 statements to
11 958 (-21 %), clock round-trips 1 989 to 272, installation discoveries 154 to 15, installation
locks 400 to 261, the fill 146.3 s to 137.3 s. The same trace counts the engine's reads of its own
vertices before the change: 463 name lookups of `system.run` and 372 of `system.unit` — each a walk
from the name's value table to the vertex — beside 284 and 117 record reads by id. After it, neither
name lookup stands among the fill's 20 most frequent statements (the least of those ran 134 times),
and the reads that answer the same question by id rose from 402 to 703 statements. The reads
therefore still happen once per transaction, by identity, which is what F1.3 leaves to F5. A
scheduler pass resolves no service vertex by name after the first, whatever the run holds
(test/scheduler-snapshot.test.ts), repeated transactions at an unchanged revision read no
installation identity (test/startup-binding-cache.test.ts), and a planning transaction that rolled
back leaves no generation behind (test/fill-state-identity-cache.test.ts).
