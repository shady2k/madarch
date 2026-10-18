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
import { createInventoryStage } from './inventory.js';
import { createSnapshotStage } from './snapshot.js';

/** What a run's stages read from outside the graph: the repositories it pins. */
export interface FillStageWiring {
  /** How a stage opens the pinned repositories' trees and bytes (the snapshot reader, stage 0). */
  readonly snapshots: SnapshotSource;
}

/**
 * Every stage of this madarch, registered over the run's wiring: stage 0 the
 * snapshot, stage 1 the inventory. The order of the calls is not the order the
 * stages run in — the graph decides that from what they declare — so a stage
 * added anywhere in the chain lands correctly.
 */
export function createStageRegistry(wiring: FillStageWiring): StageRegistry {
  return new StageRegistry()
    .register(createSnapshotStage(wiring.snapshots))
    .register(createInventoryStage(wiring.snapshots));
}
