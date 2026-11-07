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
import type { RecordPassWiring } from '../steps.js';
import { createRepositoryHistoryStage, createRepositoryTreeStage } from './repository-facts.js';
import type { AgentStageWiring } from './agent-stage.js';
import { createGitHistoryReader, createHistoryStage, type CheckoutFolderOf } from './history.js';

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
  /** What this step's two passes publish through: the record store's own writes (src/graph/records.ts). */
  readonly records?: RecordPassWiring;
}

/** The folder a run that wired no Git answers with: no folder, which the history stage refuses by name. */
const noCheckout: CheckoutFolderOf = () => '';

/**
 * Every stage this madarch knows, over a wiring that reads no repository: the ids a
 * product's workflow may name, and the declarations the workflow check derives their
 * producers from (decision 0033, items 1 and 2). A run registers the stages its own
 * wiring can read — the agent stages only where the run names an agent — and this
 * registry is read, never driven: no run takes its stages from here, and the source
 * it stands over answers no repository.
 */
export function createEngineStageRegistry(): StageRegistry {
  return createStageRegistry({
    // The engine's registry names the stages a workflow may name; it never runs one, so a pass
    // it holds publishes nowhere and says so by name.
    records: {
      publishTree: async () => { throw new Error('the engine stage registry runs no pass: a workflow names stages, and a run publishes through runFill (src/fill/stages/index.ts)'); },
      publishHistory: async () => { throw new Error('the engine stage registry runs no pass: a workflow names stages, and a run publishes through runFill (src/fill/stages/index.ts)'); },
    },
    snapshots: {
      pins: async () => [],
      open: async (repository: string) => {
        throw new Error(`the engine's stage registry reads no repository: it names the stages a workflow may name, and no run takes its stages from it (asked for ${JSON.stringify(repository)})`);
      },
    },
    // The engine's agent stages are registered only over a named agent. The check names one
    // nothing runs, so the registry it reads holds every stage this madarch knows.
    agent: { agent: { id: 'engine-stage-registry', command: 'engine-stage-registry' } },
  });
}

/**
 * Every stage of this madarch, registered over the run's wiring: stage 0 the
 * snapshot, stage 1 the inventory, stage 2 the build and configuration, stage 3
 * the syntax, stage 4 the semantic resolution, stage 5 the modules, stage 6 the
 * document index and stage 7 the history. The order of the calls is not the order the stages run in
 * — the graph decides that from what they declare — so a stage added anywhere in
 * the chain lands correctly.
 */
export function createStageRegistry(wiring: FillStageWiring): StageRegistry {
  // This step's fill: the two passes, and nothing else. Every other stage stays in the code,
  // out of the fill's path, and comes back by a line in `FILL_STEP_IDS` when its step comes
  // (madarch-8bdc.2.5, item 6); the agent machinery is untouched and simply not registered.
  const records = wiring.records;
  if (records === undefined) {
    throw new Error('the fill registry needs the record pass wiring: the two passes of this step publish through src/graph/records.ts (src/fill/stages/index.ts)');
  }
  return new StageRegistry()
    .register(createRepositoryTreeStage({ sources: wiring.snapshots, ...records }))
    .register(createRepositoryHistoryStage({ sources: wiring.snapshots, ...records }));
}
