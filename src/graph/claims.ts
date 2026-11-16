/**
 * A plugin's answer as the one writer applies it (decision 0035, item 6, and
 * decision 0039, item 13): a unit's answer is one vertex per entity with the
 * claims it makes and one removal per entity the unit no longer holds, and this
 * module hands them to the writer inside the transaction that also publishes the
 * generation and settles the unit's job. Nothing is kept between the attempt and
 * that transaction — there is no draft — so an answer is accepted or refused once,
 * with the generation's own record beside it.
 *
 * The contract is the one the manifest's declarations made, so the writer knows
 * the kind, its table and its columns without naming a product's kind; a write of
 * a kind the contract does not hold is refused by the writer, and the publication
 * rolls back with it.
 */
import type { SqlExecutor } from '../sql-driver.js';
import type { GraphContract, VertexDraft, VertexRemovalDraft } from './contract.js';
import { publishGraphDrafts, type EdgeDraft, type EdgeRemovalDraft, type JournalRead } from './write.js';

/** One write of a unit's answer, as the orchestrator holds it: its kind and its value. */
export interface UnitWriteLike {
  readonly kind: string;
  /** What the write cites, as the unit answered it; the writer takes its evidence from the write's own value. */
  readonly evidence?: string;
  readonly value: unknown;
}

/**
 * Applies one unit's graph writes inside the publication's transaction, and
 * answers how many rows were written (a rerun of the same answer writes none).
 */
export async function publishGraphWrites(
  executor: SqlExecutor,
  contract: GraphContract,
  writes: readonly UnitWriteLike[],
  /** The unit whose answer these writes are, and what it published: the journal row names both, so a reader of
   * the graph's history can say which unit wrote a fact (decision 0039, item 13). */
  unit?: { readonly runId: string; readonly unitId: string; readonly generation: number; readonly digest?: string },
): Promise<number> {
  const vertices = writes.filter((write) => write.kind === 'vertex').map((write) => write.value as VertexDraft);
  const edges = writes.filter((write) => write.kind === 'edge').map((write) => write.value as EdgeDraft);
  const removals = writes.filter((write) => write.kind === 'vertex-removal').map((write) => write.value as VertexRemovalDraft);
  const edgeRemovals = writes.filter((write) => write.kind === 'edge-removal').map((write) => write.value as EdgeRemovalDraft);
  // A plugin's turn states its entry's author and the requests it made (under the debug setting) as one of its
  // writes; a publication without one is named by its first vertex's producer.
  const journal = writes.find((write) => write.kind === 'journal')?.value as { author: string; reads?: readonly JournalRead[] } | undefined;
  if (vertices.length === 0 && edges.length === 0 && removals.length === 0 && edgeRemovals.length === 0 && (journal?.reads ?? []).length === 0) return 0;
  return await publishGraphDrafts(executor, contract, { vertices, edges, removals, edgeRemovals }, 1, {
    ...(journal === undefined ? {} : { author: journal.author }),
    ...(journal?.reads === undefined ? {} : { reads: journal.reads }),
    ...(unit === undefined ? {} : {
      session: `${unit.runId}:${unit.unitId}/${String(unit.generation)}`,
      words: `unit ${unit.unitId} generation ${String(unit.generation)} of run ${unit.runId}${unit.digest === undefined ? '' : `, publication ${unit.digest}`}`,
    }),
  });
}
