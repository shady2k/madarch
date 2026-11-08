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
import type { AgentStageWiring } from './agent-stage.js';
import { createBoundariesStage } from './boundaries.js';
import { createBuildConfigurationStage } from './build-configuration.js';
import { createCodeFactsStage } from './code-facts.js';
import { createCodegraphStage } from './codegraph.js';
import { createDataModelAggregateStage, createDataModelStage } from './data-model.js';
import { createDocIntentStage } from './doc-intent.js';
import { createDocumentIndexStage } from './document-index.js';
import { createGitHistoryReader, createHistoryStage, type CheckoutFolderOf } from './history.js';
import { createIntentHistoryStage } from './intent-history.js';
import { createInventoryStage } from './inventory.js';
import { createModulesStage } from './modules.js';
import { createNarrativeStage } from './narrative.js';
import { createOperationsStage } from './operations.js';
import { createOperationsLinksStage } from './operations-links.js';
import { createOverviewStage } from './overview.js';
import { createRecoveryStage } from './recovery.js';
import { createRepositoryHistoryStage, createRepositoryTreeStage } from './repository-facts.js';
import { createSnapshotStage } from './snapshot.js';
import { createStateMachinesStage } from './state-machines.js';
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
  /** What this step's two passes publish through: the record store's own writes (src/graph/records.ts). */
  readonly records?: RecordPassWiring;
}

/** The folder a run that wired no Git answers with: no folder, which the history stage refuses by name. */
const noCheckout: CheckoutFolderOf = () => '';

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
 * wiring can read — the agent stages only where the run names an agent — and this
 * registry is read, never driven: no run takes its stages from here, and the source
 * it stands over answers no repository.
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
    // The engine's agent stages are registered only over a named agent. The check names one
    // nothing runs, so the registry it reads holds every stage this madarch knows.
    agent: { agent: { id: 'engine-stage-registry', command: 'engine-stage-registry' } },
  });
}

/**
 * Every stage of this madarch, registered over the run's wiring: the snapshot, the inventory, the build and
 * configuration, the syntax, the code facts, the code pass, the data model, the state machines, the operations,
 * the links, the modules, the document index, the history, and this step's two record passes — the tree and the
 * history (madarch-8bdc.2.5). The order of the calls is not the order the stages run in — the graph decides that
 * from what they declare — so a stage added anywhere in the chain lands correctly.
 *
 * **Every stage stays registered; the fill's step list decides what runs.** This registry is the one place a stage
 * is declared, so the workflow check reads the ids a product may name and the declarations it derives producers
 * from, whatever steps this fill runs today. A run enables the stages of its workflow that are also in
 * `FILL_STEP_IDS` (`src/fill/run.ts` narrows the configuration), and the derived graph plans nothing else: a stage
 * out of the list is declared and never reached, never deleted.
 */
export function createStageRegistry(wiring: FillStageWiring): StageRegistry {
  const records = wiring.records ?? noRecords;
  const registry = new StageRegistry()
    .register(createSnapshotStage(wiring.snapshots))
    .register(createInventoryStage(wiring.snapshots))
    .register(createBuildConfigurationStage(wiring.snapshots))
    .register(createSyntaxStage(wiring.snapshots))
    .register(createCodeFactsStage(wiring.snapshots))
    // The code pass (decision 0033's "The code pass"): the library's reading of one repository's
    // tree at the pinned commit, joined to the symbols the per-file passes published.
    .register(createCodegraphStage(wiring.snapshots))
    .register(createDataModelStage(wiring.snapshots))
    .register(createDataModelAggregateStage(wiring.snapshots))
    .register(createStateMachinesStage(wiring.snapshots))
    .register(createOperationsStage(wiring.snapshots))
    .register(createOperationsLinksStage(wiring.snapshots))
    .register(createModulesStage(wiring.snapshots))
    .register(createDocumentIndexStage(wiring.snapshots))
    .register(createHistoryStage(createGitHistoryReader(wiring.checkoutOf ?? noCheckout), wiring.snapshots))
    // This step's two passes (madarch-8bdc.2.5): the tree and the history, published into the record store.
    .register(createRepositoryTreeStage({ sources: wiring.snapshots, ...records }))
    .register(createRepositoryHistoryStage({ sources: wiring.snapshots, ...records }));
  // The agent stages stand only where the run names the agent they are driven with: an agent unit's whole work is
  // a session with that agent (0026), and a stage registered without one would plan units that could not run. They
  // are registered one per stage of 0026 as each lands (madarch-tzte.24.1 lands stage 8): the landed agent unit of
  // 22.3 is the shape's own reference declaration (`agent-unit.ts`) and is no stage of a run.
  // Stage order is 0026's own (8 overview, 9 boundaries, 10 intent from documents, 11 intent from comments and
  // commits, 12 modules bottom-up), and the graph the declarations
  // derive decides when each runs — the calls name it only for a reader.
  if (wiring.agent !== undefined) {
    const agent = { snapshots: wiring.snapshots, ...wiring.agent };
    registry.register(createOverviewStage(agent));
    registry.register(createBoundariesStage(agent));
    registry.register(createDocIntentStage(agent));
    registry.register(createIntentHistoryStage(agent));
    // Stage 12 of 0026 (madarch-tzte.24.5): the modules understood bottom-up, each parent from its children's
    // bounded summaries, on the agent-stage shape.
    registry.register(createUnderstandingStage(agent));
    // Stage 13 of 0026 (madarch-tzte.24.6): the system recovered from every earlier reading and reconciled
    // with the intended model the product declares, on the agent-stage shape.
    registry.register(createRecoveryStage(agent));
    // The pages stage of 0026 (madarch-tzte.25.1): a page's narrative text, each sentence tied to its facts.
    // It stands last: a page's sentences cite the claims the stages before it wrote, and its own optional
    // consume of `claim` orders it after this stage's publications.
    registry.register(createNarrativeStage(agent));
  }
  return registry;
}
