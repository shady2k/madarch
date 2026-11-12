/** The single registration point for ordinary declared plugin execution. */
import { StageRegistry } from '../registry.js';
import { createPluginTurnStage, type GraphOwner, type PluginTurnWiring } from '../plugin-turns.js';

export interface FillStageWiring {
  readonly plugins?: PluginTurnWiring;
}

/** Pure declarations for workflow validation; this registry is never driven. */
export function createEngineStageRegistry(): StageRegistry {
  return createStageRegistry({
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

/** A run executes only the plugins its product declares. */
export function createStageRegistry(wiring: FillStageWiring): StageRegistry {
  const registry = new StageRegistry();
  if (wiring.plugins !== undefined) registry.register(createPluginTurnStage(wiring.plugins));
  return registry;
}
