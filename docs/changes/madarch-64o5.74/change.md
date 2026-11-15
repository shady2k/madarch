# Checked graph edge endpoints: first foundation increment

Change: madarch-64o5.74
Base: 46459a319240b88b5a218c07ee0646ba0ef28856
Tasks: madarch-64o5.74, madarch-64o5.141
Kind: behavior

## Intent
Enforce declared endpoint kinds and stored uid bindings in the one graph writer (decision 0039 item 1). Refuse removed and cross-context endpoints instead of attaching new edges to them. This is a partial increment, not completion of either task.

## Out of scope
- Missing-endpoint refusal and deletion of unresolved_reference/liftedReferences.
- Reference-field removal, parent-edge keys, federation identity, cardinality and deferred triggers.
- Bitemporal assertions, graph lineage, source permissions, disputes, resolutions and item 24 receipts/fencing.
- Starter plugin/catalogue conversion and read-model replacement.

## Preserved contracts
None.

## Coverage
- graph-storage/edge-endpoints: test, mutation

## Where it is seen
Kind: internal
Place: src/graph/write.ts
Reason: The common SQL writer checks each endpoint before edge publication; no screen changes.
- Publish an edge whose declared end kind differs, or whose uid belongs to another kind.
- Observe a refusal naming the writer's full path and line, with no committed vertex, edge or journal changes from the transaction.
- Publish an edge to a removed or different-context identity and observe refusal.

## Blocking questions
None.

## Design and decisions
The writer checks allowed endpoint kinds before reading identities. It locks the resolved node rows with FOR SHARE, verifies stored kind, context and removal state, and keeps the query inside graph.edge.endpoints. No storage objects, compatibility paths or constants are added. Existing missing-key recording remains unfinished legacy behavior, not a newly introduced fallback.

## Acceptance evidence
- Bun 1.4.2; PostgreSQL suites run as debian (the available non-root account).
- bun run check: passed, 1229 existing listed architecture findings; no added debt.
- bun test test/graph-edge-endpoints.test.ts test/graph-write.test.ts test/plugin-agent-reference.test.ts: 44 passed, zero failed, 202 assertions.
- wiki/app: frozen install, check and tests passed; 129 tests, zero failures, 622 assertions.
- Bounded manual mutation: individually disabled declared-kind, uid-kind, context and removed guards. All four runs failed the new suite. Every mutation restored.
- Full backend suite, Stryker and full foundation acceptance not run. No fill or real agent run.
