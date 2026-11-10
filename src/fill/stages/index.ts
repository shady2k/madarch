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
 *
 * This step's fill runs the tree and the history of one repository
 * (madarch-8bdc.2.5, item 6), and they are the stages this registry holds.
 */
import { StageRegistry } from '../registry.js';
import type { SnapshotSource } from '../snapshot.js';
import type { RecordPassWiring } from '../steps.js';
import { createRepositoryHistoryStage, createRepositoryTreeStage } from './repository-facts.js';
import { createPluginTurnStage, type GraphOwner, type PluginTurnWiring } from '../plugin-turns.js';

/** What a run's stages read from outside the graph: pinned repositories and their Git checkouts. */
export interface FillStageWiring {
  /** How stages read the pinned repository trees and bytes. */
  readonly snapshots: SnapshotSource;
  /** What this step's two passes publish through: the record store's own writes (src/graph/records.ts). */
  readonly records?: RecordPassWiring;
  /** Whether the product declares the git capability; a product that does not runs neither pass. */
  readonly git?: boolean;
  /** The product's plugins and the graph their turns read, when the product holds a manifest with plugins. */
  readonly plugins?: PluginTurnWiring;
}

/**
 * What a registry built without the record pass publishes: nothing, refused by name. A registry that is read for
 * its stage set (the engine's, a test's derived graph) runs no pass; a run is handed the record wiring by `runFill`.
 */
const noRecords: RecordPassWiring = {
  publishTree: async () => { throw new Error('this registry was given no record pass wiring: a run publishes through runFill and the record store (src/fill/stages/index.ts)'); },
  publishHistory: async () => { throw new Error('this registry was given no record pass wiring: a run publishes through runFill and the record store (src/fill/stages/index.ts)'); },
};

/**
 * Every stage this madarch knows, over a wiring that reads no repository: the ids a
 * product's workflow may name, and the declarations the workflow check derives their
 * producers from (decision 0033, items 1 and 2). A run registers the stages its own
 * wiring can read, and this registry is read, never driven: no run takes its stages
 * from here, and the source it stands over answers no repository.
 */
export function createEngineStageRegistry(): StageRegistry {
  return createStageRegistry({
    // The engine's registry names the stages a workflow may name; it never runs one, so a pass
    // it holds publishes nowhere and says so by name (the registry's own `noRecords`).
    snapshots: {
      pins: async () => [],
      open: async (repository: string) => {
        throw new Error(`the engine's stage registry reads no repository: it names the stages a workflow may name, and no run takes its stages from it (asked for ${JSON.stringify(repository)})`);
      },
    },
    // The plugin turn is named here as every stage is; the registry plans nothing from it, and its plan answers no
    // unit because this manifest declares no kind (the product's manifest is the run's, never this one).
    plugins: {
      productFolder: '',
      manifest: { file: '', roles: new Map(), properties: new Map(), kinds: new Map(), groups: new Map(), excludeDocuments: [], ignoreBlocks: [], findings: [] },
      locks: new Map(),
      owner: { transaction: async () => { throw new Error('the engine\'s stage registry opens no store: it names the stages a workflow may name, and no run takes its stages from it (src/fill/stages/index.ts)'); } } as unknown as GraphOwner,
      snapshots: {
        pins: async () => [],
        open: async () => { throw new Error('the engine\'s stage registry reads no repository (src/fill/stages/index.ts)'); },
      },
      contract: { vertex: [], edge: [], dictionary: [] },
    },
  });
}

/**
 * Every stage of this madarch, registered over the run's wiring: this step's two
 * record passes — the tree and the history (madarch-8bdc.2.5).
 *
 * **Every stage stays registered; the fill's step list decides what runs.** This registry is the one place a stage
 * is declared, so the workflow check reads the ids a product may name and the declarations it derives producers
 * from, whatever steps this fill runs today. A run enables the stages of its workflow that are also in
 * `FILL_STEP_IDS` (`src/fill/run.ts` narrows the configuration), and the derived graph plans nothing else: a stage
 * out of the list is declared and never reached.
 */
export function createStageRegistry(wiring: FillStageWiring): StageRegistry {
  const records = wiring.records ?? noRecords;
  const registry = new StageRegistry();
  // A product that declares no kind the git reader fills runs neither pass: the manifest's capability binding is what
  // puts the reader in the fill's path (decision 0034, item 14). The engine's registry still names both stages for the
  // workflow check, because a product may declare the binding.
  if (wiring.git !== false) {
    registry
      // This step's two passes (madarch-8bdc.2.5): the tree and the history, published into the record store.
      .register(createRepositoryTreeStage({ sources: wiring.snapshots, ...records }))
      .register(createRepositoryHistoryStage({ sources: wiring.snapshots, ...records }));
  }
  // A product's plugins run after the tree stands: their units are the file vertices it published (decision 0035, item 15).
  if (wiring.plugins !== undefined) registry.register(createPluginTurnStage(wiring.plugins));
  return registry;
}
