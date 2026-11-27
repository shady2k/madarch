# Verify plugin fill operation lineage

Change: madarch-elra
Base: f8553165a01b81a01aaa41e54ada99c1269454d0
Tasks: madarch-elra
Kind: no-behavior

## Intent

Let a graph operation publish its author and unit edges when the database
clock moves backward during the write. The multi-output scenario checks the
active operation and its author and unit for each of the four plugin outputs.

## Out of scope

Fill progress delivery and plugin sandbox policy.

## Rationale

New assertions start at the transaction's timestamp by default. The graph
writer used the current wall clock to validate the endpoint, so a backward
clock correction could make an endpoint written by the same transaction appear
future-dated. The batch checks every endpoint at the later of the current
clock and the transaction start. This keeps the normal wall-clock check and
gives newly written endpoints a consistent lower bound.

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
3. Overlap two startup calls on one write transaction, then read the committed operations and their author edges.
