# Store schema ownership

`src/adapters/prepare-store.ts` is the preparation entry point. The process owning the daemon invokes it before publishing a store to API and fill clients. Changed pinned contracts and new source databases are explicit owner requests. The owner serializes those requests; a source command without a daemon runs its own owner scope. Clients import `store-readiness.ts`, not preparation.

## Registering a module schema

Authored entities (`feature/madarch-gzaz`) and `agent_usage` (`feature/madarch-stm0.4`) must put DDL in `src/adapters/schemas/<module>.ts`. Export a `StoreSchema` object with `name` and `prepare(owner)`. Add it to `MODULE_SCHEMAS` in `prepare-store.ts`. Use `createSchemaOnce` to stamp the statements and to run table creation or upgrades in the store schema transaction. Do not call that helper from a runtime constructor. Runtime access calls `requireSchema(owner, name)` before querying. Module schemas should reference shared table-name constants rather than copy names.

Tests obtain an owner from `createTestDatabaseOwner`, which invokes the production preparation entry point. A test of an unprepared store uses raw `createDatabaseOwner` and explicitly invokes `prepareStore` when its owner prepares the store. Custom graph fixtures pass `graphContract`; custom queues pass explicit declarations to `prepareStore`.

## Graph contract changes

The graph stamp includes the full contract with recursively sorted object keys. Owner preparation reconciles supported field changes. It refuses a changed existing kind's checks or index declarations rather than recording a successful stamp for constraints it did not migrate. A legacy store has no saved constraint declaration: its first owner preparation records that baseline, so historical declaration changes before this baseline cannot be inferred. Such a legacy change needs an explicit owner migration or reset.

## Dependency-owned queue DDL

pg-boss migrations and queue creation run only during preparation. Queue consumers disable schema creation and migrations. Stats partition creation and automatic reindexing are disabled because those maintenance paths can execute DDL. Lease recovery remains available. A missing queue declaration is a preparation error, not permission for a client to create a table.
