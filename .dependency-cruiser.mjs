/**
 * The architecture's import rules (decision 0033, item 4): dependency rules over
 * the import graph. `bun run check` runs them through
 * scripts/check-architecture.ts (src/check/architecture/dependency-rules.ts) and
 * every violation they report must be listed in .architecture/violations.json,
 * a list that only shrinks.
 *
 * A rule is named for what a reader has to be able to say about the code. The
 * rules name modules, packages and APIs — configuration, not parsing: nothing
 * here reads source text, and the source is read by swc and by dependency-cruiser
 * themselves.
 *
 * Type-only imports count as dependencies. A module that imports a connection's
 * type can run a statement through it, and the decisions that keep one writer and
 * one storage layer are about what a module can do, not about what survives
 * transpilation.
 *
 * What the rules govern is the product: the modules of src/ and the programs of
 * scripts/. They do not govern test/ (a test holds a database and starts a fill
 * to exercise the product, so it stands beside the architecture, not in it),
 * .shady2k/ (the tracker's tooling) or wiki/app/ (the browser app, a package of
 * its own). Reachability (knip, src/check/architecture/reachability.ts) covers
 * all of them, because dead code is waste wherever it lies.
 */
export default {
  forbidden: [
    {
      name: 'graph-single-writer',
      severity: 'error',
      comment:
        "The graph's publication API (src/graph/publish.ts) is the one writer of the graph store (decision 0033, item 3: one writer per store). Only the graph store's own modules (src/graph) and the storage layer (src/adapters) may import it; every other module reads through the store's interface and hands its draft to the store, which publishes it.",
      from: { pathNot: '^(src/graph|src/adapters)/' },
      to: { path: '^src/graph/publish\\.ts$' },
    },
    {
      name: 'no-retired-surfaces',
      severity: 'error',
      comment:
        'Decision 0033, item 6: the extract driver (src/extract), the fill_fact store\'s history and query surfaces (src/history, src/query) are replaced and deleted, never left for later. No module imports them: the fill reads git through the record passes (src/fill/stages/repository-facts.ts) and publishes through the record store (src/graph/records.ts).',
      from: { pathNot: '^$' },
      to: { path: '^(src/extract|src/history|src/query)(/|$)' },
    },
    {
      name: 'sql-only-in-storage-layer',
      severity: 'error',
      comment:
        'Only the storage layer holds a connection or runs a query (decision 0033, item 3). Read from src/adapters/database-owner.ts and its users, what runs a query is: the database connection itself (the owner), the query interface an executor answers (src/sql-driver.ts, whose SqlExecutor.query is the statement a module runs), and the database clients (the PostgreSQL driver and the queue). Only src/graph (the graph store) and src/adapters (the storage layer) may import any of them; every other module asks a store.',
      from: { pathNot: '^(src/graph|src/adapters)/' },
      to: {
        path: '^(src/adapters/database-owner\.ts|src/sql-driver\.ts|pg|pg-boss)(/|$)',
      },
    },
  ],
  options: {
    // TypeScript 7 has no JavaScript API (AGENTS.md), so dependency-cruiser's
    // tsc parser cannot read this repository: swc parses the same files and
    // marks the same type-only imports. @swc/core is a dev dependency for it.
    parser: 'swc',
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)node_modules/|^wiki/app/dist/|^vendor/|^build/' },
  },
};
