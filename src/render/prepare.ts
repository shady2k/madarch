/**
 * Prepares a repository's model for rendering: loads and compiles it with
 * the shared loader and compiler (`loadAndCompileModel`), stores it as one
 * version in a history of its own, builds the query engine from that
 * history, and renders every view — the Mermaid pages and the LikeC4
 * workspace. `scripts/render-views.ts` (the reference system) renders
 * through it, and so does the model check when it is asked for views.
 *
 * A model has no history of its own, so it is stored and rendered at one
 * fixed moment the caller names: the pages change only when the model or
 * the renderer does, never with the clock. The storing and the engine
 * itself (`prepareModel`) are shared with the model check's problems, which
 * need the same view set the pages are drawn from.
 */
import { createLadybugEngine } from '../adapters/ladybug-engine.js';
import { createSqliteHistory } from '../adapters/sqlite-history.js';
import { loadAndCompileModel } from '../model/load-and-compile.js';
import type { CompiledModel } from '../model/compile.js';
import type { QueryEngine } from '../query/types.js';
import { buildViewSet } from './view-set.js';
import { renderMermaidPages, type MermaidPage } from './mermaid.js';
import { renderLikeC4Workspace } from './likec4.js';

/** The one version a model is stored and rendered at, named by the caller. */
export interface RenderedVersion {
  /** Where the model came from, as the history names its source. */
  source: string;
  /** The commit the model stands for, as the history records it. */
  commit: string;
  /** The moment the version is stored and rendered at: never the clock. */
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

/** A compiled model stored in a history of its own, with the query engine built from that history. `close` releases both. */
export interface PreparedModel {
  model: CompiledModel;
  engine: QueryEngine;
  /** The time and state the model is stored and answered at. */
  at: { valid: number; known: number };
  /** Every problem that kept the model from being stored; while it is nonempty the engine answers nothing. */
  errors: string[];
  close(): void;
}

/**
 * Stores an already compiled model as one version and builds the query
 * engine from that history: the seam the rendering and the model check's
 * problems share, so neither keeps its own copy of the storing.
 */
export function prepareModel(model: CompiledModel, version: RenderedVersion): PreparedModel {
  const history = createSqliteHistory({ clock: { now: () => version.at } });
  const engine = createLadybugEngine();
  const stored = history.store({ source: version.source, commit: version.commit, committedAt: version.at, model });
  engine.rebuild(history.assertions());
  return {
    model,
    engine,
    at: { valid: version.at, known: version.at },
    errors: stored.errors.map((error) => `storing the model: ${error.message}`),
    close: () => {
      engine.close();
      history.close();
    },
  };
}

/**
 * Renders an already compiled model: stores it as one version, builds the
 * query engine from that history and renders every view — the render half
 * of the seam. `prepareRendering` reaches it after its own load and
 * compile; the model check reaches it with the model it already compiled,
 * so its views are drawn from exactly the model its findings are.
 */
export function renderModel(model: CompiledModel, version: RenderedVersion): PreparedRendering {
  const prepared = prepareModel(model, version);
  try {
    if (prepared.errors.length > 0) return { model, errors: prepared.errors, notDrawn: [], warnings: [] };
    const viewSet = buildViewSet(prepared.engine, model, prepared.at);
    if (viewSet.views === undefined) return { model, errors: viewSet.errors.map((e) => e.message), notDrawn: [], warnings: [] };
    const rendered = renderMermaidPages(viewSet.views);
    if (rendered.pages === undefined) return { model, errors: rendered.errors.map((e) => e.message), notDrawn: [], warnings: [] };
    const likec4 = renderLikeC4Workspace(prepared.engine, model, prepared.at);
    if (likec4.workspace === undefined) return { model, errors: likec4.errors.map((e) => e.message), notDrawn: [], warnings: [] };
    return { model, pages: rendered.pages, workspace: likec4.workspace, notDrawn: likec4.notDrawn!.map((relation) => relation.message), errors: [], warnings: [] };
  } finally {
    prepared.close();
  }
}

/**
 * Loads, compiles, stores and renders one repository's model, closing the
 * engine and the history it borrows before returning.
 */
export function prepareRendering(repoFolder: string, version: RenderedVersion): PreparedRendering {
  const { model, errors, warnings } = loadAndCompileModel(repoFolder);
  const warningLines = warnings.map((w) => `${w.file}:${w.line}: ${w.path}: ${w.message}`);
  if (model === undefined) return { errors: errors.map((e) => `${e.file}:${e.line}: ${e.path}: ${e.message}`), notDrawn: [], warnings: warningLines };
  return { ...renderModel(model, version), warnings: warningLines };
}
