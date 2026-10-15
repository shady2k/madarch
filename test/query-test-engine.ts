import { createPGliteQueryDatabase } from '../src/adapters/pglite-query-database.js';
import { buildAsyncViewSet } from '../src/render/view-set.js';
import type { CompiledModel } from '../src/model/compile.js';
import type { QueryTime } from '../src/query/types.js';
import type { AsyncQueryEngine, QuerySnapshot } from '../src/query/types.js';
import type { Clock } from '../src/history/types.js';

const SOURCES = ['s', 'p', 'source', 'source-a', 'source-b', 'x', 'y', 'a', 'b', 'shop', 'payments', 'conformance', 'reference-system', 'independent'] as const;

/** Test owner for the async SQL query port. The tests seed multiple source names. */
export async function createTestQueryEngine(options: { clock?: Clock } = {}): Promise<AsyncQueryEngine> {
  const database = await createPGliteQueryDatabase(options);
  const engine = database.forSources(SOURCES);
  return {
    children: (...args) => engine.children(...args),
    view: (...args) => engine.view(...args),
    dependents: (...args) => engine.dependents(...args),
    dependencies: (...args) => engine.dependencies(...args),
    withSnapshot: <T>(work: (snapshot: QuerySnapshot) => Promise<T>) => engine.withSnapshot(work),
    rebuild: (assertions) => engine.rebuild(assertions),
    update: (opened, closed) => engine.update(opened, closed),
    close: async () => { await engine.close(); await database.close(); },
  };
}

export async function buildTestViewSet(engine: AsyncQueryEngine, model: CompiledModel, at?: QueryTime) {
  return engine.withSnapshot((snapshot) => buildAsyncViewSet(snapshot, model, at));
}
