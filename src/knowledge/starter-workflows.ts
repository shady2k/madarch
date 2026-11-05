/**
 * The four starter workflows (decision 0033, items 1 and 2): a workflow is a
 * named set of the engine's stage ids, and the stages' capabilities give the
 * order — no edge is written here or in the product's file. `madarch new`
 * writes them into `madarch/workflows.yaml`, and from the first commit they
 * are the product's own data: a product edits the file to say which stages
 * its workflows run.
 *
 * This is starter content, not engine behaviour. The stage ids are the
 * registry's own (`src/fill/stages/index.ts`), never invented here: an id that
 * no stage holds fails the workflow check, of the starter set and of every
 * product alike. A workflow's status says what the engine can do with it
 * today — `implemented` names stages the registry holds whose required inputs
 * the workflow itself produces, and `planned` says the engine has no stage for
 * it yet, so it may name no stages.
 */

/** A workflow of the starter set: its name, its status, and the stage ids it runs. */
export interface StarterWorkflow {
  readonly name: string;
  readonly status: 'implemented' | 'planned';
  /** The engine's stage ids, in the order a reader reads them; a run derives their order from their capabilities. */
  readonly stages: readonly string[];
}

/**
 * The stages of a fill as the engine's registry holds them today (0026's stage 0
 * to 13 and the page stage): the eight deterministic stages, then the agent stages
 * a run registers when it names an agent, then the narrative stage that cites them.
 * The order is the one the capabilities derive, and a test holds it to the
 * registry's own derivation.
 */
const FILL_STAGES: readonly string[] = [
  'snapshot',
  'history',
  'inventory',
  'build-configuration',
  'document-index',
  'syntax',
  'semantic-resolution',
  'modules',
  'boundaries',
  'intent-history',
  'overview',
  'understanding',
  'recovery',
  'doc-intent',
  'narrative',
];

/**
 * The four workflows, in code point order of their names.
 *
 * - first fill: the whole walk, every stage a run registers today.
 * - update by commit: planned — the engine has no commit hook, no background
 *   server that picks a commit up and no per-file change set (0033, item 25;
 *   the stage is madarch-8bdc.6's), so running the fill at a new commit is a
 *   first fill again, not an update by commit.
 * - branch/worktree: a branch context names its own base, overlay and
 *   publication namespace (0033, item 26), and the engine has no stage for it.
 * - history point: a merge-base the graph does not hold is materialised as a
 *   chosen point (0030), and the engine has no stage for that either.
 */
export const STARTER_WORKFLOWS: readonly StarterWorkflow[] = [
  { name: 'branch-worktree', status: 'planned', stages: [] },
  { name: 'first-fill', status: 'implemented', stages: FILL_STAGES },
  { name: 'history-point', status: 'planned', stages: [] },
  { name: 'update-by-commit', status: 'planned', stages: [] },
];
