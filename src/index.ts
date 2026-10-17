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
  QueryError,
  QuerySnapshot,
  QueryTime,
  ViewInput,
  ViewRelation,
  ViewResult,
} from './query/types.js';
export { buildAsyncViewSet, buildAsyncView, type Arrow, type Place, type ShownElement, type View, type ViewSetError, type ViewSetResult } from './render/view-set.js';
export { renderMermaidPages, type MermaidError, type MermaidPage, type MermaidResult } from './render/mermaid.js';
export { renderAsyncLikeC4Workspace, type LikeC4Error, type LikeC4Result, type NotDrawn } from './render/likec4.js';
export { renderAsyncOneViewMermaid, renderAsyncOneViewLikeC4, type OneViewError, type OneViewLikeC4Result, type OneViewRequest, type OneViewMermaidResult } from './render/one-view.js';
export { createPGliteQueryDatabase, type PGliteQueryDatabaseOptions } from './adapters/pglite-query-database.js';
export { createPostgresQueryDatabase, type PostgresQueryDatabaseOptions } from './adapters/postgres-query-database.js';
export { createSourceStores, sourceNameProblem, type SourceHead, type SourceStores, type SourceStoresOptions, type SourceStoreResult } from './server/sources.js';
export { createGraphs, type Graph, type Graphs, type GraphsOptions } from './server/graphs.js';
export { startServer, type ServerOptions, type StartedServer } from './server/http.js';
export { answerProductQuestion, type QuestionAnswerInput } from './product/discussion-writer.js';
export { QUESTION_TYPES, rankQuestions, type QuestionType, type OpenQuestion, type QuestionState } from './product-wiki/questions.js';
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
export { inventoryRepository, indexRepository, inventoryUnitPlan, structuralIndexUnitPlans, executeInventoryUnit, executeStructuralIndexUnit, type SourceAnchor, type InventoryFile, type RepositoryInventory, type FillEstimate, type RepositoryInventoryResult, type IndexedSymbol, type IndexedReference, type IndexedComment, type IndexedTaskKey, type StructuralFile, type StructuralIndexResult } from './product/fill-index.js';
export {
  FILL_STATE_VERSION, FILL_STAGES, FILL_UNIT_STATUSES,
  appendFillEventAtomic, countFillUnits, createFillFileStore, createFillRun, createFillUnit, fillInputsMatch, fillStatePaths, hashFillInput, hashFillInputs, orchestrateFillUnits, persistFillRun, persistFillUnit, readFillJson, reconcileFillUnit, writeFillJsonAtomic,
  type FillControl, type FillEvent, type FillOrchestrationHooks, type FillRun, type FillRunCounts, type FillRunStore, type FillRunStatus, type FillStage, type FillStageCounts, type FillUnit, type FillUnitExecutor, type FillUnitPlan, type FillUnitStatus,
} from './product/fill-runtime.js';
export {
  REPOS_FOLDER,
  readProductRepos,
  type ProductRepoEntry,
  type ProductRefsAnswer,
  type RepoHead,
  type RepoReadme,
  type RepoState,
} from './product-wiki/repos.js';

export { anchoredFactsFromIndex, assembleClaims, createClaimSources, createEmptyClaimsExtraction, loadClaimsPrompt, parseFillKinds, persistClaimsOutput, persistTrainingScore, readPinnedGitHistory, readPinnedGitMaterial, recordUnattemptedLinks, renderClaimMarkdown, scoreTrainingExtraction, type AnchoredCodeFact, type IndexedEvidence, type IndexedEvidenceClassifier, type ClaimQuestion, type ClaimSource, type ClaimsExtraction, type ClaimLayer, type ClaimVerification, type ExtractionMaterial, type ExtractedClaim, type TrainingScore } from './product/fill-claims.js';

export { startFill, type StartFillOptions, type StartFillResult } from './product/fill.js';
export { buildCodeMap, persistCodeMap, synthesizePages, synthesizeRegistryPage, applySynthesisPages, segmentProseIssues, type CodeMap, type SynthesisTarget, type SynthesizedPage, type SynthesisSegment, type PageGenerator, type Critic } from './product/fill-synthesis.js';
export { createHeadlessAgentExecutor, agentCommand, normalizeAgentEvent, type AgentKind, type AgentEvent } from './product/fill-agents.js';
export { detectFillAgents, testFillAgent, readChosenAgent, saveChosenAgent, agentSettingsPath, type WizardAgent, type DetectedAgent } from './product/fill-wizard.js';
