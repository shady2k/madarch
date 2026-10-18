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
import { createBuildConfigurationStage } from './build-configuration.js';
import { createDocumentIndexStage } from './document-index.js';
import { createGitHistoryReader, createHistoryStage, type CheckoutFolderOf } from './history.js';
import { createInventoryStage } from './inventory.js';
import { createSnapshotStage } from './snapshot.js';
import { createSyntaxStage } from './syntax.js';

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
}

/** The folder a run that wired no Git answers with: no folder, which the history stage refuses by name. */
const noCheckout: CheckoutFolderOf = () => '';

/**
 * Every stage of this madarch, registered over the run's wiring: stage 0 the
 * snapshot, stage 1 the inventory, stage 2 the build and configuration, stage 3
 * the syntax, stage 6 the document index and stage 7 the history. The order of
 * the calls is not the order the stages run in — the graph decides that from
 * what they declare — so a stage added anywhere in the chain lands correctly.
 */
export function createStageRegistry(wiring: FillStageWiring): StageRegistry {
  return new StageRegistry()
    .register(createSnapshotStage(wiring.snapshots))
    .register(createInventoryStage(wiring.snapshots))
    .register(createBuildConfigurationStage(wiring.snapshots))
    .register(createSyntaxStage(wiring.snapshots))
    .register(createDocumentIndexStage(wiring.snapshots))
    .register(createHistoryStage(createGitHistoryReader(wiring.checkoutOf ?? noCheckout)));
}
