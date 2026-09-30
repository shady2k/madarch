/**
 * The renderer's input: the view set (see design.md, "The renderer's
 * input"). Built from the query engine's answers and named from the
 * compiled model at one time and state; Mermaid and LikeC4 each turn the
 * same view set into text. Mermaid queries nothing itself; LikeC4 also asks
 * for the unscoped view at full depth (`EVERY_LEVEL`), for every relation
 * between its own ends. This module touches no Bun-specific API.
 */
import type { CompiledModel, CompiledRelation } from '../model/compile.js';
import { byCodePoint } from '../model/order.js';
import { messagingOf } from '../model/contracts.js';
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

/**
 * One arrow a view draws: the shown pair, every relation id behind it (code
 * point order) and, parallel to them, each relation's entry for the view's
 * table (views/mermaid): its name, or for one marking its action on a topic or
 * queue its role and then its name. Drawn from the initiator, as its relations
 * go; `dashed` when every relation behind it marks its action, left out
 * otherwise.
 */
export interface Arrow {
  from: string;
  to: string;
  relationIds: string[];
  names: string[];
  dashed?: true;
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
  /** The view being built, or the element whose children were asked for; left out for the landscape. */
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

/** A depth no model's nesting reaches: an unscoped view this deep holds every element, and draws every relation between its own ends. */
export const EVERY_LEVEL = Number.MAX_SAFE_INTEGER;

/**
 * Builds the view set at one time and state (`at`, the query engine's own
 * defaults when left out): the landscape, `view({ depth: 0 })` — depth 0
 * unscoped is exactly the elements with no parent — and, for every element
 * with children (read from one unscoped view holding every element),
 * `view({ scope, depth: 1, context: true })`. Every error is
 * collected, so one pass names them all; a view set with any error is not
 * returned at all, never a smaller set passed off as whole.
 */
export function buildViewSet(engine: QueryEngine, model: CompiledModel, at?: QueryTime): ViewSetResult {
  const errors: ViewSetError[] = [];
  const names = namer(model);

  const landscape = engine.view({ depth: 0 }, at);
  if (landscape.error !== undefined) return { errors: [queryError(undefined, landscape.error)] };

  // Every element with children, read from the parents of every element:
  // one unscoped view deep enough to hold them all, instead of a query per
  // element. Each is kept to name the way up from its children's views.
  const every = engine.view({ depth: EVERY_LEVEL }, at);
  if (every.error !== undefined) return { errors: [{ message: `every element: ${every.error.message}`, query: every.error }] };
  const byId = new Map(every.elements!.map((element) => [element.id, element]));
  const withChildren = new Set<string>();
  for (const element of every.elements!) {
    if (element.parent === undefined) continue;
    if (byId.has(element.parent)) withChildren.add(element.parent);
    else errors.push({ message: `the element "${element.id}" is shown in no view: its parent "${element.parent}" does not exist at this time`, scope: element.parent });
  }

  const views: View[] = [assemble(undefined, landscape.elements!, [], landscape.relations!, withChildren, names, errors)];
  for (const scope of [...withChildren].sort(byCodePoint)) {
    const result = engine.view({ scope, depth: 1, context: true }, at);
    if (result.error !== undefined) {
      errors.push(queryError(scope, result.error));
      continue;
    }
    const view = assemble(scope, result.elements!, result.neighbours!, result.relations!, withChildren, names, errors);
    const parentId = byId.get(scope)!.parent;
    // A parent that does not exist was reported above; its child's view goes nowhere up.
    const parent = parentId === undefined ? undefined : byId.get(parentId);
    views.push(parent === undefined ? view : { scope, up: upOf(parent), elements: view.elements, arrows: view.arrows });
  }
  return errors.length > 0 ? { errors } : { views, errors };
}

/** One view built on request: the view, or every problem that kept it from being built. */
export interface BuiltView {
  /** The asked view; left out when there are errors. */
  view?: View;
  errors: ViewSetError[];
}

/**
 * Builds one view on request (views/one-view): the landscape when `scope`
 * is left out, the view of `scope` otherwise — the same question and the
 * same assembling the view set builds each of its views with, so a
 * depth-1 answer can be that view's page. At depth 1 the question is the
 * view set's own (`view({ depth: 0 })` unscoped, `view({ scope, depth: 1,
 * context: true })` scoped); at a depth above 1 the same questions stand
 * one level deeper (`depth: n - 1` unscoped — the landscape at depth 1 is
 * the roots, `depth: 0`), and the engine answers the deeper elements and
 * the relations collapsed to them. The view carries no `up` and `hasView`
 * stays false: its writers draw no links. Every error is collected, and a
 * view with any error is not returned at all.
 */
export function buildView(engine: QueryEngine, model: CompiledModel, scope: string | undefined, at?: QueryTime, depth = 1): BuiltView {
  const errors: ViewSetError[] = [];
  const names = namer(model);

  const asked = scope === undefined ? engine.view({ depth: depth - 1 }, at) : engine.view({ scope, depth, context: true }, at);
  if (asked.error !== undefined) return { errors: [queryError(scope, asked.error)] };
  const view = assemble(scope, asked.elements!, scope === undefined ? [] : asked.neighbours!, asked.relations!, new Set(), names, errors);
  return errors.length > 0 ? { errors } : { view, errors };
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
  namesOf: Namer,
  errors: ViewSetError[],
): View {
  const shown = [
    ...elements.map((element) => shownElement(element, element.id === scope ? 'scope' : 'inside', withChildren)),
    ...neighbours.map((element) => shownElement(element, 'neighbour', withChildren)),
  ].sort((a, b) => byCodePoint(a.id, b.id));

  const arrows: Arrow[] = [];
  for (const relation of [...relations].sort((a, b) => byCodePoint(a.from, b.from) || byCodePoint(a.to, b.to))) {
    const relationIds = [...relation.relationIds].sort(byCodePoint);
    const words = namesOf(relationIds, (relationId, problem) => {
      const error: ViewSetError = {
        message: `${viewName(scope)}: the arrow from "${relation.from}" to "${relation.to}" stands for the relation "${relationId}", ${problem}`,
        relationId,
      };
      if (scope !== undefined) error.scope = scope;
      errors.push(error);
    });
    const names = words.map((word) => (word.marked && word.label !== word.name ? `${word.label}: ${word.name}` : word.label));
    const arrow: Arrow = { from: relation.from, to: relation.to, relationIds, names };
    if (words.length === relationIds.length && words.every((word) => word.marked)) arrow.dashed = true;
    arrows.push(arrow);
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

type Fail = (relationId: string, problem: string) => void;

/** What one relation is called (views/labels): its name for the table, its label on an arrow, and whether it marks its action on a topic or queue. */
export interface RelationWords {
  name: string;
  label: string;
  marked: boolean;
}

/** Each relation's words, in relation-id order; a relation that fails is left out, named to `fail`. */
export type Namer = (relationIds: readonly string[], fail: Fail) => RelationWords[];

const ROLES = {
  topic: { send: 'publishes', receive: 'subscribes to' },
  queue: { send: 'sends to', receive: 'receives from' },
} as const;

/**
 * The words of the relations behind an arrow (views/labels): each relation's
 * name, or for one without a name its interface's contract, or its id where
 * it names no interface; its label is that name, except for a relation that
 * marks its action on a topic or queue, labelled by its role there
 * ("subscribes to order-placed"). The LikeC4 workspace labels each of its
 * relations with it too, one relation id at a time.
 */
export function namer(model: CompiledModel): Namer {
  const relations = new Map(model.relations.map((relation) => [relation.id, relation]));
  const contracts = new Map(model.interfaces.map((iface) => [iface.id, iface.contract]));

  const nameOf = (relation: CompiledRelation): string | undefined => {
    if (relation.name !== undefined) return relation.name;
    if (relation.interface === undefined) return relation.id;
    return contracts.get(relation.interface);
  };

  const words = (relationIds: readonly string[], fail: Fail): RelationWords[] => {
    const found: RelationWords[] = [];
    for (const relationId of relationIds) {
      const relation = relations.get(relationId);
      if (relation === undefined) {
        fail(relationId, 'which the compiled model does not hold');
        continue;
      }
      const name = nameOf(relation);
      if (name === undefined) {
        fail(relationId, `whose interface "${relation.interface}" the compiled model does not hold`);
        continue;
      }
      // Loading refused an action on anything but a topic or queue, so a
      // marked relation's contract names one.
      const messaging = relation.action === undefined || relation.interface === undefined ? undefined : messagingOf(contracts.get(relation.interface) ?? '');
      if (relation.action !== undefined && messaging !== undefined) {
        found.push({ name, label: `${ROLES[messaging.kind][relation.action]} ${messaging.name}`, marked: true });
      } else found.push({ name, label: name, marked: false });
    }
    return found;
  };

  return words;
}

/** Each parent's children (the elements with no parent under `undefined`), by id in code point order. */
export function childrenByParent<T extends { id: string; parent?: string }>(elements: readonly T[]): Map<string | undefined, T[]> {
  const children = new Map<string | undefined, T[]>();
  for (const element of [...elements].sort((a, b) => byCodePoint(a.id, b.id))) {
    const siblings = children.get(element.parent) ?? [];
    siblings.push(element);
    children.set(element.parent, siblings);
  }
  return children;
}
