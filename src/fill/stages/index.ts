/**
 * The fill's registered stages (decision 0027): the one place a stage is
 * registered. A worker adding a stage adds its module and one `.register(...)`
 * line here, and names in that line only what the stage needs.
 *
 * The registry is built from the wiring a run has — today the pins of the
 * repositories it fills — so a stage reaches the checkout's bytes through the
 * snapshot reader and never through a path of its own. Two runs of one product
 * may be wired differently and are then two registries: what a registry holds
 * is every stage this madarch knows, and what it can read is the wiring's.
 */
import { StageRegistry } from '../registry.js';
import type { SnapshotSource } from '../snapshot.js';
import type { AgentStageWiring } from './agent-stage.js';
import { createBuildConfigurationStage } from './build-configuration.js';
import { createDocIntentStage } from './doc-intent.js';
import { createDocumentIndexStage } from './document-index.js';
import { createGitHistoryReader, createHistoryStage, type CheckoutFolderOf } from './history.js';
import { createIntentHistoryStage } from './intent-history.js';
import { createInventoryStage } from './inventory.js';
import { createModulesStage } from './modules.js';
import { createNarrativeStage } from './narrative.js';
import { createOverviewStage } from './overview.js';
import { createSemanticResolutionStage } from './semantic-resolution.js';
import { createSnapshotStage } from './snapshot.js';
import { createSyntaxStage } from './syntax.js';
import { createUnderstandingStage } from './understanding.js';

/** What a run's stages read from outside the graph: pinned repositories and their Git checkouts. */
export interface FillStageWiring {
  /** How stages read the pinned repository trees and bytes. */
  readonly snapshots: SnapshotSource;
  /**
   * The checked-out folder for a repository name, used by the Git history stage.
   * A run that leaves it out can hold every stage that reads no Git: the history
   * stage refuses each of its units, naming the wiring, rather than reading
   * somewhere it was not pointed at.
   */
  readonly checkoutOf?: CheckoutFolderOf;
  /**
   * The agent a run's agent stages are driven with (decision 0026, madarch-tzte.22.3
   * and 24.1). A run that wires none registers no agent stage at all, so a product
   * whose fill has no agent never plans a unit that could read nothing; a run that
   * wires one registers the agent stages of 0026 this build holds beside the
   * deterministic ones, in stage order.
   */
  readonly agent?: Omit<AgentStageWiring, 'snapshots'>;
}

/** The folder a run that wired no Git answers with: no folder, which the history stage refuses by name. */
const noCheckout: CheckoutFolderOf = () => '';

/**
 * Every stage of this madarch, registered over the run's wiring: stage 0 the
 * snapshot, stage 1 the inventory, stage 2 the build and configuration, stage 3
 * the syntax, stage 4 the semantic resolution, stage 5 the modules, stage 6 the
 * document index and stage 7 the history. The order of the calls is not the order the stages run in
 * — the graph decides that from what they declare — so a stage added anywhere in
 * the chain lands correctly.
 */
export function createStageRegistry(wiring: FillStageWiring): StageRegistry {
  const registry = new StageRegistry()
    .register(createSnapshotStage(wiring.snapshots))
    .register(createInventoryStage(wiring.snapshots))
    .register(createBuildConfigurationStage(wiring.snapshots))
    .register(createSyntaxStage(wiring.snapshots))
    .register(createSemanticResolutionStage(wiring.snapshots))
    .register(createModulesStage(wiring.snapshots))
    .register(createDocumentIndexStage(wiring.snapshots))
    .register(createHistoryStage(createGitHistoryReader(wiring.checkoutOf ?? noCheckout), wiring.snapshots));
  // The agent stages stand only where the run names the agent they are driven with: an agent unit's whole work is
  // a session with that agent (0026), and a stage registered without one would plan units that could not run. They
  // are registered one per stage of 0026 as each lands (madarch-tzte.24.1 lands stage 8): the landed agent unit of
  // 22.3 is the shape's own reference declaration (`agent-unit.ts`) and is no stage of a run.
  if (wiring.agent !== undefined) {
    const agent = { snapshots: wiring.snapshots, ...wiring.agent };
    registry.register(createOverviewStage(agent));
    registry.register(createDocIntentStage(agent));
    registry.register(createIntentHistoryStage(agent));
    // Stage 12 of 0026 (madarch-tzte.24.5): the modules understood bottom-up, each parent from its children's
    // bounded summaries, on the agent-stage shape.
    registry.register(createUnderstandingStage(agent));
    // The pages stage of 0026 (madarch-tzte.25.1): a page's narrative text, each sentence tied to its facts.
    registry.register(createNarrativeStage(agent));
  }
  return registry;
}
