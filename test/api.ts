/** The history and server helpers the surviving tests share (the old src/index.ts surface, kept test-side). */
import type { CompiledModel, CompiledElement, CompiledEntity, CompiledInterface, CompiledRelation, CompiledScenario, CompiledState, CompiledZone, CompiledEnvironment } from '../src/model/compiled-schema.js';
import type { AssertionChange, Clock, HistoryStore, StoreInput } from '../src/history-types.js';
import { CLASHABLE_KINDS, type ReadModel } from '../src/history-assertions.js';
import { startServer, type StartedServer } from '../src/server/http.js';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import type { ServerOptions as ServerOptionsImpl } from '../src/server/http.js';
import { createGraphs as createGraphsImpl, type Graph, type Graphs, type GraphsOptions } from '../src/server/graphs.js';
import { createSourceStores as createSourceStoresImpl, sourceNameProblem as sourceNameProblemImpl, type SourceStores, type SourceStoresOptions } from '../src/server/sources.js';
import { renderAsyncOneViewMermaid as renderMermaidImpl, renderAsyncOneViewLikeC4 as renderLikeC4Impl } from '../src/render/one-view.js';
import type { LikeC4Result } from '../src/render/likec4.js';
import type { AsyncQueryEngine } from '../src/query-types.js';
import { checkLikeC4Workspaces as checkLikeC4Impl, type LikeC4CheckResult } from '../scripts/likec4-check.js';
import type { CommitRecord } from '../src/graph/records.js';

export { startServer, CLASHABLE_KINDS };
export type { AssertionChange, Clock, CompiledElement, CompiledEntity, CompiledInterface, CompiledModel, CompiledRelation, CompiledScenario, CompiledState, CompiledZone, CompiledEnvironment, HistoryStore, ReadModel, StartedServer };
export { createGraphsImpl as createGraphs, createSourceStoresImpl as createSourceStores, sourceNameProblemImpl as sourceNameProblem, renderMermaidImpl as renderAsyncOneViewMermaid, renderLikeC4Impl as renderAsyncOneViewLikeC4, checkLikeC4Impl as checkLikeC4Workspaces };
export type { AsyncQueryEngine, CommitRecord, DatabaseOwner, Graph, Graphs, GraphsOptions, LikeC4CheckResult, LikeC4Result, ServerOptionsImpl as ServerOptions, SourceStores, SourceStoresOptions, StoreInput };
