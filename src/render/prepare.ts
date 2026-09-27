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
 * the renderer does, never with the clock.
 */
import { createLadybugEngine } from '../adapters/ladybug-engine.js';
import { createSqliteHistory } from '../adapters/sqlite-history.js';
import { loadAndCompileModel } from '../model/load-and-compile.js';
import type { CompiledModel } from '../model/compile.js';
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

/**
 * Loads, compiles, stores and renders one repository's model, closing the
 * engine and the history it borrows before returning.
 */
export function prepareRendering(repoFolder: string, version: RenderedVersion): PreparedRendering {
  const { model, errors, warnings } = loadAndCompileModel(repoFolder);
  const warningLines = warnings.map((w) => `${w.file}:${w.line}: ${w.path}: ${w.message}`);
  if (model === undefined) return { errors: errors.map((e) => `${e.file}:${e.line}: ${e.path}: ${e.message}`), notDrawn: [], warnings: warningLines };

  const history = createSqliteHistory({ clock: { now: () => version.at } });
  const engine = createLadybugEngine();
  try {
    const stored = history.store({ source: version.source, commit: version.commit, committedAt: version.at, model });
    if (stored.errors.length > 0) return { errors: stored.errors.map((e) => `storing the model: ${e.message}`), notDrawn: [], warnings: warningLines };
    engine.rebuild(history.assertions());

    const at = { valid: version.at, known: version.at };
    const viewSet = buildViewSet(engine, model, at);
    if (viewSet.views === undefined) return { errors: viewSet.errors.map((e) => e.message), notDrawn: [], warnings: warningLines };
    const rendered = renderMermaidPages(viewSet.views);
    if (rendered.pages === undefined) return { errors: rendered.errors.map((e) => e.message), notDrawn: [], warnings: warningLines };
    const likec4 = renderLikeC4Workspace(engine, model, at);
    if (likec4.workspace === undefined) return { errors: likec4.errors.map((e) => e.message), notDrawn: [], warnings: warningLines };
    return { model, pages: rendered.pages, workspace: likec4.workspace, notDrawn: likec4.notDrawn!.map((relation) => relation.message), errors: [], warnings: warningLines };
  } finally {
    engine.close();
    history.close();
  }
}
