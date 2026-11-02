/**
 * The publication scope of one static unit (decision 0027's "a unit's
 * publication replaces only that unit's facts"; decision 0033's per-file
 * units). The graph store publishes under a `(producer, scope)` pair, so a
 * static unit needs a stable node identity to publish under. That identity
 * carries no version and no knowledge: it is the unit's name in the store's
 * scope vocabulary, recorded once in `fill_graph_scope` so a later run of the
 * same unit publishes under the same scope and corrects its own versions
 * rather than opening a second node.
 */
import type { GraphStore, GraphId } from '../../graph/index.js';
import type { OuterTransaction } from '../../history/types.js';

/** The table that ties a fill unit to its graph publication scope. */
export const STATIC_GRAPH_SCOPE_TABLE = 'fill_graph_scope';

/** The SQL that creates the table; `createOrchestratorSchema` runs it with the fill's other tables. */
export const STATIC_GRAPH_SCOPE_SCHEMA = `CREATE TABLE IF NOT EXISTS ${STATIC_GRAPH_SCOPE_TABLE} (
  unit_id text PRIMARY KEY,
  node_id bigint NOT NULL
)`;

/**
 * The node identity one unit publishes under, created on first use inside the
 * caller's transaction. The identity is a bare `node_identity` row: no version
 * is opened for it, and no read sees it as a node. Two callers that race for
 * one unit's first publication both insert, and the second reads the first's
 * row, so a unit never publishes under two scopes.
 */
export async function staticScopeOf(executor: OuterTransaction, store: GraphStore, unitId: string): Promise<GraphId> {
  const found = await executor.query<{ node_id: string }>(`SELECT node_id::text AS node_id FROM ${STATIC_GRAPH_SCOPE_TABLE} WHERE unit_id = $1`, [unitId]);
  if (found.rows[0] !== undefined) return found.rows[0].node_id;
  const made = await store.newNode(executor);
  const inserted = await executor.query<{ node_id: string }>(
    `INSERT INTO ${STATIC_GRAPH_SCOPE_TABLE} (unit_id, node_id) VALUES ($1, $2::bigint) ON CONFLICT (unit_id) DO NOTHING RETURNING node_id::text AS node_id`,
    [unitId, made],
  );
  if (inserted.rows[0] !== undefined) return inserted.rows[0].node_id;
  const raced = await executor.query<{ node_id: string }>(`SELECT node_id::text AS node_id FROM ${STATIC_GRAPH_SCOPE_TABLE} WHERE unit_id = $1`, [unitId]);
  const held = raced.rows[0];
  if (held === undefined) {
    throw new Error(`fill-graph: unit ${JSON.stringify(unitId)} was refused as a duplicate scope, and no row of ${STATIC_GRAPH_SCOPE_TABLE} holds it: a unit publishes under one scope (src/fill/stages/graph-scope.ts)`);
  }
  return held.node_id;
}
