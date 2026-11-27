# Batch catalogue retirement in the graph writer

Change: madarch-64o5.176-f5-cat
Base: 1d316f07336e5df8cdea5571430740d57443419e
Tasks: madarch-64o5.176
Kind: no-behavior

## Intent

Shorten publication of a smaller catalogue by batching independent retirements
in the graph writer under decision 0039.

## Out of scope

- Changing the assertion model, source permissions, temporal selection or retirement policy.
- Rewriting the deferred graph check or changing the database schema.

## Rationale

Republishing the starter catalogue after removing 498 kinds spent minutes
repeatedly preparing the writer contract and looking up retraction languages
through assertion history. The graph writer now resolves retirement endpoints
and active incident edges in sets. It batches the language lookup and admission
for adjacent independent retirements under the existing graph write lock.

## Preserved contracts

- graph-queries/as-of: retirement appends assertions for the bound source and context. The earlier valid-time and recorded-time views and their evidence remain available.

## Coverage

- graph-queries/as-of: test

## Where it is seen

Kind: internal
Place: `src/graph/write.ts`, `test/graph-retraction-batch.test.ts`
Reason: republication of a smaller catalogue uses the existing assertion writer with fewer queries.

1. Publish the starter catalogue, remove kinds from the product and republish it.
2. Read the graph at an earlier valid or recorded time to see the former declarations and their evidence.
3. Retire a parent with a required child to exercise the declared restrict or cascade policy.

## Blocking questions

None.
