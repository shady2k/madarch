/**
 * A plugin's answer as the publication applies it (decision 0035, item 6): the
 * stage drafts one unit of a plugin's turn writes — one vertex per entity with
 * the claims it makes, one removal per entity the unit no longer holds — and
 * this module hands them to the graph's one writer inside the transaction the
 * orchestrator publishes in. A draft of another kind is the fact store's and is
 * not this application's to write.
 *
 * The contract is the one the manifest's declarations made, so the writer knows
 * the kind, its table and its columns without naming a product's kind; a draft
 * of a kind the contract does not hold is refused by the writer, and the
 * publication rolls back with it.
 */
import type { SqlExecutor } from '../sql-driver.js';
import type { GraphContract, VertexDraft, VertexRemovalDraft } from './contract.js';
import { publishGraphDrafts, type EdgeDraft, type JournalRead } from './write.js';

/** One unit's draft set, as the orchestrator holds it: a write's kind and its value. */
export interface DraftWriteLike {
  readonly kind: string;
  /** Where the draft stands, as the fill's drafts state it; the writer takes its evidence from the draft's own value. */
  readonly evidence?: string;
  readonly value: unknown;
}

/**
 * Applies the vertex and removal drafts of one unit inside the publication's
 * transaction, and answers how many rows were written (a rerun of the same
 * answer writes none).
 */
export async function publishGraphWrites(executor: SqlExecutor, contract: GraphContract, writes: readonly DraftWriteLike[]): Promise<number> {
  const vertices = writes.filter((write) => write.kind === 'vertex').map((write) => write.value as VertexDraft);
  const edges = writes.filter((write) => write.kind === 'edge').map((write) => write.value as EdgeDraft);
  const removals = writes.filter((write) => write.kind === 'vertex-removal').map((write) => write.value as VertexRemovalDraft);
  // A plugin's turn states its entry's author and the requests it made (under the debug setting) as its own draft; a
  // publication without one is named by its first vertex's producer.
  const journal = writes.find((write) => write.kind === 'journal')?.value as { author: string; reads?: readonly JournalRead[] } | undefined;
  if (vertices.length === 0 && edges.length === 0 && removals.length === 0 && (journal?.reads ?? []).length === 0) return 0;
  return await publishGraphDrafts(executor, contract, { vertices, edges, removals }, 1, {
    ...(journal === undefined ? {} : { author: journal.author }),
    ...(journal?.reads === undefined ? {} : { reads: journal.reads }),
  });
}
