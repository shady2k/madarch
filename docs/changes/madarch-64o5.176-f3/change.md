# Bound deferred graph relation checks to the change

Change: madarch-64o5.176-f3
Base: 4316c762dc07f0b08e961b857f505ec07740fc83
Tasks: madarch-64o5.176
Kind: no-behavior

## Intent
Keep deferred relation validation proportional to the graph change. Check the ends of changed
edges and edges incident to vertices whose existence or projection changed. Count relations only
at affected vertices and on the bounded sides of the relevant edge kinds.

## Rationale
An edge change at a shared repository or catalogue vertex previously pulled unrelated edges into
cardinality validation. Those edges added work to each check and could introduce additional valid
time boundaries. Decision 0039, item 28 calls for evaluating the affected part of the graph.

## Out of scope
- Changes to assertion storage, graph write ownership, catalogue publication, or Fill bookkeeping.
- Changes to the rules for existence, endpoint kinds, cardinality, and the refusals they produce.

## Preserved contracts
- fill-orchestrator/publish: each publication validates the assertions and the effective graph before the operation commits.
- graph-queries/as-of: relation validation uses the same effective vertices and edges at each applicable time and in each affected context.

## Coverage
- fill-orchestrator/publish: static, test
- graph-queries/as-of: static, test

## Where it is seen

Kind: internal
Place: `src/adapters/schemas/graph-definition.ts`
Reason: the change reduces the work behind the graph write barrier.

1. Publish one edge whose parent has many unrelated children. The barrier reads the same number
   of rows and checks the same valid times as when the parent has one unrelated child.
2. Publish an edge that overlaps another at a bounded end. The barrier refuses the operation.
3. Fill the status fixture and republish a reduced starter catalogue. Both operations complete
   through the normal graph write barrier.

## Blocking questions
None.
