/**
 * One view on request (the one-view requirement of the views capability):
 * the landscape or the view of one element, at a depth, as Mermaid — the
 * view set's page of it without its links to other pages — or as one
 * LikeC4 workspace holding only that view. The server answers a view
 * request with these; the view set's own pages and workspace are the other
 * way in beside this one, and its output is unchanged. This module touches
 * no Bun-specific API.
 */
import type { CompiledModel } from '../model/compile.js';
import type { QueryEngine, QueryError, QueryTime } from '../query/types.js';
import { renderPageBody } from './mermaid.js';
import { writeLikeC4Workspace, type LikeC4Error, type NotDrawn } from './likec4.js';
import { buildView, type View, type ViewSetError } from './view-set.js';

/** One view asked of the renderer: which element (left out, the landscape), how deep. */
export interface OneViewRequest {
  /** The element the view is of; left out, the landscape. */
  element?: string;
  /** How many levels deep from the element to draw; 1 by default. */
  depth?: number;
}

/** One problem that kept the asked view from being rendered. */
export interface OneViewError {
  message: string;
  /** The element the view was asked for, when the request named one. */
  element?: string;
  /** The depth the view was asked at, when the depth is the problem. */
  depth?: number;
  /** The query engine's own error, when a query refused (an element that does not exist at the asked time, an ambiguous state). */
  query?: QueryError;
  /** The relation whose label could not be worked out, when that is the problem. */
  relationId?: string;
}

/** The asked view as Mermaid: the heading, the flowchart and the table of its arrows. */
export interface OneViewMermaidResult {
  /** The view set's page of the view without its links; left out when there are errors. */
  page?: string;
  errors: OneViewError[];
}

/** The asked view as one LikeC4 workspace: every element and relation, the `views` block holding only the asked view. */
export interface OneViewLikeC4Result {
  /** The whole `.c4` text; left out when there are errors. */
  workspace?: string;
  /** Every relation left out of the workspace because LikeC4 cannot draw it; present with the workspace. */
  notDrawn?: NotDrawn[];
  errors: OneViewError[];
}

/** The depth a request without one asks for. */
const DEFAULT_DEPTH = 1;

/**
 * The view the request asks for: the depth checked first (a wrong depth is
 * a defect of the request itself, before any view can be attempted), then
 * the view built the way the view set builds each of its. Every error is
 * collected, and a view with any error is not returned at all.
 */
function asked(
  request: OneViewRequest,
  engine: QueryEngine,
  model: CompiledModel,
  at: QueryTime | undefined,
): { view?: View; errors: OneViewError[] } {
  const depth = request.depth ?? DEFAULT_DEPTH;
  if (!Number.isInteger(depth) || depth < 1) {
    const error: OneViewError = {
      message: Number.isInteger(depth)
        ? `the depth ${depth} is below 1: the smallest depth rendered is 1`
        : `the depth ${depth} is not a whole number: the depth is how many levels to draw`,
      depth,
    };
    if (request.element !== undefined) error.element = request.element;
    return { errors: [error] };
  }
  const built = buildView(engine, model, request.element, at, depth);
  return { view: built.view, errors: built.errors.map(asOneViewError) };
}

/** A view set's or workspace's error, as the one-view surface names it: the view's scope is the request's element. */
function asOneViewError(error: ViewSetError | LikeC4Error): OneViewError {
  const mapped: OneViewError = { message: error.message };
  const element = error.scope ?? ('elementId' in error ? error.elementId : undefined);
  if (element !== undefined) mapped.element = element;
  if (error.query !== undefined) mapped.query = error.query;
  if (error.relationId !== undefined) mapped.relationId = error.relationId;
  return mapped;
}

/**
 * Renders the asked view as Mermaid: at depth 1 the view set's own page of
 * it without its links to other pages — the heading, the flowchart and the
 * table of arrows, whose targets are not in the reader's document — so
 * what the renderer already proved readable on GitHub is what the caller
 * gets; at a greater depth, the same page with the deeper frames. Every
 * error is collected, and a page with any error is not returned at all.
 */
export function renderOneViewMermaid(engine: QueryEngine, model: CompiledModel, request: OneViewRequest, at?: QueryTime): OneViewMermaidResult {
  const { view, errors } = asked(request, engine, model, at);
  if (view === undefined) return { errors };
  const scope = view.scope === undefined ? undefined : view.elements.find((element) => element.id === view.scope && element.place === 'scope');
  if (view.scope !== undefined && scope === undefined) {
    return { errors: [{ message: `the view of "${view.scope}" does not show "${view.scope}" itself as its scope`, element: view.scope }] };
  }
  return { page: renderPageBody(view, scope), errors: [] };
}

/**
 * Renders the asked view as one LikeC4 workspace: the whole workspace as
 * the view set writes it — specification, every element and relation —
 * with its `views` block holding only the asked view (`index` for the
 * landscape), so the answer validates alone. Every error is collected, and
 * a workspace with any error is not returned at all.
 */
export function renderOneViewLikeC4(engine: QueryEngine, model: CompiledModel, request: OneViewRequest, at?: QueryTime): OneViewLikeC4Result {
  const { view, errors } = asked(request, engine, model, at);
  if (view === undefined) return { errors };
  const written = writeLikeC4Workspace(engine, model, at, [view]);
  if (written.workspace === undefined) return { errors: written.errors.map(asOneViewError) };
  return { workspace: written.workspace, notDrawn: written.notDrawn, errors: [] };
}
