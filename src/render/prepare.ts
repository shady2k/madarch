/**
 * Prepares a repository's model for rendering: loads and compiles it with
 * the shared loader and compiler (`loadAndCompileModel`), rebuilds its
 * source-scoped assertions in a temporary query database, and renders every
 * view — the Mermaid pages and the LikeC4 workspace. `scripts/render-views.ts`
 * (the reference system) renders through it, and so does the model check
 * when it is asked for views.
 *
 * A model has no history of its own, so the temporary projection is built
 * at one fixed moment the caller names: the pages change only when the model
 * or the renderer does, never with the clock. The projection and query
 * engine are shared with the model check's problems and rendering.
 */
import { createPGliteQueryDatabase } from '../adapters/pglite-query-database.js';
import { assertionsOf } from '../history/assertions.js';
import { loadAndCompileModel } from '../model/load-and-compile.js';
import type { CompiledModel } from '../model/compile.js';
import type { AsyncQueryEngine } from '../query/types.js';
import { buildAsyncViewSet, type ViewSetResult } from './view-set.js';
import { renderMermaidPages, type MermaidPage } from './mermaid.js';
import { writeAsyncLikeC4Workspace } from './likec4.js';

/** The source and fixed time at which a compiled model is projected and rendered. */
export interface RenderedVersion {
  source: string;
  /** The revision this render represents; repository-page links use it. */
  commit: string;
  /** The moment the version is answered at: never the clock. */
  at: number;
}

export interface PreparedRendering {
  /** The compiled model; left out when loading or compiling failed. */
  model?: CompiledModel;
  /** One page per view; left out when there are errors. */
  pages?: MermaidPage[];
  /** The LikeC4 workspace's text; left out when there are errors. */
  workspace?: string;
  /** One line per relation the workspace leaves out because LikeC4 cannot draw it; empty when there are errors. */
  notDrawn: string[];
  /** Every problem that kept the pages from being rendered, one line each. */
  errors: string[];
  /** The model's warnings, one line each; they do not keep the pages from being rendered. */
  warnings: string[];
}

/** A compiled model projected into a temporary query database. `close` releases its engine and owner. */
export interface PreparedModel {
  model: CompiledModel;
  engine: AsyncQueryEngine;
  /** The time and state the model answers at. */
  at: { valid: number; known: number };
  close(): Promise<void>;
}

/**
 * Rebuilds the query engine from the compiled model's assertions at the
 * caller's fixed time. A HistoryStore would create a second temporary PGlite
 * database just to read those same assertions back; this projection is
 * private to rendering and model-check, so rebuild them directly instead.
 */
export async function prepareModel(model: CompiledModel, version: RenderedVersion): Promise<PreparedModel> {
  const assertions = assertionsOf(model).map((assertion) => ({
    source: version.source,
    kind: assertion.kind,
    id: assertion.id,
    content: assertion.content,
    validFrom: version.at,
    validTo: null,
    recordedFrom: version.at,
    recordedTo: null,
  }));
  const database = await createPGliteQueryDatabase();
  const engine = database.forSources([version.source]);
  try {
    await engine.rebuild(assertions);
  } catch (error) {
    await engine.close().catch(() => {});
    await database.close().catch(() => {});
    throw error;
  }
  return {
    model,
    engine,
    at: { valid: version.at, known: version.at },
    close: async () => {
      await engine.close();
      await database.close();
    },
  };
}

/**
 * Renders an already prepared model without taking ownership of its engine.
 * The model check shares this step with its problem analysis, so one check
 * does not start a second pair of temporary PGlite databases just to write
 * the views it has already built.
 */
export async function renderPreparedModel(prepared: PreparedModel, existingViewSet?: ViewSetResult): Promise<PreparedRendering> {
  const { model } = prepared;
  const preparedViews = await prepared.engine.withSnapshot(async (snapshot) => {
    const viewSet = existingViewSet ?? await buildAsyncViewSet(snapshot, model, prepared.at);
    if (viewSet.views === undefined) return { viewSet };
    return { viewSet, likec4: await writeAsyncLikeC4Workspace(snapshot, model, prepared.at, viewSet.views) };
  });
  const { viewSet } = preparedViews;
  if (viewSet.views === undefined) return { model, errors: viewSet.errors.map((e) => e.message), notDrawn: [], warnings: [] };
  const rendered = renderMermaidPages(viewSet.views);
  if (rendered.pages === undefined) return { model, errors: rendered.errors.map((e) => e.message), notDrawn: [], warnings: [] };
  const likec4 = preparedViews.likec4!;
  if (likec4.workspace === undefined) return { model, errors: likec4.errors.map((e) => e.message), notDrawn: [], warnings: [] };
  return { model, pages: rendered.pages, workspace: likec4.workspace, notDrawn: likec4.notDrawn!.map((relation) => relation.message), errors: [], warnings: [] };
}

/**
 * Renders an already compiled model: projects its assertions into a
 * temporary query database and renders every view. Callers that have already
 * prepared the model can use `renderPreparedModel` and keep its engine under
 * their own lifecycle.
 */
export async function renderModel(model: CompiledModel, version: RenderedVersion): Promise<PreparedRendering> {
  const prepared = await prepareModel(model, version);
  try {
    return await renderPreparedModel(prepared);
  } finally {
    await prepared.close();
  }
}

/**
 * Loads, compiles, projects and renders one repository's model, closing the
 * engine and its temporary query database before returning.
 */
export async function prepareRendering(repoFolder: string, version: RenderedVersion): Promise<PreparedRendering> {
  const { model, errors, warnings } = loadAndCompileModel(repoFolder);
  const warningLines = warnings.map((w) => `${w.file}:${w.line}: ${w.path}: ${w.message}`);
  if (model === undefined) return { errors: errors.map((e) => `${e.file}:${e.line}: ${e.path}: ${e.message}`), notDrawn: [], warnings: warningLines };
  return { ...(await renderModel(model, version)), warnings: warningLines };
}
