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
import { existsSync } from 'node:fs';
import { absolutePathOf, type ModuleSet } from './sources.js';
import { orderedViolations, type ArchitectureViolation } from './violation.js';

/**
 * The routes section 8 keeps, with the graph's own one: everything else is read through `/graphql`. `*` is a route kept
 * for every method; an entry with a method keeps only that method (`/api/authored` keeps its writes and not its read).
 */
export interface AllowedRoute {
  readonly method: string;
  readonly path: string;
}

export const ALLOWED_ROUTES: readonly AllowedRoute[] = [
  { method: '*', path: '/graphql' },
  { method: '*', path: '/graphql/schema' },
  { method: '*', path: '/api/events' },
  { method: '*', path: '/api/product' },
  { method: '*', path: '/api/products' },
  { method: '*', path: '/api/status' },
  { method: '*', path: '/api/source' },
  { method: '*', path: '/api/kind-usage' },
  { method: '*', path: '/api/run' },
  { method: '*', path: '/api/fill' },
  { method: '*', path: '/api/fill-selected' },
  { method: '*', path: '/api/fill-runs' },
  { method: '*', path: '/api/pause' },
  { method: '*', path: '/api/stop' },
  { method: '*', path: '/api/agents' },
  { method: '*', path: '/api/agent' },
  { method: '*', path: '/api/agent-choices' },
  { method: '*', path: '/api/model-role' },
  { method: '*', path: '/api/settings' },
  { method: '*', path: '/api/product-settings' },
  { method: '*', path: '/api/journal' },
  { method: '*', path: '/api/refresh-plan' },
  { method: '*', path: '/api/reset' },
  { method: '*', path: '/api/graph-verdicts' },
  { method: '*', path: '/api/rewrite-pages' },
  { method: '*', path: '/api/start-fresh' },
  { method: '*', path: '/api/answer' },
  { method: '*', path: '/api/correction' },
  { method: '*', path: '/api/problem-dismiss' },
  { method: '*', path: '/api/problem-task' },
  { method: '*', path: '/api/task-propose' },
  { method: '*', path: '/api/task-create' },
  { method: '*', path: '/api/task-close' },
  { method: '*', path: '/api/task-run' },
  // The authored writes are commands section 8 keeps; the authored reads are GraphQL's.
  { method: 'POST', path: '/api/authored' },
  { method: 'PATCH', path: '/api/authored' },
  { method: 'DELETE', path: '/api/authored' },
  // The fill's own unit tool channel: a unit's MCP server forwards its calls here, and it is not a page read.
  { method: 'POST', path: '/api/fill/unit/tool' },
  { method: '*', path: '/models' },
  { method: '*', path: '/views' },
  { method: '*', path: '/sources' },
];

/** The route table's module: where every HTTP route stands, one entry each. */
const ROUTE_MODULE = 'src/server/http.ts';

/**
 * The folders whose literals must name no kind (section 8): the server's page and API layer, the GraphQL API, the
 * knowledge modules that remain, and the app. The catalogue itself is data and names them freely.
 */
export const KIND_FREE_FOLDERS: readonly string[] = ['src/server', 'src/graphql', 'src/knowledge', 'wiki/app/src'];

/** The folders the module set of this rule holds: the product's, plus the app's own package. */
export const RULE_FOLDERS: readonly string[] = ['src', 'scripts', 'wiki/app/src'];

/** One node of a parsed module, as this rule walks it. */
type Node = Record<string, unknown>;

/** The 1-based line a byte offset falls on. */
function lineAt(bytes: Uint8Array, byteOffset: number): number {
  let line = 1;
  const end = Math.min(Math.max(byteOffset - 1, 0), bytes.length);
  for (let index = 0; index < end; index += 1) if (bytes[index] === 0x0a) line += 1;
  return line;
}

function parseModule(root: string, file: string): { ast: Node; bytes: Uint8Array; source: string } {
  const path = absolutePathOf(root, file);
  const source = readFileSync(path, 'utf8');
  let ast: unknown;
  try {
    ast = parseSync(source, file.endsWith('.tsx') ? { syntax: 'typescript', tsx: true, decorators: true } : { syntax: 'typescript', decorators: true });
  } catch (error) {
    throw new Error(`${path}:1: the module could not be parsed by swc: ${(error as Error).message}`);
  }
  return { ast: ast as Node, bytes: new TextEncoder().encode(source), source };
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

/** The module-level string constants of one module, by name: a route written as one is read here. */
function stringConstantsOfModule(root: string, file: string): Map<string, string> {
  const { ast } = parseModule(root, file);
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

/** The string constants `file` imports from the repository's own modules, resolved through the module that exports them. */
function importedStringConstantsOf(root: string, file: string): Map<string, string> {
  const { ast } = parseModule(root, file);
  const constants = new Map<string, string>();
  const visit = (node: Node): void => {
    if (node['type'] !== 'ImportDeclaration') return;
    const specifier = String((node['source'] as Node | undefined)?.['value'] ?? '');
    if (!specifier.startsWith('.')) return;
    const joined = resolveImport(dirnamePosix(file), specifier);
    const base = joined.endsWith('.js') ? joined.slice(0, -3) : joined;
    const target = [`${base}.ts`, `${base}.tsx`, `${joined}`].find((candidate) => existsSync(absolutePathOf(root, candidate)));
    if (target === undefined) return;
    const exported = stringConstantsOfModule(root, target);
    for (const one of node['specifiers'] as Node[] ?? []) {
      if (one['type'] !== 'ImportSpecifier') continue;
      // `import { X }` carries no `imported` name in this parser: the local name is the exported one.
      const local = String((one['local'] as Node | undefined)?.['value'] ?? '');
      const imported = String((one['imported'] as Node | undefined)?.['value'] ?? local);
      const value = exported.get(imported);
      if (value !== undefined) constants.set(local, value);
    }
  };
  for (const node of nodesOf(ast)) visit(node);
  return constants;
}

/** A module's directory, as a `/`-separated path from the repository root. */
function dirnamePosix(file: string): string {
  const cut = file.lastIndexOf('/');
  return cut < 0 ? '' : file.slice(0, cut);
}

/** `a/b/../c` as `a/c`, so an import resolves to the path the module set knows. */
function resolveImport(dirname: string, specifier: string): string {
  const parts = [...dirname.split('/'), ...specifier.split('/')].filter((part) => part !== '' && part !== '.');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/** The path an expression names, when it is a literal, a constant, or a member of the API map. */
function pathOf(expression: Node | undefined, constants: ReadonlyMap<string, string>, api: ReadonlyMap<string, string>): string | undefined {
  if (expression === undefined) return undefined;
  if (expression['type'] === 'StringLiteral') return String(expression['value']);
  // A template with no substitution names one path: it is read as that path, and then checked like a literal.
  if (expression['type'] === 'TemplateLiteral') {
    const expressions = Array.isArray(expression['expressions']) ? (expression['expressions'] as unknown[]) : [];
    const quasis = Array.isArray(expression['quasis']) ? (expression['quasis'] as Node[]) : [];
    return expressions.length === 0 && quasis.length === 1 ? String((quasis[0]?.['cooked'] ?? quasis[0]?.['raw']) ?? '') : undefined;
  }
  if (expression['type'] === 'Identifier') return constants.get(String(expression['value']));
  if (expression['type'] === 'MemberExpression') {
    const object = expression['object'] as Node;
    const property = expression['property'] as Node;
    if (object['type'] === 'Identifier' && object['value'] === 'API' && property['type'] === 'Identifier') return api.get(String(property['value']));
  }
  return undefined;
}

/**
 * Every route of the server's route table that section 8 does not keep: a route outside `/graphql` and the kept list is
 * refused even when its handler is a stub, because a second read surface is the thing the decision deletes. A route whose
 * path or method this check cannot read (a computed path, a variable) is refused too: an unreadable route is not a pass.
 */
export function routeViolations(root: string): ArchitectureViolation[] {
  const { ast, bytes } = parseModule(root, ROUTE_MODULE);
  const constants = new Map([...stringConstantsOfModule(root, ROUTE_MODULE), ...importedStringConstantsOf(root, ROUTE_MODULE)]);
  const api = apiRoutesOf(root);
  const violations: ArchitectureViolation[] = [];
  const decoder = new TextDecoder();
  const written = (expression: Node): string => {
    const span = expression['span'] as { start: number; end: number } | undefined;
    return span === undefined ? '' : decoder.decode(bytes.subarray(Math.max(span.start - 1, 0), Math.max(span.end - 1, 0))).replaceAll('\n', ' ').trim();
  };
  for (const node of nodesOf(ast)) {
    if (node['type'] !== 'ObjectExpression') continue;
    const method = propertyOf(node, 'method');
    const path = propertyOf(node, 'path');
    if (method === undefined || path === undefined) continue;
    const span = node['span'] as { start: number } | undefined;
    const line = span === undefined ? 1 : lineAt(bytes, span.start);
    const namedMethod = method['type'] === 'StringLiteral' ? String(method['value']) : undefined;
    const named = pathOf(path, constants, api);
    if (named === undefined) {
      violations.push({ rule: 'graphql-only-reads', file: ROUTE_MODULE, line, symbol: `${namedMethod ?? '<computed method>'} ${written(path)}: not a literal path` });
      continue;
    }
    if (namedMethod === undefined) {
      violations.push({ rule: 'graphql-only-reads', file: ROUTE_MODULE, line, symbol: `${written(method)} ${named}: not a literal method` });
      continue;
    }
    const kept = ALLOWED_ROUTES.some((entry) => entry.path === named && (entry.method === '*' || entry.method === namedMethod));
    if (kept) continue;
    violations.push({ rule: 'graphql-only-reads', file: ROUTE_MODULE, line, symbol: `${namedMethod} ${named}` });
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
    // One violation per kind and file: a rule that states a kind on six lines is one debt, listed once at its first line.
    const seen = new Set<string>();
    for (const node of nodesOf(ast)) {
      if (node['type'] !== 'StringLiteral') continue;
      const value = String(node['value']);
      if (!kinds.has(value) || seen.has(value)) continue;
      seen.add(value);
      const span = node['span'] as { start: number } | undefined;
      violations.push({ rule: 'no-kind-names', file, line: span === undefined ? 1 : lineAt(bytes, span.start), symbol: value });
    }
  }
  return orderedViolations(violations);
}
