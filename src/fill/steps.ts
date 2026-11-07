/**
 * The fill's one stage list (madarch-8bdc.2.5, item 6): this step's two passes, and
 * nothing else. A later step adds its stage here and in the registry's wiring, and
 * every caller — the wiki's button, `madarch fill`, the daemon, `madarch mcp`, scripts
 * and tests — runs it through `runFill` without a second list anywhere.
 *
 * The stages' own code stays in `src/fill/stages/` whether or not it is on this list;
 * a stage out of the list is out of the fill's path and comes back by a line here.
 */
import type { HistoryPublish, RecordCounts, TreePublish } from '../graph/index.js';

/** The ids this step's fill runs, in code point order: the one list. */
const FILL_STEP_IDS = ['repository-history', 'repository-tree'] as const;

/** What the two passes publish through: the record store's own writes, and the paths this fill covers. */
export interface RecordPassWiring {
  readonly publishTree: (input: TreePublish) => Promise<RecordCounts>;
  readonly publishHistory: (input: HistoryPublish) => Promise<RecordCounts>;
  /** The repository paths this fill covers, as prefixes; the whole tree when it is left out. */
  readonly paths?: readonly string[];
}

/** The steps of the one list, as a caller may name them. */
export function fillSteps(): readonly string[] {
  return [...FILL_STEP_IDS];
}
