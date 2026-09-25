/**
 * The view set as one LikeC4 workspace (see design.md, "LikeC4"): a
 * `specification` with one element kind per madarch kind shown, the `model`
 * with every element nested under its parent and every relation between its
 * own ends with its label, and `views`: `index` for the landscape and one
 * view of every element with children, the same views as the view set.
 * LikeC4 collapses relations and opens an element into its own view by
 * itself. Text only; writing the file anywhere is the caller's. This module
 * touches no Bun-specific API.
 */
import type { CompiledElement, CompiledModel } from '../model/compile.js';
import { byCodePoint } from '../model/order.js';
import type { ElementAnswer, QueryEngine, QueryError, QueryTime } from '../query/types.js';
import { uniqueSafeIds } from './safe-ids.js';
import { buildViewSet, EVERY_LEVEL, labeller } from './view-set.js';

/** One problem that kept the workspace from being rendered. */
export interface LikeC4Error {
  message: string;
  /** The view being built, when the view set named one. */
  scope?: string;
  /** The element the compiled model does not hold, when that is the problem. */
  elementId?: string;
  /** The relation whose label could not be worked out, when that is the problem. */
  relationId?: string;
  /** The query engine's own error, when a query refused. */
  query?: QueryError;
}

export interface LikeC4Result {
  /** The whole `.c4` file. Left out when there are errors. */
  workspace?: string;
  errors: LikeC4Error[];
}

const HEADER = '// Rendered by madarch from the architecture model; edit the model, not this file.';

/** Each kind with a look of its own, as the lines of its `style` block; every other kind is a plain element. */
const STYLES: Readonly<Record<string, readonly string[]>> = {
  person: ['shape person'],
  store: ['shape storage'],
  broker: ['shape queue'],
  external: ['color muted', 'border dashed'],
};

/**
 * Words LikeC4 1.59.4 reads as keywords where a name stands (found by
 * validating each keyword of its grammar as an element and a view name),
 * and `index`, the landscape's view: an identifier equal to one of them, in
 * the same case, gets a trailing `_`.
 */
const RESERVED = new Set([
  'BottomTop',
  'LeftRight',
  'RightLeft',
  'TopBottom',
  'and',
  'autoLayout',
  'border',
  'color',
  'deploymentNode',
  'description',
  'dynamic',
  'dynamicPredicateGroup',
  'exclude',
  'extend',
  'extends',
  'from',
  'global',
  'head',
  'icon',
  'iconColor',
  'iconPosition',
  'iconSize',
  'icons',
  'import',
  'include',
  'includeAncestors',
  'index',
  'instanceOf',
  'is',
  'it',
  'kind',
  'likec4lib',
  'line',
  'link',
  'metadata',
  'multiple',
  'navigateTo',
  'not',
  'notation',
  'notes',
  'of',
  'opacity',
  'or',
  'order',
  'padding',
  'predicate',
  'predicateGroup',
  'rank',
  'rgb',
  'rgba',
  'shape',
  'size',
  'specification',
  'style',
  'styleGroup',
  'summary',
  'tag',
  'tail',
  'technology',
  'textSize',
  'this',
  'title',
  'variant',
  'views',
  'where',
  'with',
]);

/** One relation of the workspace, at its own ends. */
interface WorkspaceRelation {
  id: string;
  from: string;
  to: string;
  label: string;
}

/**
 * Renders the workspace at one time and state (`at`, the query engine's own
 * defaults when left out). Which views exist is the view set's answer;
 * which elements and relations exist is the query engine's unscoped view
 * holding every element, where every relation is drawn between its own
 * ends (merged per pair, split here into one arrow per relation id, each
 * labelled as the view set labels an arrow of one relation). Kinds, names,
 * technology and labels come from the compiled model by id. Every error is
 * collected, and a workspace with any error is not returned at all.
 */
export function renderLikeC4Workspace(engine: QueryEngine, model: CompiledModel, at?: QueryTime): LikeC4Result {
  const viewSet = buildViewSet(engine, model, at);
  if (viewSet.views === undefined) return { errors: viewSet.errors };

  const every = engine.view({ depth: EVERY_LEVEL }, at);
  if (every.error !== undefined) return { errors: [{ message: `the workspace: every element and relation: ${every.error.message}`, query: every.error }] };

  const errors: LikeC4Error[] = [];
  const compiled = new Map(model.elements.map((element) => [element.id, element]));
  const elements = every.elements!.filter((element) => {
    if (compiled.has(element.id)) return true;
    errors.push({ message: `the workspace: the element "${element.id}" is shown by the query engine but the compiled model does not hold it`, elementId: element.id });
    return false;
  });

  const labels = labeller(model);
  const relations: WorkspaceRelation[] = [];
  for (const pair of every.relations!) {
    for (const id of pair.relationIds) {
      const label = labels([id], (relationId, problem) => {
        errors.push({ message: `the workspace: the arrow from "${pair.from}" to "${pair.to}" stands for the relation "${relationId}", ${problem}`, relationId });
      });
      relations.push({ id, from: pair.from, to: pair.to, label });
    }
  }
  if (errors.length > 0) return { errors };

  const names = uniqueSafeIds(
    elements.map((element) => element.id),
    identifier,
  );
  const fqns = fullNames(elements, names);
  const shown = elements.map((element) => compiled.get(element.id)!);

  const lines = [HEADER, '', 'specification {'];
  for (const kind of [...new Set(shown.map((element) => element.kind))].sort(byCodePoint)) lines.push(...kindLines(kind));
  lines.push('}', '', 'model {');
  const children = childrenByParent(elements);
  const nest = (parent: string | undefined, indent: string): void => {
    for (const element of children.get(parent) ?? []) {
      const own = compiled.get(element.id)!;
      const head = `${indent}${names.get(element.id)} = ${own.kind} ${text(own.name ?? own.id)}`;
      if (own.technology === undefined && !children.has(element.id)) {
        lines.push(head);
        continue;
      }
      lines.push(`${head} {`);
      if (own.technology !== undefined) lines.push(`${indent}  technology ${text(own.technology)}`);
      nest(element.id, `${indent}  `);
      lines.push(`${indent}}`);
    }
  };
  nest(undefined, '  ');
  if (relations.length > 0) lines.push('');
  for (const relation of relations.sort((a, b) => byCodePoint(a.id, b.id))) {
    lines.push(`  ${fqns.get(relation.from)} -> ${fqns.get(relation.to)} ${text(relation.label)}`);
  }
  lines.push('}', '', 'views {');
  for (const view of viewSet.views) {
    const scope = view.scope === undefined ? undefined : compiled.get(view.scope)!;
    const head = scope === undefined ? 'view index' : `view ${names.get(scope.id)} of ${fqns.get(scope.id)}`;
    lines.push(`  ${head} {`, `    title ${text(scope === undefined ? 'Landscape' : (scope.name ?? scope.id))}`, '    include *', '  }');
  }
  lines.push('}', '');
  return { workspace: lines.join('\n'), errors: [] };
}

/**
 * An element id made a LikeC4 identifier: every character outside letters,
 * digits, `_` and `-` replaced by `_`, a leading `_` before one that does not
 * start with a letter (a madarch id starts with a letter or a digit), and a
 * keyword given a trailing `_`.
 */
function identifier(id: string): string {
  const replaced = id.replace(/[^A-Za-z0-9_-]/g, '_');
  const started = /^[A-Za-z]/.test(replaced) ? replaced : `_${replaced}`;
  return RESERVED.has(started) ? `${started}_` : started;
}

/** Each element's LikeC4 full name: its ancestors' identifiers and its own, joined by dots. */
function fullNames(elements: readonly ElementAnswer[], names: ReadonlyMap<string, string>): Map<string, string> {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const fqns = new Map<string, string>();
  const fqn = (element: ElementAnswer): string => {
    const known = fqns.get(element.id);
    if (known !== undefined) return known;
    const own = names.get(element.id)!;
    const full = element.parent === undefined ? own : `${fqn(byId.get(element.parent)!)}.${own}`;
    fqns.set(element.id, full);
    return full;
  };
  for (const element of elements) fqn(element);
  return fqns;
}

/** Each parent's children (the elements with no parent under `undefined`), by id in code point order. */
function childrenByParent(elements: readonly ElementAnswer[]): Map<string | undefined, ElementAnswer[]> {
  const children = new Map<string | undefined, ElementAnswer[]>();
  for (const element of [...elements].sort((a, b) => byCodePoint(a.id, b.id))) {
    const siblings = children.get(element.parent) ?? [];
    siblings.push(element);
    children.set(element.parent, siblings);
  }
  return children;
}

function kindLines(kind: CompiledElement['kind']): string[] {
  const style = STYLES[kind];
  if (style === undefined) return [`  element ${kind}`];
  return [`  element ${kind} {`, '    style {', ...style.map((line) => `      ${line}`), '    }', '  }'];
}

const ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\v': '\\v',
  '\u0000': '\\0',
};

/** A LikeC4 string: in double quotes, a quote, a backslash and every control character LikeC4 has an escape for escaped. */
function text(value: string): string {
  return `"${value.replace(/["\\\b\f\n\r\t\v\u0000]/g, (char) => ESCAPES[char]!)}"`;
}
