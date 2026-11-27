# Verify plugin fill operation lineage

Change: madarch-elra
Base: f8553165a01b81a01aaa41e54ada99c1269454d0
Tasks: madarch-elra
Kind: no-behavior

## Intent

Check the graph operations that publish the four outputs of a multi-output
plugin fill. Each operation must have one active author edge to the installed
plugin and one active unit edge to the unit that published the output.
Overlapping startup bindings must publish distinct operations under the same
installed plugin.

## Out of scope

Fill progress delivery and plugin sandbox policy.

## Rationale

The output assertion identifies the operation to read, so the scenario can
detect missing or misdirected lineage even when its output text is correct.
The overlapping startup test reads committed graph records to detect duplicate
plugin installations and attribution to another operation.

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
2. Overlap two startup calls on one write transaction, then read the committed operations and their author edges.
