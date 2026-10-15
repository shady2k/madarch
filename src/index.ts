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
export { createPGliteHistory, type PGliteHistoryOptions } from './adapters/pglite-history.js';
export type { AsyncVectorIndex, VectorDistanceMetric, VectorMatch, VectorRecord, VectorSearchInput } from './vector/types.js';
export type {
  ChildrenResult,
  DependenciesInput,
  DependenciesResult,
  DependencyAnswer,
  ElementAnswer,
  AsyncQueryDatabase,
  AsyncQueryEngine,
  QueryEngine,
  QueryError,
  QuerySnapshot,
  QueryTime,
  ViewInput,
  ViewRelation,
  ViewResult,
} from './query/types.js';
export { buildViewSet, buildAsyncViewSet, buildAsyncView, type Arrow, type Place, type ShownElement, type View, type ViewSetError, type ViewSetResult } from './render/view-set.js';
export { renderMermaidPages, type MermaidError, type MermaidPage, type MermaidResult } from './render/mermaid.js';
export { renderLikeC4Workspace, renderAsyncLikeC4Workspace, type LikeC4Error, type LikeC4Result, type NotDrawn } from './render/likec4.js';
export { renderOneViewMermaid, renderOneViewLikeC4, renderAsyncOneViewMermaid, renderAsyncOneViewLikeC4, type OneViewError, type OneViewLikeC4Result, type OneViewRequest, type OneViewMermaidResult } from './render/one-view.js';
export { createLadybugEngine, executionThreadsForTests, preparedStatementCacheSizeForTests, type LadybugEngineOptions } from './adapters/ladybug-engine.js';
export { createAsyncLadybugEngine } from './adapters/async-ladybug-engine.js';
export { createPGliteQueryDatabase, type PGliteQueryDatabaseOptions } from './adapters/pglite-query-database.js';
export { createPostgresQueryDatabase, type PostgresQueryDatabaseOptions } from './adapters/postgres-query-database.js';
export { createSourceStores, sourceNameProblem, type SourceHead, type SourceStores, type SourceStoresOptions, type SourceStoreResult } from './server/sources.js';
export { createGraphs, type Graph, type Graphs, type GraphsOptions } from './server/graphs.js';
export { startServer, type ServerOptions, type StartedServer } from './server/http.js';
export {
  createWikiPart,
  type WikiPart,
} from './server/wiki-app.js';
export {
  DOCS_FOLDER,
  PAGE_ADDRESS_PREFIX,
  openProductWiki,
  type OpenedProductWiki,
  type ProductWiki,
  type ProductWikiPage,
  type ProductWikiPages,
  type WikiPage,
  type WikiPageEntry,
} from './product-wiki/pages.js';

export { loadAndCompileModel, type LoadAndCompileResult } from './model/load-and-compile.js';
export {
  REPOS_FOLDER,
  readProductRepos,
  type ProductRepoEntry,
  type ProductRefsAnswer,
  type RepoHead,
  type RepoReadme,
  type RepoState,
} from './product-wiki/repos.js';
