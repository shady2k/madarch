/**
 * The reads and names of decision 0036, section 8, read from the source.
 *
 * Two things the decision asks of the server's page and API layer are about text rather than about the import graph,
 * so they are read here from the syntax tree:
 *
 * - **graphql-only-reads**: every route the server answers is `/graphql`, `/graphql/schema`, or one of the routes
 *   section 8 keeps because it is not graph data — the product identity and status, the event stream, a source file's
 *   text, the fill and its runs, the run's trace, the agents and settings, the journal, the kind usage, the refresh plan,
 *   the resets, the graph verdicts, the page rewrite and start-fresh commands, the answer/correction and problem/task
 *   writes, and the model mode's `/models`, `/views` and `/sources`. A read of a page, a block, a catalogue, a search, a
 *   statement, a neighborhood, a view or a document is GraphQL's.
 * - **no-kind-names**: the server and the GraphQL layer name no kind. The kinds are the product's data, declared in its
 *   catalogue; a route, a status or a schema that names one is a second source of truth. (Starter data may name them:
 *   `catalog/` is data.)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseSync } from '@swc/core';
import { absolutePathOf, type ModuleSet } from './sources.js';
import { orderedViolations, type ArchitectureViolation } from './violation.js';

/** The routes section 8 keeps, with the graph's own one: everything else is read through `/graphql`. */
export const ALLOWED_ROUTES: readonly string[] = [
  '/graphql',
  '/graphql/schema',
  '/api/events',
  '/api/product',
  '/api/products',
  '/api/status',
  '/api/source',
  '/api/kind-usage',
  '/api/run',
  '/api/fill',
  '/api/fill-selected',
  '/api/fill-runs',
  '/api/pause',
  '/api/stop',
  '/api/agents',
  '/api/agent',
  '/api/agent-choices',
  '/api/model-role',
  '/api/settings',
  '/api/product-settings',
  '/api/journal',
  '/api/refresh-plan',
  '/api/reset',
  '/api/graph-verdicts',
  '/api/rewrite-pages',
  '/api/start-fresh',
  '/api/answer',
  '/api/correction',
  '/api/problem-dismiss',
  '/api/problem-task',
  '/api/task-propose',
  '/api/task-create',
  '/api/task-close',
  '/api/task-run',
  '/models',
  '/views',
  '/sources',
];

/** The route table's module: where every HTTP route stands, one entry each. */
const ROUTE_MODULE = 'src/server/http.ts';

/** The modules whose literals must name no kind: the server's page and API layer, and the GraphQL API. */
const KIND_FREE_FOLDERS: readonly string[] = ['src/server', 'src/graphql'];

/** One node of a parsed module, as this rule walks it. */
type Node = Record<string, unknown>;

/** The 1-based line a byte offset falls on. */
function lineAt(bytes: Uint8Array, byteOffset: number): number {
  let line = 1;
  const end = Math.min(Math.max(byteOffset - 1, 0), bytes.length);
  for (let index = 0; index < end; index += 1) if (bytes[index] === 0x0a) line += 1;
  return line;
}

function parseModule(root: string, file: string): { ast: Node; bytes: Uint8Array } {
  const path = absolutePathOf(root, file);
  const source = readFileSync(path, 'utf8');
  let ast: unknown;
  try {
    ast = parseSync(source, file.endsWith('.tsx') ? { syntax: 'typescript', tsx: true, decorators: true } : { syntax: 'typescript', decorators: true });
  } catch (error) {
    throw new Error(`${path}:1: the module could not be parsed by swc: ${(error as Error).message}`);
  }
  return { ast: ast as Node, bytes: new TextEncoder().encode(source) };
}

/** Every node of a tree, in source order. */
function* nodesOf(value: unknown): Generator<Node> {
  if (Array.isArray(value)) {
    for (const item of value) yield* nodesOf(item);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const node = value as Node;
  yield node;
  for (const [key, entry] of Object.entries(node)) {
    if (key === 'span' || key === 'ctxt') continue;
    yield* nodesOf(entry);
  }
}

/** A property's value of an object literal, by its key. */
function propertyOf(object: Node, key: string): Node | undefined {
  const properties = Array.isArray(object['properties']) ? (object['properties'] as Node[]) : [];
  for (const property of properties) {
    if (property['type'] !== 'KeyValueProperty') continue;
    const held = property['key'] as Node | undefined;
    if (held?.['type'] === 'Identifier' && held['value'] === key) return property['value'] as Node | undefined;
    if (held?.['type'] === 'StringLiteral' && held['value'] === key) return property['value'] as Node | undefined;
  }
  return undefined;
}

/** The `API` map of `src/knowledge/addresses.ts`: each member's literal path. */
function apiRoutesOf(root: string): Map<string, string> {
  const { ast } = parseModule(root, 'src/knowledge/addresses.ts');
  const routes = new Map<string, string>();
  for (const node of nodesOf(ast)) {
    if (node['type'] !== 'VariableDeclarator') continue;
    const id = node['id'] as Node | undefined;
    const init = node['init'] as Node | undefined;
    const object = unwrap(init);
    if (id?.['type'] !== 'Identifier' || id['value'] !== 'API' || object?.['type'] !== 'ObjectExpression') continue;
    for (const property of object['properties'] as Node[]) {
      if (property['type'] !== 'KeyValueProperty') continue;
      const key = property['key'] as Node;
      const value = property['value'] as Node;
      if (key['type'] === 'Identifier' && value['type'] === 'StringLiteral') routes.set(String(key['value']), String(value['value']));
    }
  }
  return routes;
}

/** An expression with its type-only wrappers taken off: `{ ... } as const` is an object literal. */
function unwrap(expression: Node | undefined): Node | undefined {
  let held = expression;
  while (held !== undefined && held !== null && ['TsAsExpression', 'TsConstAssertion', 'TsSatisfiesExpression', 'ParenthesisExpression'].includes(String(held['type']))) {
    held = held['expression'] as Node | undefined;
  }
  return held ?? undefined;
}

/** The module-level string constants of `src/server/http.ts`, by name: a route written as one is read here. */
function stringConstantsOf(ast: Node): Map<string, string> {
  const constants = new Map<string, string>();
  for (const node of nodesOf(ast)) {
    if (node['type'] !== 'VariableDeclarator') continue;
    const id = node['id'] as Node | undefined;
    const init = node['init'] as Node | undefined;
    const literal = unwrap(init);
    if (id?.['type'] === 'Identifier' && literal?.['type'] === 'StringLiteral') {
      const value = String(literal['value']);
      if (value.startsWith('/')) constants.set(String(id['value']), value);
    }
  }
  return constants;
}

/** The path an expression names, when it is a literal, a constant, or a member of the API map. */
function pathOf(expression: Node | undefined, constants: ReadonlyMap<string, string>, api: ReadonlyMap<string, string>): string | undefined {
  if (expression === undefined) return undefined;
  if (expression['type'] === 'StringLiteral') return String(expression['value']);
  if (expression['type'] === 'Identifier') return constants.get(String(expression['value']));
  if (expression['type'] === 'MemberExpression') {
    const object = expression['object'] as Node;
    const property = expression['property'] as Node;
    if (object['type'] === 'Identifier' && object['value'] === 'API' && property['type'] === 'Identifier') return api.get(String(property['value']));
  }
  return undefined;
}

/**
 * Every route of the server's route table that section 8 does not keep: a read route outside `/graphql` and the kept
 * list is refused even when its handler is a stub, because a second read surface is the thing the decision deletes.
 */
export function routeViolations(root: string): ArchitectureViolation[] {
  const { ast, bytes } = parseModule(root, ROUTE_MODULE);
  const constants = stringConstantsOf(ast);
  const api = apiRoutesOf(root);
  const violations: ArchitectureViolation[] = [];
  for (const node of nodesOf(ast)) {
    if (node['type'] !== 'ObjectExpression') continue;
    const method = propertyOf(node, 'method');
    const path = propertyOf(node, 'path');
    if (method === undefined || path === undefined) continue;
    const named = pathOf(path, constants, api);
    if (named === undefined) continue;
    if (ALLOWED_ROUTES.includes(named)) continue;
    const span = node['span'] as { start: number } | undefined;
    violations.push({ rule: 'graphql-only-reads', file: ROUTE_MODULE, line: span === undefined ? 1 : lineAt(bytes, span.start), symbol: named });
  }
  return orderedViolations(violations);
}

/** The kinds the starter catalogue declares as data: every `catalog/<area>/<subgroup>/<kind>.yaml` whose name is dotted. */
export function catalogueKindNames(root: string): string[] {
  const names: string[] = [];
  const visit = (folder: string, path: string): void => {
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = path === '' ? entry.name : `${path}/${entry.name}`;
      if (entry.isDirectory()) visit(join(folder, entry.name), relative);
      else if (entry.isFile() && entry.name.endsWith('.yaml') && relative.split('/').length === 3) {
        const name = basename(entry.name, '.yaml');
        if (name.includes('.')) names.push(name);
      }
    }
  };
  visit(join(root, 'catalog'), '');
  return [...new Set(names)].sort();
}

/** Every string literal of the page and API layer that names a kind the catalogue declares. */
export function kindNameViolations(root: string, modules: ModuleSet): ArchitectureViolation[] {
  const kinds = new Set(catalogueKindNames(root));
  const violations: ArchitectureViolation[] = [];
  for (const file of modules.modules) {
    if (!KIND_FREE_FOLDERS.some((folder) => file.startsWith(`${folder}/`))) continue;
    const { ast, bytes } = parseModule(root, file);
    for (const node of nodesOf(ast)) {
      if (node['type'] !== 'StringLiteral') continue;
      const value = String(node['value']);
      if (!kinds.has(value)) continue;
      const span = node['span'] as { start: number } | undefined;
      violations.push({ rule: 'no-kind-names', file, line: span === undefined ? 1 : lineAt(bytes, span.start), symbol: value });
    }
  }
  return orderedViolations(violations);
}
