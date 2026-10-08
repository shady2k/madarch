/** madarch's public interface. */

export type { ModelError, ModelWarning } from './model/errors.js';
export {
  ElementKind,
  Element,
  Interface,
  Relation,
  Category,
  DataEntity,
  Evidence,
  Scenario,
  ScenarioStep,
  ScenarioAlternative,
  Binding,
  Transfer,
  TransferDirection,
  ModelFile,
  Zone,
  ZonesChange,
  Environment,
  EnvironmentZonesChange,
  State,
  DEFAULT_STATE_ID,
  type IntendedModel,
  type ValidatedModel,
} from './model/schema.js';
export { loadModel, parseModel, type LoadResult, type ModelSourceFile } from './model/load.js';
export {
  compileModel,
  serializeCompiledModel,
  SCHEMA_VERSION,
  type CompiledModel,
  type CompiledElement,
  type CompiledInterface,
  type CompiledRelation,
  type CompiledCategory,
  type CompiledEntity,
  type CompiledScenario,
  type CompiledScenarioStep,
  type CompiledScenarioAlternative,
  type CompiledTransfer,
  type CompiledZone,
  type CompiledEnvironment,
  type CompiledState,
} from './model/compile.js';
export {
  CompiledModel as CompiledModelSchema,
  CompiledElement as CompiledElementSchema,
  COMPILED_SCHEMA_VERSION,
} from './model/compiled-schema.js';
export type {
  AssertionChange,
  AssertionRecord,
  AssertionsInput,
  Clock,
  Discrepancy,
  HistoryError,
  HistoryStore,
  ReadInput,
  ReadResult,
  StoreInput,
  StoreResult,
} from './history/types.js';
export {
  ASSERTION_KINDS,
  CLASHABLE_KINDS,
  SHARED_KINDS,
  isOneStateChain,
  type AlsoDefinedAs,
  type Assertion,
  type AssertionKind,
  type EnvironmentDefinition,
  type ReadEnvironment,
  type ReadModel,
  type SharedEntity,
} from './history/assertions.js';
export { createSqliteHistory, type SqliteHistoryOptions } from './adapters/sqlite-history.js';
export type {
  ChildrenResult,
  DependenciesInput,
  DependenciesResult,
  DependencyAnswer,
  ElementAnswer,
  QueryEngine,
  QueryError,
  QueryTime,
  ViewInput,
  ViewRelation,
  ViewResult,
} from './query/types.js';
export { buildViewSet, type Arrow, type Place, type ShownElement, type View, type ViewSetError, type ViewSetResult } from './render/view-set.js';
export { renderMermaidPages, type MermaidError, type MermaidPage, type MermaidResult } from './render/mermaid.js';
export { renderLikeC4Workspace, type LikeC4Error, type LikeC4Result, type NotDrawn } from './render/likec4.js';
export { renderOneViewMermaid, renderOneViewLikeC4, type OneViewError, type OneViewLikeC4Result, type OneViewRequest, type OneViewMermaidResult } from './render/one-view.js';
export { createLadybugEngine, executionThreadsForTests, preparedStatementCacheSizeForTests, type LadybugEngineOptions } from './adapters/ladybug-engine.js';
export { createSourceStores, sourceNameProblem, type SourceHead, type SourceStores, type SourceStoresOptions, type SourceStoreResult } from './server/sources.js';
export { createGraphs, type Graph, type Graphs, type GraphsOptions } from './server/graphs.js';
export { startServer, type ServerOptions, type StartedServer } from './server/http.js';

export { loadAndCompileModel, type LoadAndCompileResult } from './model/load-and-compile.js';
