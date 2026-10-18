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
import { createGitHistoryReader, createHistoryStage, type CheckoutFolderOf } from './history.js';

/** What a run's stages read from outside the graph: pinned repositories and their Git checkouts. */
export interface FillStageWiring {
  /** How stages read the pinned repository trees and bytes. */
  readonly snapshots: SnapshotSource;
  /** The checked-out folder for a repository name, used by the Git history stage. */
  readonly checkoutOf: CheckoutFolderOf;
}

/** Registers current deterministic stages over this run's wiring. */
export function createStageRegistry(wiring: FillStageWiring): StageRegistry {
  return new StageRegistry()
    .register(createSnapshotStage(wiring.snapshots))
    .register(createInventoryStage(wiring.snapshots))
    .register(createHistoryStage(createGitHistoryReader(wiring.checkoutOf)));
}
