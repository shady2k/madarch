# State a machine transition in one admission

Change: madarch-64o5.176-f4
Base: f7b5c89b5
Tasks: madarch-64o5.176
Kind: no-behavior

## Intent
Reduce the number of graph admissions for fill transitions and operation commits. A fill
transition can state its own machine operation in the same batch as the state and journal
entry. The operation host batches publication of the operation and its links, then batches
completion and reads the counter and outcome scope together.

## Rationale
Each graph admission resolves identities, checks activity and scope, and inserts assertions.
Combining records that can be validated together reduces how often a transaction pays that cost.

When a first machine write opens a `fill-state` binding in a transaction and the store already
knows the installation, the binding publishes its operation vertex, author edge and first write
together. The binding enters the transaction cache after publication succeeds. First installation
publishes the engine identities and metadata before admitting the write. General callbacks open
their operation during binding, so direct and concurrent writes inside the callback can refer to
it, and writes can be retried after a savepoint rollback within the callback.

The operation host publishes the operation and its two links before `apply` so producer writes
can refer to the operation. It then reads the counter and scope in one batch, taking into account
any updates made by the producer. The receipt and the raised counter share an admission. Unit
state and outcome fields use separate admissions.

## Out of scope
- The assertion model, the single graph writer, its validation phases and the deferred graph check.
- Which source writes what: the unit's `state` stays the fill machine's own record, never an operation's.
- The producer's own writes inside an operation, catalogue publication and dispute judgement.

## Preserved contracts
- fill-orchestrator/publish: one operation's receipt, links, counters, outcome and the unit state that completes it are committed together or not at all, and a replay answers from the receipt.
- graph-queries/as-of: every assertion keeps its subject, source, operation lineage and recorded sequence, and a repeated value is deduplicated as before.

## Coverage
- fill-orchestrator/publish: static, test
- graph-queries/as-of: static, test

## Where it is seen

Kind: internal
Place: `src/graph/operation-host.ts`, `src/graph/fill-state.ts`, `src/graph/manifest-publication.ts`
Reason: the change reduces the fixed work each transaction pays, with no visible behavior change.

1. Complete one unit operation. The operation and its two links arrive in one admission before the
   producer writes, the receipt and the unit's raised counter in one after it; how far the unit got
   and the outcome's fields are admissions of their own beside those two.
2. Admit a unit in a new transaction after the store has installed `fill-state`. One admission
   carries the unit state, journal entry and the machine operation, and all the inserted assertions
   name that operation as their lineage.
3. Correct a refused first write and retry in the same transaction. The committed assertions
   name a published operation with an author.
4. Fill the status fixture. The same units reach the same states with the same recorded assertions.

## Blocking questions
None.
