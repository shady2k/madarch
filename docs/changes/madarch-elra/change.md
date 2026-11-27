# Verify plugin fill operation lineage

Change: madarch-elra
Base: 898838c8755a5341923ecf16e24d022bde4e662f
Tasks: madarch-elra
Kind: no-behavior

## Intent

Let graph writes resolve endpoints written earlier in the same transaction
when the database clock moves backward. The multi-output scenario checks the
active operation and its author and unit for each of the four plugin outputs.

## Out of scope

Fill progress delivery and plugin sandbox policy.

## Rationale

New assertions start at the transaction's timestamp by default. The graph
writer used the current wall clock to validate the endpoint, so a backward
clock correction could make an endpoint written by the same transaction appear
future-dated. Direct lookup, batched lookup, and publication validation use
the later of the current clock and the transaction start. Each batch uses one
instant across all endpoint kinds within its existing query.

## Changes to requirements

None.

## Preserved contracts

- fill-orchestrator/publish: each output traces to a published operation and its unit.
- server/identities: overlapping startup calls reuse the installed plugin's identity.

## Coverage

- fill-orchestrator/publish: static, test
- server/identities: static, test

## Where it is seen

Kind: command
Place: `bun test test/plugin-fill-scenarios.test.ts test/startup-binding.test.ts`

1. Fill A and B separately without a progress sink. Read each output's operation and verify its active author and unit edges.
2. Simulate a backward clock correction while a startup publishes its author edge, and while an operation links to a newly written unit. Verify both committed edges.
3. Write a unit and move the database clock backward in the same transaction. Resolve it in separate cases through the direct and batched lookup.
4. Overlap two startup calls on one write transaction, then read the committed operations and their author edges.
