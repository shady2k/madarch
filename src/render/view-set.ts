/**
 * The renderer's input: the view set (see design.md, "The renderer's
 * input"). Built from the query engine's answers and named from the
 * compiled model at one time and state; Mermaid and LikeC4 each turn the
 * same view set into text and query nothing themselves. This module touches
 * no Bun-specific API.
 */
import type { CompiledModel, CompiledRelation } from '../model/compile.js';
import { byCodePoint } from '../model/order.js';
import type { ElementAnswer, QueryEngine, QueryError, QueryTime, ViewRelation } from '../query/types.js';

/** Where a shown element sits in its view. */
export type Place = 'scope' | 'inside' | 'neighbour';

/** One element a view shows. */
export interface ShownElement {
  id: string;
  kind: string;
  name?: string;
  parent?: string;
  /** `scope` for the view's own element, `inside` for one within it (every element of the landscape), `neighbour` for one outside it. */
  place: Place;
  /** Whether the element has children, and so a view of its own in the set. */
  hasView: boolean;
}

/** One arrow a view draws: the shown pair, every relation id behind it (code point order) and its label. */
export interface Arrow {
  from: string;
  to: string;
  relationIds: string[];
  label: string;
}

/** One view of the set: the landscape (no `scope`) or the view of one element with children. */
export interface View {
  /** The element the view is of; left out for the landscape. */
  scope?: string;
  /**
   * The element one level up, whose view this one is opened from; left out
   * for the landscape and for the view of an element with no parent, whose
   * way up is the landscape.
   */
  up?: { id: string; name?: string };
  /** Every shown element, the scope and its neighbours included, by id in code point order. */
  elements: ShownElement[];
  /** By `from`, then `to`, in code point order. */
  arrows: Arrow[];
}

/** One problem that kept the view set from being built. */
export interface ViewSetError {
  message: string;
  /** The view being built; left out for the landscape. */
  scope?: string;
  /** The query engine's own error, when a query refused. */
  query?: QueryError;
  /** The relation whose label could not be worked out, when that is the problem. */
  relationId?: string;
}

export interface ViewSetResult {
  /** The landscape first, then one view per element with children, by scope in code point order. Left out when there are errors. */
  views?: View[];
  errors: ViewSetError[];
}

/** The most names an arrow's label lists before counting the rest. */
const LISTED_NAMES = 3;

/**
 * Builds the view set at one time and state (`at`, the query engine's own
 * defaults when left out): the landscape, `view({ depth: 0 })` — depth 0
 * unscoped is exactly the elements with no parent — and, for every element
 * with children, `view({ scope, depth: 1, context: true })`. Every error is
 * collected, so one pass names them all; a view set with any error is not
 * returned at all, never a smaller set passed off as whole.
 */
export function buildViewSet(engine: QueryEngine, model: CompiledModel, at?: QueryTime): ViewSetResult {
  const errors: ViewSetError[] = [];
  const labels = labeller(model);

  const landscape = engine.view({ depth: 0 }, at);
  if (landscape.error !== undefined) return { errors: [queryError(undefined, landscape.error)] };

  // Every element with children, found by walking down from the roots;
  // each one met is kept to name the way up from its children's views.
  const withChildren = new Set<string>();
  const met = new Map<string, ElementAnswer>();
  const pending = [...landscape.elements!];
  while (pending.length > 0) {
    const element = pending.shift()!;
    met.set(element.id, element);
    const children = engine.children(element.id, at);
    if (children.error !== undefined) {
      errors.push(queryError(element.id, children.error));
      continue;
    }
    if (children.elements!.length > 0) withChildren.add(element.id);
    pending.push(...children.elements!);
  }

  const views: View[] = [assemble(undefined, landscape.elements!, [], landscape.relations!, withChildren, labels, errors)];
  for (const scope of [...withChildren].sort(byCodePoint)) {
    const result = engine.view({ scope, depth: 1, context: true }, at);
    if (result.error !== undefined) {
      errors.push(queryError(scope, result.error));
      continue;
    }
    const view = assemble(scope, result.elements!, result.neighbours!, result.relations!, withChildren, labels, errors);
    // The walk reached this scope from its parent, so a parent is always met.
    const parentId = met.get(scope)!.parent;
    views.push(parentId === undefined ? view : { scope, up: upOf(met.get(parentId)!), elements: view.elements, arrows: view.arrows });
  }
  return errors.length > 0 ? { errors } : { views, errors };
}

function viewName(scope: string | undefined): string {
  return scope === undefined ? 'the landscape' : `the view of "${scope}"`;
}

function queryError(scope: string | undefined, query: QueryError): ViewSetError {
  const error: ViewSetError = { message: `${viewName(scope)}: ${query.message}`, query };
  if (scope !== undefined) error.scope = scope;
  return error;
}

function assemble(
  scope: string | undefined,
  elements: readonly ElementAnswer[],
  neighbours: readonly ElementAnswer[],
  relations: readonly ViewRelation[],
  withChildren: ReadonlySet<string>,
  labels: Labeller,
  errors: ViewSetError[],
): View {
  const shown = [
    ...elements.map((element) => shownElement(element, element.id === scope ? 'scope' : 'inside', withChildren)),
    ...neighbours.map((element) => shownElement(element, 'neighbour', withChildren)),
  ].sort((a, b) => byCodePoint(a.id, b.id));

  const arrows: Arrow[] = [];
  for (const relation of [...relations].sort((a, b) => byCodePoint(a.from, b.from) || byCodePoint(a.to, b.to))) {
    const relationIds = [...relation.relationIds].sort(byCodePoint);
    const label = labels(relationIds, (relationId, problem) => {
      const error: ViewSetError = {
        message: `${viewName(scope)}: the arrow from "${relation.from}" to "${relation.to}" stands for the relation "${relationId}", ${problem}`,
        relationId,
      };
      if (scope !== undefined) error.scope = scope;
      errors.push(error);
    });
    arrows.push({ from: relation.from, to: relation.to, relationIds, label });
  }

  const view: View = { elements: shown, arrows };
  return scope === undefined ? view : { scope, ...view };
}

function upOf(parent: ElementAnswer): { id: string; name?: string } {
  return parent.name === undefined ? { id: parent.id } : { id: parent.id, name: parent.name };
}

function shownElement(element: ElementAnswer, place: Place, withChildren: ReadonlySet<string>): ShownElement {
  return { ...element, place, hasView: withChildren.has(element.id) };
}

type Labeller = (relationIds: readonly string[], fail: (relationId: string, problem: string) => void) => string;

/**
 * An arrow's label (views/labels): each relation's name, or for one without
 * a name its interface's contract, or its id where it names no interface;
 * in relation-id order, a label repeated among them shown once, the first
 * three joined by "; " and a count of the rest.
 */
function labeller(model: CompiledModel): Labeller {
  const relations = new Map(model.relations.map((relation) => [relation.id, relation]));
  const contracts = new Map(model.interfaces.map((iface) => [iface.id, iface.contract]));

  const labelOf = (relation: CompiledRelation): string | undefined => {
    if (relation.name !== undefined) return relation.name;
    if (relation.interface === undefined) return relation.id;
    return contracts.get(relation.interface);
  };

  return (relationIds, fail) => {
    const names: string[] = [];
    for (const relationId of relationIds) {
      const relation = relations.get(relationId);
      if (relation === undefined) {
        fail(relationId, 'which the compiled model does not hold');
        continue;
      }
      const label = labelOf(relation);
      if (label === undefined) {
        fail(relationId, `whose interface "${relation.interface}" the compiled model does not hold`);
        continue;
      }
      if (!names.includes(label)) names.push(label);
    }
    const listed = names.slice(0, LISTED_NAMES).join('; ');
    return names.length > LISTED_NAMES ? `${listed} (+${names.length - LISTED_NAMES} more)` : listed;
  };
}
