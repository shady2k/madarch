/**
 * The strict gates the owner asked for (madarch-64o5.121, /tmp/gates.md): every agreed principle is refused by a rule of
 * this check rather than trusted to a reviewer. A rule reads the TypeScript syntax tree (`@swc/core`) or the PostgreSQL
 * syntax tree (`libpg-query`), never a pattern over source text; today's violations stand in .architecture/violations.json
 * as debt that only shrinks, and a violation the list does not hold fails the check at once.
 *
 * The three gates that need a type or the database itself — evidence required by type, the permission-typed action
 * registry, the event trigger on ddl_command_end — are not rules here: they change the engine's types and its schema, and
 * the owner filed them with the core redesign.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { parseSync as parseTypeScript } from '@swc/core';
import { loadModule, parseSync as parseSql } from 'libpg-query';
import { parseDocument } from 'yaml';
import likec4Keywords from './external-likec4-keywords.json';
import { validateDeclaredJsonSchema } from '../../../src/graph/value-validation.js';
import { byCodePoint } from '../../../src/model/order.js';
import { orderedViolations, type ArchitectureViolation } from './violation.js';
import { declarationProtocolLiteral } from './protocol-literals.js';

/** The modules the engine is: the server's source and the wiki app's. Tests and the app's build are not engine code. */
const ENGINE_FOLDERS: readonly string[] = ['src', 'wiki/app/src'];

/** A module as the gates read it: its text, its syntax tree and the byte map that finds a line of a span. */
export interface GateModule {
  readonly file: string;
  readonly text: string;
  readonly tree: Record<string, unknown>;
  readonly lineAt: (offset: number) => number;
}

function parseModule(file: string, text: string, tsx: boolean): GateModule {
  let tree: unknown;
  try {
    tree = parseTypeScript(text, { syntax: 'typescript', tsx, decorators: true });
  } catch (error) {
    throw new Error(`${resolve(file)}:1: cannot parse the module for the gates: ${(error as Error).message}`);
  }
  const bytes = new TextEncoder().encode(text);
  // The gates walk a node's enclosing functions: every child names its parent once, here, so the walk is cheap.
  const root = tree as Record<string, unknown>;
  const link = (node: Record<string, unknown>): void => {
    for (const [key, entry] of Object.entries(node)) {
      if (key === 'span' || key === 'ctxt' || key === 'parent') continue;
      for (const child of Array.isArray(entry) ? entry : [entry]) {
        if (child === null || typeof child !== 'object') continue;
        const held = child as Record<string, unknown>;
        held['parent'] = node;
        link(held);
      }
    }
  };
  link(root);
  return {
    file,
    text,
    tree: root,
    lineAt: (offset: number): number => {
      let line = 1;
      const end = Math.max(1, Math.min(offset, bytes.length));
      for (let index = 0; index < end - 1; index += 1) if (bytes[index] === 10) line += 1;
      return line;
    },
  };
}

/** Whether a module is engine code as these gates read it: the app's `.ts`/`.tsx`, the server's `.ts`. */
export function isEngineModule(file: string): boolean {
  if (!/^(?:src|wiki\/app\/src)\//u.test(file)) return false;
  if (file.startsWith('wiki/app/src/locales/') || file.startsWith('wiki/app/dist/')) return false;
  if (/\.(?:test|spec)\.(?:ts|tsx)$/u.test(file) || /(?:^|\/)(?:__tests__|__fixtures__)\//u.test(file)) return false;
  return file.endsWith('.ts') || file.endsWith('.tsx');
}

/** Every module under the engine's folders, in code point order of the path from the repository root. */
export function engineModules(root: string): string[] {
  const files: string[] = [];
  for (const folder of ENGINE_FOLDERS) {
    const absolute = resolve(root, ...folder.split('/'));
    let entries;
    try {
      entries = readdirSync(absolute, { recursive: true, withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const file = relative(root, join(entry.parentPath ?? absolute, entry.name)).split('\\').join('/');
      if (isEngineModule(file)) files.push(file);
    }
  }
  return [...new Set(files)].sort(byCodePoint);
}

/** The parsed engine modules, cached per root: the rules read one tree each. */
const moduleCache = new Map<string, Map<string, GateModule>>();

function modulesOf(root: string): Map<string, GateModule> {
  const held = moduleCache.get(root);
  if (held !== undefined) return held;
  const parsed = new Map<string, GateModule>();
  for (const file of engineModules(root)) {
    parsed.set(file, parseModule(file, readFileSync(resolve(root, ...file.split('/')), 'utf8'), file.endsWith('.tsx')));
  }
  moduleCache.set(root, parsed);
  return parsed;
}

/** One syntax node, as the walk sees it. */
type Node = Record<string, unknown>;

/** Every node of a syntax tree, the root included, in source order. */
function nodesOf(tree: Node): Node[] {
  const found: Node[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (value === null || typeof value !== 'object') return;
    const node = value as Node;
    if (typeof node['type'] === 'string') found.push(node);
    for (const [key, entry] of Object.entries(node)) if (key !== 'span' && key !== 'ctxt' && key !== 'parent') walk(entry);
  };
  walk(tree);
  return found;
}

function spanOf(node: Node): { start: number } | undefined {
  return node['span'] as { start: number } | undefined;
}

function stringValue(node: Node): string | undefined {
  if (node['type'] === 'StringLiteral' && typeof node['value'] === 'string') return node['value'];
  if (node['type'] === 'TemplateElement') {
    const value = node['cooked'] ?? node['raw'];
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

/** The violations that name the same rule, file and symbol once, at the first line they were found on. */
function once(violations: readonly ArchitectureViolation[]): ArchitectureViolation[] {
  const held = new Map<string, ArchitectureViolation>();
  for (const violation of violations) {
    const key = `${violation.rule}\u0000${violation.file}\u0000${violation.symbol ?? ''}`;
    const seen = held.get(key);
    if (seen === undefined || violation.line < seen.line) held.set(key, violation);
  }
  return orderedViolations([...held.values()]);
}

// ---- gate 1: the engine holds no product data -------------------------------------------------

export interface CatalogueField { readonly name: string; readonly type: string; readonly reference: string | undefined; readonly schema: unknown; readonly line: number }
export interface CatalogueKind { readonly path: string; readonly name: string; readonly id: string | undefined; readonly fields: readonly CatalogueField[] }

/** A YAML node's line, from the document's own ranges: a reader is given the line the field stands on. */
function yamlLine(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (text.charCodeAt(index) === 10) line += 1;
  return line;
}

/** Every kind the starter catalogue declares, with its id and fields, read from `catalog/` by its own syntax tree. */
export function catalogueKinds(root: string): CatalogueKind[] {
  const kinds: CatalogueKind[] = [];
  const walk = (folder: string, path: string): void => {
    let entries;
    try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((left, right) => byCodePoint(left.name, right.name))) {
      const file = join(folder, entry.name);
      const relativePath = path === '' ? entry.name : `${path}/${entry.name}`;
      if (entry.isDirectory()) { walk(file, relativePath); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.yaml') || relativePath.startsWith('templates/')) continue;
      if (relativePath.split('/').length !== 3) continue;
      const text = readFileSync(file, 'utf8');
      const document = parseDocument(text);
      const raw = document.toJS() as Record<string, unknown> | null;
      if (raw === null || typeof raw !== 'object') continue;
      const fields: CatalogueField[] = [];
      const declared = raw['fields'];
      const sequence = document.get('fields') as { items?: readonly { range?: readonly [number, number, number] }[] } | undefined;
      if (Array.isArray(declared)) {
        declared.forEach((entry, index) => {
          if (entry === null || typeof entry !== 'object') return;
          const field = entry as Record<string, unknown>;
          if (typeof field['name'] !== 'string') return;
          const range = sequence?.items?.[index]?.range;
          fields.push({
            name: field['name'],
            type: typeof field['type'] === 'string' ? field['type'] : '',
            reference: typeof field['reference'] === 'string' ? field['reference'] : undefined,
            schema: field['schema'],
            line: range === undefined ? 1 : yamlLine(text, range[0]),
          });
        });
      }
      kinds.push({
        path: relativePath,
        name: basename(entry.name, '.yaml'),
        id: typeof raw['id'] === 'string' ? raw['id'] : undefined,
        fields,
      });
    }
  };
  walk(resolve(root, 'catalog'), '');
  return kinds.sort((left, right) => byCodePoint(left.path, right.path));
}

/**
 * The words the manifest format declares, read from the reader's own declaration in `src/product/manifest`: every
 * vocabulary list it holds (`KIND_FIELDS`, the views, the forms) and every property its types declare (`descriptions`).
 * Those words are the engine's — the reader names what it reads — and only a word the catalogue alone declares is
 * product data.
 */
export function manifestFormatWords(root: string): Set<string> {
  const words = new Set<string>();
  const folder = resolve(root, 'src/product/manifest');
  const walk = (directory: string): void => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((left, right) => byCodePoint(left.name, right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const file = relative(root, path).split('\\').join('/');
      const module = parseModule(file, readFileSync(path, 'utf8'), false);
      for (const node of nodesOf(module.tree)) {
        if (node['type'] === 'ArrayExpression') {
          const elements = node['elements'];
          if (!Array.isArray(elements) || elements.length === 0) continue;
          const values = elements.map((element: unknown) => {
            const expression = element === null || typeof element !== 'object' ? undefined : (element as Node)['expression'];
            return expression === undefined || expression === null || typeof expression !== 'object' ? undefined : stringValue(expression as Node);
          });
          if (values.every((value) => typeof value === 'string')) for (const value of values) words.add(value as string);
          continue;
        }
        if (node['type'] !== 'TsPropertySignature') continue;
        const key = node['key'] as Node | undefined;
        if (key?.['type'] === 'Identifier') words.add(String(key['value']));
        else if (key !== undefined && typeof key['value'] === 'string') words.add(key['value']);
      }
    }
  };
  walk(folder);
  return words;
}

/** SWC argument/array wrappers have no node type: keep their typed ancestors rather than losing the context. */
const protocolContexts = new WeakMap<GateModule, Map<Node, readonly Node[]>>();
function enclosing(module: GateModule, node: Node): readonly Node[] {
  let contexts = protocolContexts.get(module);
  if (contexts === undefined) {
    contexts = new Map<Node, readonly Node[]>();
    const walk = (value: unknown, parents: readonly Node[]): void => {
      if (Array.isArray(value)) { for (const entry of value) walk(entry, parents); return; }
      if (value === null || typeof value !== 'object') return;
      const held = value as Node;
      const typed = typeof held['type'] === 'string';
      if (typed) contexts!.set(held, parents);
      for (const [key, entry] of Object.entries(held)) {
        if (key !== 'parent' && key !== 'span' && key !== 'ctxt') walk(entry, typed ? [held, ...parents] : parents);
      }
    };
    walk(module.tree, []);
    protocolContexts.set(module, contexts);
  }
  return contexts.get(node) ?? [];
}

function named(node: unknown, name: string): boolean {
  return node !== null && typeof node === 'object' && (node as Node)['type'] === 'Identifier' && (node as Node)['value'] === name;
}

function typeCall(node: Node | undefined, method: string): boolean {
  const callee = node?.['callee'] as Node | undefined;
  return node?.['type'] === 'CallExpression' && callee?.['type'] === 'MemberExpression'
    && named(callee['object'], 'Type') && named(callee['property'], method);
}

/** TypeBox is authoritative only at the exported protocol declarations, never at arbitrary engine schemas. */
function protocolSchemaLiteral(module: GateModule, node: Node): boolean {
  if (module.file !== 'src/plugin/protocol.ts' && module.file !== 'src/plugin/closure.ts') return false;
  const parents = enclosing(module, node);
  const call = parents[0];
  if (!typeCall(call, 'Literal') || (call?.['arguments'] as { expression: Node }[] | undefined)?.[0]?.expression !== node) return false;
  const declaration = parents.find((entry) => entry['type'] === 'VariableDeclarator');
  if (declaration === undefined || (module.file === 'src/plugin/closure.ts' && !named(declaration['id'], 'PluginManifest'))) return false;
  if (!enclosing(module, declaration).some((entry) => entry['type'] === 'ExportDeclaration')) return false;
  return nodesOf(module.tree).some((entry) => entry['type'] === 'ImportDeclaration'
    && stringValue(entry['source'] as Node) === 'typebox'
    && nodesOf(entry).some((specifier) => specifier['type'] === 'ImportSpecifier' && named(specifier['local'], 'Type')
      && (specifier['local'] as Node)['ctxt'] === (((call?.['callee'] as Node)['object']) as Node)['ctxt']));
}

/** The only inferred runtime discriminant: a const from this class's declared Map<string, IndexedFile>. */
function indexedFileDiscriminant(module: GateModule, node: Node): boolean {
  if (module.file !== 'src/plugin/product-source.ts') return false;
  const comparison = enclosing(module, node)[0];
  if (comparison?.['type'] !== 'BinaryExpression' || !['===', '!=='].includes(String(comparison['operator']))) return false;
  const member = (comparison['left'] === node ? comparison['right'] : comparison['left']) as Node | undefined;
  if (member?.['type'] !== 'MemberExpression' || !named(member['property'], 'form')) return false;
  const object = member['object'] as Node;
  if (object['type'] !== 'Identifier') return false;
  const parents = enclosing(module, node);
  const authority = nodesOf(module.tree).find((entry) => entry['type'] === 'TsInterfaceDeclaration' && named(entry['id'], 'IndexedFile'));
  if (authority === undefined || !nodesOf(authority).some((entry) => entry['type'] === 'TsPropertySignature'
    && named(entry['key'], 'form') && nodesOf(entry).some((literal) => stringValue(literal) === stringValue(node)))) return false;
  const scope = parents.find((entry) => entry['type'] === 'ClassMethod' || entry['type'] === 'FunctionDeclaration');
  if (scope === undefined) return false;
  const declarations = nodesOf(scope).filter((entry) => entry['type'] === 'VariableDeclarator'
    && named(entry['id'], String(object['value'])) && (entry['id'] as Node)['ctxt'] === object['ctxt']);
  if (declarations.length !== 1) return false;
  const declaration = declarations[0]!;
  if (enclosing(module, declaration)[0]?.['kind'] !== 'const') return false;
  const annotation = (declaration['id'] as Node)['typeAnnotation'] as Node | undefined;
  if (annotation !== undefined && nodesOf(annotation).some((entry) => entry['type'] === 'TsTypeReference' && named(entry['typeName'], 'IndexedFile'))) return true;
  const init = declaration['init'] as Node | undefined;
  const callee = init?.['callee'] as Node | undefined;
  const map = callee?.['object'] as Node | undefined;
  if (init?.['type'] !== 'CallExpression' || callee?.['type'] !== 'MemberExpression' || !named(callee['property'], 'get')
    || map?.['type'] !== 'MemberExpression' || (map['object'] as Node | undefined)?.['type'] !== 'ThisExpression') return false;
  const owner = parents.find((entry) => entry['type'] === 'ClassDeclaration');
  return owner !== undefined && nodesOf(owner).some((entry) => entry['type'] === 'ClassProperty'
    && named(entry['key'], String((map['property'] as Node)['value']))
    && nodesOf(entry).some((type) => type['type'] === 'TsTypeReference' && named(type['typeName'], 'Map')
      && nodesOf(type).some((argument) => argument['type'] === 'TsTypeReference' && named(argument['typeName'], 'IndexedFile'))));
}

/** A type-level key must name an actual member of the imported authoritative daemon API. */
function daemonMemberLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  if (module.file !== 'src/product/daemon.ts') return false;
  const parent = enclosing(module, node).find((entry) => entry['type'] === 'TsTypeReference' || entry['type'] === 'TsIndexedAccessType');
  if (parent === undefined) return false;
  const reference = parent['type'] === 'TsIndexedAccessType' ? parent['objectType'] as Node :
    named(parent['typeName'], 'Pick') ? (parent['typeParams'] as Node | undefined)?.['params'] as Node[] | undefined : undefined;
  const target = Array.isArray(reference) ? reference[0] : reference;
  if (target?.['type'] !== 'TsTypeReference' || !named(target['typeName'], 'DaemonFills')) return false;
  const imported = nodesOf(module.tree).some((entry) => entry['type'] === 'ImportDeclaration'
    && stringValue(entry['source'] as Node) === './daemon-fills.js'
    && nodesOf(entry).some((specifier) => specifier['type'] === 'ImportSpecifier' && named(specifier['local'], 'DaemonFills')));
  const authority = modules.get('src/product/daemon-fills.ts');
  return imported && authority !== undefined && nodesOf(authority.tree).some((entry) => entry['type'] === 'TsInterfaceDeclaration'
    && named(entry['id'], 'DaemonFills') && enclosing(authority, entry).some((ancestor) => ancestor['type'] === 'ExportDeclaration')
    && nodesOf(entry).some((member) => ['TsPropertySignature', 'TsMethodSignature'].includes(String(member['type'])) && named(member['key'], String(stringValue(node)))));
}

/** A manifest error's first argument names the very schema member tested by its enclosing branch. */
function pluginManifestDiagnostic(module: GateModule, node: Node): boolean {
  if (module.file !== 'src/plugin/closure.ts') return false;
  const parents = enclosing(module, node);
  const call = parents[0];
  if (call?.['type'] !== 'CallExpression' || !named(call['callee'], 'refuse')
    || (call['arguments'] as { expression: Node }[] | undefined)?.[0]?.expression !== node) return false;
  const scope = parents.find((entry) => entry['type'] === 'FunctionDeclaration');
  if (!named(scope?.['identifier'], 'parsePluginManifest')) return false;
  const branch = parents.find((entry) => entry['type'] === 'IfStatement');
  const test = branch?.['test'] as Node | undefined;
  if (test === undefined || !nodesOf(test).some((entry) => entry['type'] === 'MemberExpression'
    && named(entry['object'], 'body') && named(entry['property'], String(stringValue(node))))) return false;
  const schema = nodesOf(module.tree).find((entry) => entry['type'] === 'VariableDeclarator' && named(entry['id'], 'PluginManifest'));
  const init = schema?.['init'] as Node | undefined;
  const properties = ((init?.['arguments'] as { expression: Node }[] | undefined)?.[0]?.expression)?.['properties'] as Node[] | undefined;
  return typeCall(init, 'Object') && properties !== undefined && properties.some((entry) => named(entry['key'], String(stringValue(node))))
    && scope !== undefined && nodesOf(scope).some((entry) => entry['type'] === 'VariableDeclarator' && named(entry['id'], 'body')
      && nodesOf(entry).some((type) => type['type'] === 'TsTypeReference' && named(type['typeName'], 'Partial')
        && nodesOf(type).some((argument) => argument['type'] === 'TsTypeReference' && named(argument['typeName'], 'PluginManifest'))));
}

/** Product CLI literals must occupy its closed command declaration or a dispatcher comparison using that declaration. */
function closedCommandLiteral(module: GateModule, node: Node): boolean {
  if (module.file !== 'src/product/cli.ts') return false;
  const all = nodesOf(module.tree);
  const declaration = all.find((entry) => entry['type'] === 'VariableDeclarator' && named(entry['id'], 'COMMANDS'));
  const commands = declaration?.['init'] as Node | undefined;
  if (commands?.['type'] !== 'ObjectExpression' || !enclosing(module, declaration!).some((entry) => entry['type'] === 'ExportDeclaration')) return false;
  const entries = commands['properties'] as Node[];
  const parents = enclosing(module, node);
  // Only the command's positionals array, not arbitrary strings within COMMANDS.
  const positional = parents.find((entry) => entry['type'] === 'KeyValueProperty' && named(entry['key'], 'positionals'));
  if (positional !== undefined && parents.includes(commands) && (positional['value'] as Node | undefined)?.['type'] === 'ArrayExpression') return true;
  const comparison = parents[0];
  if (comparison?.['type'] !== 'BinaryExpression' || comparison['operator'] !== '===' || comparison['right'] !== node
    || !named(comparison['left'], 'command') || !entries.some((entry) => (entry['key'] as Node | undefined)?.['value'] === stringValue(node))) return false;
  const scope = parents.find((entry) => entry['type'] === 'FunctionDeclaration');
  const main = all.find((entry) => entry['type'] === 'FunctionDeclaration' && named(entry['identifier'], 'main'));
  if (scope === undefined || main === undefined) return false;
  const readsCommand = nodesOf(main).some((entry) => entry['type'] === 'VariableDeclarator' && named(entry['id'], 'command')
    && nodesOf(entry).some((part) => part['type'] === 'MemberExpression' && named(part['object'], 'args')
      && ((part['property'] as Node | undefined)?.['expression'] as Node | undefined)?.['value'] === 0));
  const guard = nodesOf(main).find((entry) => entry['type'] === 'IfStatement'
    && nodesOf(entry['test'] as Node).some((test) => test['type'] === 'UnaryExpression' && test['operator'] === '!'
      && nodesOf(test).some((check) => check['type'] === 'BinaryExpression' && check['operator'] === 'in'
        && named(check['left'], 'command') && named(check['right'], 'COMMANDS')))
    && ((entry['consequent'] as Node | undefined)?.['type'] === 'ReturnStatement'
      || ((entry['consequent'] as Node | undefined)?.['type'] === 'BlockStatement'
        && ((entry['consequent'] as Node)['stmts'] as Node[]).some((statement) => statement['type'] === 'ReturnStatement'))));
  const guardsCommand = guard !== undefined;
  if (!readsCommand || !guardsCommand) return false;
  if (scope === main) return (spanOf(node)?.start ?? 0) > (spanOf(guard!)?.start ?? Infinity);
  return named(scope['identifier'], 'runWrapper') && nodesOf(main).some((entry) => entry['type'] === 'CallExpression'
    && named(entry['callee'], 'runWrapper') && named((entry['arguments'] as { expression: Node }[])[0]?.expression, 'command'));
}

/** Plugin command grammar is the PluginOptions verb union and its exact parser comparisons. */
function pluginCommandLiteral(module: GateModule, node: Node): boolean {
  if (module.file !== 'src/plugin/cli.ts') return false;
  const all = nodesOf(module.tree);
  const options = all.find((entry) => entry['type'] === 'TsInterfaceDeclaration' && named(entry['id'], 'PluginOptions'));
  const verb = options === undefined ? undefined : nodesOf(options).find((entry) => entry['type'] === 'TsPropertySignature' && named(entry['key'], 'verb'));
  if (verb === undefined || !nodesOf(verb).some((literal) => stringValue(literal) === stringValue(node))) return false;
  const parents = enclosing(module, node);
  if (parents.includes(verb)) return true;
  const comparison = parents[0];
  if (comparison?.['type'] !== 'BinaryExpression' || !['===', '!=='].includes(String(comparison['operator'])) || comparison['right'] !== node) return false;
  const scope = parents.find((entry) => entry['type'] === 'FunctionDeclaration');
  const left = comparison['left'] as Node;
  if (named(scope?.['identifier'], 'parse') && named(left, 'verb')) return scope !== undefined && nodesOf(scope).some((entry) => entry['type'] === 'VariableDeclarator'
    && named(entry['id'], 'verb') && nodesOf(entry).some((part) => part['type'] === 'MemberExpression' && named(part['object'], 'args')
      && ((part['property'] as Node | undefined)?.['expression'] as Node | undefined)?.['value'] === 0));
  return named(scope?.['identifier'], 'pluginCommand') && left['type'] === 'MemberExpression' && named(left['object'], 'parsed') && named(left['property'], 'verb');
}

/** The CLI help reads a lifecycle outcome returned by its imported, explicitly typed API. */
function lifecycleOutcomeLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  if (module.file !== 'src/product/cli.ts') return false;
  const parents = enclosing(module, node);
  const comparison = parents[0];
  const member = comparison?.['left'] as Node | undefined;
  if (comparison?.['type'] !== 'BinaryExpression' || comparison['operator'] !== '===' || comparison['right'] !== node
    || member?.['type'] !== 'MemberExpression' || !named(member['object'], 'context') || !named(member['property'], 'outcome')) return false;
  const scope = parents.find((entry) => entry['type'] === 'FunctionDeclaration');
  if (!named(scope?.['identifier'], 'whereHelp') || scope === undefined) return false;
  if (!nodesOf(scope).some((entry) => entry['type'] === 'VariableDeclarator' && named(entry['id'], 'context')
    && (entry['init'] as Node | undefined)?.['type'] === 'CallExpression' && named((entry['init'] as Node)['callee'], 'whereAmI'))) return false;
  if (!nodesOf(scope).some((entry) => entry['type'] === 'VariableDeclarator' && nodesOf(entry['id'] as Node).some((part) => part['type'] === 'Identifier' && named(part, 'whereAmI'))
    && nodesOf(entry['init'] as Node).some((part) => part['type'] === 'CallExpression' && (part['callee'] as Node | undefined)?.['type'] === 'Import'
      && (part['arguments'] as { expression: Node }[]).some((argument) => stringValue(argument.expression) === './lifecycle.js')))) return false;
  const authority = modules.get('src/product/lifecycle.ts');
  if (authority === undefined) return false;
  const api = nodesOf(authority.tree).find((entry) => entry['type'] === 'FunctionDeclaration' && named(entry['identifier'], 'whereAmI'));
  if (api === undefined || !enclosing(authority, api).some((entry) => entry['type'] === 'ExportDeclaration')) return false;
  const returnType = nodesOf(api['returnType'] as Node).find((entry) => entry['type'] === 'TsTypeReference');
  const typeName = (returnType?.['typeName'] as Node | undefined)?.['value'];
  const declaration = nodesOf(authority.tree).find((entry) => entry['type'] === 'TsTypeAliasDeclaration' && named(entry['id'], String(typeName)));
  return declaration !== undefined && nodesOf(declaration).some((entry) => entry['type'] === 'TsPropertySignature' && named(entry['key'], 'outcome')
    && nodesOf(entry).some((literal) => stringValue(literal) === stringValue(node)));
}

/** External keywords are valid only as direct entries of the renderer's reserved-name adapter. */
function likec4GrammarLiteral(module: GateModule, node: Node): boolean {
  if (module.file !== 'src/render/likec4.ts' || !likec4Keywords.keywords.includes(String(stringValue(node)))) return false;
  const parents = enclosing(module, node);
  if (parents[0]?.['type'] !== 'ArrayExpression') return false;
  const constructor = parents[1];
  const declaration = parents[2];
  if (constructor?.['type'] !== 'NewExpression' || !named(constructor['callee'], 'Set')
    || declaration?.['type'] !== 'VariableDeclarator' || !named(declaration['id'], 'RESERVED')) return false;
  const binding = declaration['id'] as Node;
  return nodesOf(module.tree).some((entry) => entry['type'] === 'CallExpression'
    && (entry['callee'] as Node | undefined)?.['type'] === 'MemberExpression'
    && named((entry['callee'] as Node)['property'], 'has')
    && named((entry['callee'] as Node)['object'], 'RESERVED')
    && ((entry['callee'] as Node)['object'] as Node)['ctxt'] === binding['ctxt']);
}

/** Evidence locator keys must belong to the consumed schema and follow validation of that exact receiver. */
function checkedLocatorLiteral(module:GateModule,node:Node,modules:Map<string,GateModule>):boolean {
  const authority=modules.get('src/graph/evidence-locator.ts');
  if(authority===undefined) return false;
  const schema=nodesOf(authority.tree).find(entry=>entry['type']==='VariableDeclarator'&&named(entry['id'],'EVIDENCE_LOCATOR_SCHEMA'));
  const properties=schema===undefined?undefined:nodesOf(schema).find(entry=>entry['type']==='KeyValueProperty'&&named(entry['key'],'properties'));
  if(!nodesOf(authority.tree).some(entry=>entry['type']==='CallExpression'&&named(entry['callee'],'validateDeclaredJsonSchema')&&named((entry['arguments'] as {expression:Node}[])[0]?.expression,'EVIDENCE_LOCATOR_SCHEMA'))) return false;
  if(properties===undefined||!((properties['value'] as Node)['properties'] as Node[]).some(entry=>named(entry['key'],stringValue(node)??''))) return false;
  if(!nodesOf(module.tree).some(entry=>entry['type']==='ImportDeclaration'&&resolve('/',module.file,'..',stringValue(entry['source'] as Node)??'')==='/src/graph/evidence-locator.js'
    &&nodesOf(entry).some(specifier=>specifier['type']==='ImportSpecifier'&&named(specifier['local'],'validateEvidenceLocator')))) return false;
  const parents=enclosing(module,node);
  if(parents[0]?.['type']!=='Computed'||parents[1]?.['type']!=='MemberExpression') return false;
  const receiver=parents[1]['object'] as Node;
  const functionNode=parents.find(entry=>entry['type']==='FunctionDeclaration');
  if(functionNode===undefined) return false;
  const shape=(value:Node)=>JSON.stringify(value,(key,entry)=>['span','ctxt','parent'].includes(key)?undefined:entry);
  return nodesOf(functionNode).some(entry=>entry['type']==='CallExpression'&&named(entry['callee'],'validateEvidenceLocator')
    &&spanOf(entry)!.start<spanOf(node)!.start&&shape((entry['arguments'] as {expression:Node}[])[0]?.expression??{})===shape(receiver));
}

function protectedSelectionFieldLiteral(module:GateModule,node:Node,modules:Map<string,GateModule>):boolean {
  const parents=enclosing(module,node),array=parents[0],call=parents[1];
  if(array?.['type']!=='ArrayExpression'||call?.['type']!=='CallExpression'||(call['arguments'] as {expression:Node}[])[3]?.expression!==array) return false;
  const kind=protectedRowKind(module,call,node);
  return kind!==undefined&&(systemFields(modules).get(kind)?.has(stringValue(node)??'')??false);
}

/** Infer protected row kinds through lexical collections; never infer from a variable's spelling. */
function protectedRowKind(module: GateModule, expression: Node, at: Node, depth=0): string|undefined {
  if(depth>24) return undefined;
  const recur=(value:Node,place=at)=>protectedRowKind(module,value,place,depth+1);
  if(expression['type']==='TsNonNullExpression') return recur(expression['expression'] as Node);
  if(expression['type']==='ConditionalExpression') {
    const yes=recur(expression['consequent'] as Node), no=expression['alternate'] as Node;
    if(no['type']==='NullLiteral' || named(no,'undefined')) return yes;
    if(named(expression['consequent'],'undefined') || (expression['consequent'] as Node)['type']==='NullLiteral') return recur(no);
    const alternative=recur(no);return yes===alternative?yes:undefined;
  }
  if(['AwaitExpression','ParenthesisExpression','OptionalChainingExpression'].includes(String(expression['type']))) return protectedRowKind(module,(expression['argument']??expression['expression']??expression['base']) as Node,at,depth);
  if(expression['type']==='MemberExpression' && (expression['property'] as Node)['type']==='Computed'
    && ((expression['property'] as Node)['expression'] as Node)['type']==='NumericLiteral') return recur(expression['object'] as Node);
  if(expression['type']==='CallExpression') {
    const callee=expression['callee'] as Node;
    if(callee['type']==='MemberExpression'&&['filter','sort','find'].some(name=>named(callee['property'],name))) return protectedRowKind(module,callee['object'] as Node,at,depth);
    if(callee['type']!=='Identifier') return undefined;
    const imported=nodesOf(module.tree).some(entry=>entry['type']==='ImportDeclaration'
      &&resolve('/',module.file,'..',stringValue(entry['source'] as Node)??'')==='/src/graph/records.js'
      &&nodesOf(entry).some(specifier=>specifier['type']==='ImportSpecifier'&&named(specifier['local'],String(callee['value']))&&named(specifier['imported']??specifier['local'],'readKindAssertions')));
    const args=expression['arguments'] as {expression:Node}[];
    if(imported) return stringValue(args[2]?.expression??{});
    if(module.file==='src/graph/fill-state.ts'&&named(callee,'readGraphRecords')) {
      const reader=nodesOf(module.tree).find(entry=>entry['type']==='FunctionDeclaration'&&named(entry['identifier'],'readGraphRecords'));
      if(reader!==undefined&&nodesOf(reader).some(entry=>entry['type']==='CallExpression'&&named(entry['callee'],'readAssertions')))
        return stringValue(args[2]?.expression??{});
    }

    const declaration=nodesOf(module.tree).find(entry=>entry['type']==='FunctionDeclaration'&&named(entry['identifier'],String(callee['value'])));
    if(declaration===undefined) return undefined;
    const parameters=declaration['params'] as Node[];
    const kindParameter=parameters[2]?.['pat'] as Node|undefined;
    const forwarded=nodesOf(declaration).find(entry=>entry['type']==='CallExpression'&&named((entry['arguments'] as {expression:Node}[])[2]?.expression,String(kindParameter?.['value']))
      && nodesOf(module.tree).some(importNode=>importNode['type']==='ImportDeclaration'&&resolve('/',module.file,'..',stringValue(importNode['source'] as Node)??'')==='/src/graph/records.js'
        &&nodesOf(importNode).some(specifier=>specifier['type']==='ImportSpecifier'&&named(specifier['local'],String((entry['callee'] as Node)['value']))&&named(specifier['imported']??specifier['local'],'readKindAssertions'))));
    if(forwarded!==undefined) return stringValue(args[2]?.expression??{});
    if(module.file==='src/graph/fill-state.ts'&&named(callee,'rows')) {
      const selected=nodesOf(declaration).find(entry=>entry['type']==='CallExpression'&&named(entry['callee'],'readGraphRecords'));
      const selectedArgs=selected?.['arguments'] as {expression:Node}[]|undefined;
      const template=selectedArgs?.[2]?.expression;
      if(template?.['type']==='TemplateLiteral'&&(template['quasis'] as Node[])[0]?.['cooked']==='system.'&&named((template['expressions'] as Node[])[0],'kind')) {
        const logical=stringValue(args[1]?.expression??{});
        if(logical!==undefined) return `system.${logical}`;
      }
    }
    const returns=nodesOf(declaration).filter(entry=>entry['type']==='ReturnStatement'&&entry['argument']!=null);
    const kinds=returns.map(entry=>recur(entry['argument'] as Node,entry));
    return kinds.length>0&&kinds[0]!==undefined&&kinds.every(kind=>kind===kinds[0])?kinds[0]:undefined;
  }
  if(expression['type']!=='Identifier') return undefined;
  const name=String(expression['value']);
  for(const scope of enclosing(module,at)) {
    if(scope['type']==='ForOfStatement') {
      const left=scope['left'] as Node;
      if(nodesOf(left).some(entry=>entry['type']==='VariableDeclarator'&&named(entry['id'],name)&&(entry['id'] as Node)['ctxt']===expression['ctxt'])) return recur(scope['right'] as Node,scope);
    }
    if(scope['type']==='ArrowFunctionExpression'&&(scope['params'] as Node[]).some(entry=>named(entry,name)&&entry['ctxt']===expression['ctxt'])) {
      const call=enclosing(module,scope).find(entry=>entry['type']==='CallExpression');
      const callee=call?.['callee'] as Node|undefined;
      if(callee?.['type']==='MemberExpression') return recur(callee['object'] as Node,call!);
    }
    if(scope['type']==='FunctionDeclaration'&&!enclosing(module,scope).some(parent=>parent['type']==='ExportDeclaration')) {
      const parameters=scope['params'] as Node[];
      const index=parameters.findIndex(parameter=>named(parameter['pat'],name)&&(parameter['pat'] as Node)['ctxt']===expression['ctxt']);
      if(index>=0) {
        const calls=nodesOf(module.tree).filter(entry=>entry['type']==='CallExpression'&&named(entry['callee'],String((scope['identifier'] as Node)['value'])));
        const kinds=calls.map(call=>{const argument=(call['arguments'] as {expression:Node}[])[index]?.expression;return argument===undefined?undefined:recur(argument,call);});
        if(kinds.length>0&&kinds[0]!==undefined&&kinds.every(kind=>kind===kinds[0])) return kinds[0];
      }
    }
    if(scope['type']!=='BlockStatement'&&scope['type']!=='Module') continue;
    const declarations=nodesOf(scope).filter(entry=>entry['type']==='VariableDeclarator'&&named(entry['id'],name)
      &&(entry['id'] as Node)['ctxt']===expression['ctxt']
      &&enclosing(module,entry).find(parent=>parent['type']==='BlockStatement'||parent['type']==='Module')===scope);
    if(declarations.length===1&&declarations[0]!['init']!=null) return recur(declarations[0]!['init'] as Node,declarations[0]!);
  }
  return undefined;
}
function protectedRowFieldLiteral(module: GateModule,node:Node,modules:Map<string,GateModule>):boolean {
  const parents=enclosing(module,node);
  if(parents[0]?.['type']!=='Computed'||parents[1]?.['type']!=='MemberExpression') return false;
  let projection=parents[1]['object'] as Node;
  if(projection['type']==='Identifier') {
    const declaration=nodesOf(module.tree).find(entry=>entry['type']==='VariableDeclarator'&&named(entry['id'],String(projection['value']))&&(entry['id'] as Node)['ctxt']===projection['ctxt']);
    projection=declaration?.['init'] as Node;
  }
  if(projection?.['type']!=='MemberExpression'||!named(projection['property'],'values')) return false;
  const kind=protectedRowKind(module,projection['object'] as Node,node);
  return kind!==undefined&&(systemFields(modules).get(kind)?.has(stringValue(node)??'')??false);
}

/** A typed FSM subset is vocabulary only through the imported machine's canonical state type. */
function machineStateSubsetLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  const parents=enclosing(module,node);
  const declaration=parents.find(entry=>entry['type']==='VariableDeclarator');
  if(parents[0]?.['type']!=='ArrayExpression'||declaration===undefined) return false;
  const annotation=nodesOf(declaration['id'] as Node).find(entry=>entry['type']==='TsTypeReference' && named(entry['typeName'],'UnitState'));
  if(annotation===undefined) return false;
  const imported=nodesOf(module.tree).some(entry=>entry['type']==='ImportDeclaration'
    && resolve('/',module.file,'..',stringValue(entry['source'] as Node)??'')==='/src/fill/fsm.js'
    && nodesOf(entry).some(specifier=>specifier['type']==='ImportSpecifier'&&named(specifier['local'],'UnitState')));
  const authority=modules.get('src/fill/fsm.ts');
  if(!imported||authority===undefined) return false;
  const type=nodesOf(authority.tree).find(entry=>entry['type']==='TsTypeAliasDeclaration'&&named(entry['id'],'UnitState'));
  if(type===undefined||!nodesOf(type).some(entry=>entry['type']==='TsTypeQuery'&&named(entry['exprName'],'UNIT_STATES'))) return false;
  const states=nodesOf(authority.tree).find(entry=>entry['type']==='VariableDeclarator'&&named(entry['id'],'UNIT_STATES'));
  return states!==undefined&&nodesOf(states).some(entry=>entry['type']==='StringLiteral'&&stringValue(entry)===stringValue(node));
}

/** Logical state keys are admitted only through the reader's system.${kind} projection. */
function stateSelectorListLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  if(module.file!=='src/graph/fill-state.ts') return false;
  const parents=enclosing(module,node);
  const property=parents[1];
  if(parents[0]?.['type']!=='ArrayExpression'||property?.['type']!=='KeyValueProperty') return false;
  const logical=String((property['key'] as Node)['value']);
  if(!parents.some(entry=>entry['type']==='VariableDeclarator'&&named(entry['id'],'fields'))) return false;
  const reader=nodesOf(module.tree).find(entry=>entry['type']==='FunctionDeclaration'&&named(entry['identifier'],'rows'));
  const call=reader===undefined?undefined:nodesOf(reader).find(entry=>entry['type']==='CallExpression'&&named(entry['callee'],'readGraphRecords'));
  const args=call?.['arguments'] as {expression:Node}[]|undefined;
  const kind=args?.[2]?.expression;
  const fields=args?.[3]?.expression;
  if(kind?.['type']!=='TemplateLiteral'||fields?.['type']!=='MemberExpression'||!named(fields['object'],'fields')) return false;
  const quasis=kind['quasis'] as Node[], expressions=kind['expressions'] as Node[];
  if(quasis.length!==2||quasis[0]?.['cooked']!=='system.'||quasis[1]?.['cooked']!==''||!named(expressions[0],'kind')
    || !named((fields['property'] as Node)?.['expression'],'kind')) return false;
  return systemFields(modules).get(`system.${logical}`)?.has(stringValue(node)??'')??false;
}

/** A transaction mode is admitted only where an owner-backed helper forwards that parameter. */
function transactionModeLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  const authority = modules.get('src/sql-driver.ts');
  const type = authority === undefined ? undefined : nodesOf(authority.tree).find(entry=>entry['type']==='TsTypeAliasDeclaration' && named(entry['id'],'SqlTransactionKind'));
  if (type === undefined || !nodesOf(type).some(entry=>entry['type']==='StringLiteral' && stringValue(entry)===stringValue(node))) return false;
  const ownerImport = nodesOf(module.tree).some(entry=>entry['type']==='ImportDeclaration'
    && resolve('/',module.file,'..',stringValue(entry['source'] as Node)??'')==='/src/adapters/database-owner.js'
    && nodesOf(entry).some(specifier=>specifier['type']==='ImportSpecifier' && named(specifier['local'],'DatabaseOwner')));
  if (!ownerImport) return false;
  const parents=enclosing(module,node);
  const declaration=parents.find(entry=>entry['type']==='FunctionDeclaration');
  const call=parents[0];
  const target=call?.['type']==='CallExpression' && (call['callee'] as Node)?.['type']==='Identifier'
    ? nodesOf(module.tree).find(entry=>entry['type']==='FunctionDeclaration' && named(entry['identifier'],String((call['callee'] as Node)['value']))) : declaration;
  if (target===undefined) return false;
  const parameters=target['params'] as Node[];
  const databaseParameter=parameters.find(parameter=>named(parameter['pat'],'database'));
  const databaseType=databaseParameter===undefined?undefined:nodesOf(databaseParameter).find(entry=>entry['type']==='TsTypeReference');
  const databaseAlias=databaseType===undefined?undefined:nodesOf(module.tree).find(entry=>entry['type']==='TsTypeAliasDeclaration' && named(entry['id'],String((databaseType['typeName'] as Node)?.['value'])));
  if(databaseAlias===undefined || !nodesOf(databaseAlias).some(entry=>entry['type']==='TsTypeReference' && named(entry['typeName'],'Pick'))
    || !nodesOf(databaseAlias).some(entry=>named(entry,'DatabaseOwner')) || !nodesOf(databaseAlias).some(entry=>stringValue(entry)==='transaction')) return false;
  const index=parameters.findIndex(parameter=>named(parameter['pat'],'kind'));
  if(index<0) return false;
  const parameter=parameters[index]!['pat'] as Node;
  if (!nodesOf(target).some(entry=>entry['type']==='CallExpression' && (entry['callee'] as Node)?.['type']==='MemberExpression'
    && named((entry['callee'] as Node)['property'],'transaction') && named((entry['callee'] as Node)['object'],'database') && named((entry['arguments'] as {expression:Node}[])[0]?.expression,'kind'))) return false;
  if(call?.['type']==='CallExpression') return (call['arguments'] as {expression:Node}[])[index]?.expression===node;
  return nodesOf(parameter).includes(node);
}

/** Storage field lists must agree with the exact protected declaration they select. */
function systemSelectorListLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  if (module.file !== 'src/graph/fill-orchestration.ts') return false;
  const parents = enclosing(module, node);
  if (parents[0]?.['type'] !== 'ArrayExpression') return false;
  const registry = systemFields(modules);
  const property = parents[1];
  if (property?.['type'] === 'KeyValueProperty') {
    const kind = stringValue(property['key'] as Node);
    const declaration = parents.find((entry) => entry['type'] === 'VariableDeclarator' && named(entry['id'], 'fields'));
    if (kind === undefined || declaration === undefined) return false;
    const reader = nodesOf(module.tree).find((entry) => entry['type'] === 'FunctionDeclaration' && named(entry['identifier'], 'read'));
    return reader !== undefined && nodesOf(reader).some((entry) => entry['type'] === 'MemberExpression' && named(entry['object'], 'fields'))
      && (registry.get(kind)?.has(stringValue(node) ?? '') ?? false);
  }
  const declaration = parents[1];
  if (declaration?.['type'] !== 'VariableDeclarator') return false;
  const name = (declaration['id'] as Node)['value'];
  const reader = nodesOf(module.tree).find((entry) => entry['type'] === 'FunctionDeclaration' && named(entry['identifier'], 'read'));
  if (reader === undefined) return false;
  const branch = nodesOf(reader).find((entry) => entry['type'] === 'ConditionalExpression' && named(entry['consequent'], String(name)));
  const condition = branch?.['test'] as Node | undefined;
  if (condition?.['type'] !== 'BinaryExpression' || condition['operator'] !== '===' || !named(condition['left'], 'kind')) return false;
  const kind = stringValue(condition['right'] as Node);
  return kind !== undefined && (registry.get(kind)?.has(stringValue(node) ?? '') ?? false);
}

/** A batch projector must validate the values it returns, after mapping declared semantic slots. */
function semanticBatchProjectors(module: GateModule): Set<string> {
  const imported = nodesOf(module.tree).some(entry => entry['type'] === 'ImportDeclaration'
    && stringValue(entry['source'] as Node) === '../model/semantic-role-protocol.js'
    && nodesOf(entry).some(specifier => specifier['type'] === 'ImportSpecifier' && named(specifier['local'], 'checkRoleProperties') && named(specifier['imported'] ?? specifier['local'], 'checkRoleProperties')));
  if (!imported) return new Set();
  return new Set(nodesOf(module.tree).filter(entry => entry['type'] === 'FunctionDeclaration').flatMap(projector => {
    const nodes = nodesOf(projector);
    const checked = nodes.find(entry => entry['type'] === 'CallExpression' && named(entry['callee'], 'checkRoleProperties')
      && named((entry['arguments'] as {expression: Node}[])[1]?.expression, 'values'));
    const role = checked === undefined ? undefined : (checked['arguments'] as {expression: Node}[])[0]?.expression;
    const roleChecked = role?.['type'] === 'ConditionalExpression' && named(role['consequent'], 'role')
      && (role['alternate'] as Node)['type'] === 'TemplateLiteral'
      && ((role['alternate'] as Node)['expressions'] as Node[]).length === 2
      && named(((role['alternate'] as Node)['expressions'] as Node[])[0], 'role')
      && named(((role['alternate'] as Node)['expressions'] as Node[])[1], 'edgeRole');
    const mappingSource = nodes.some(entry => entry['type'] === 'MemberExpression' && named(entry['object'], 'binding') && named(entry['property'], 'fields'));
    const mapped = nodes.some(entry => entry['type'] === 'ForOfStatement'
      && nodesOf(entry).some(child => child['type'] === 'CallExpression' && (child['callee'] as Node)['type'] === 'MemberExpression'
        && named((child['callee'] as Node)['object'], 'Object') && named((child['callee'] as Node)['property'], 'entries')
        && named((child['arguments'] as {expression: Node}[])[0]?.expression, 'mappings'))
      && nodesOf(entry).some(child => child['type'] === 'AssignmentExpression' && (child['left'] as Node)['type'] === 'MemberExpression'
        && named((child['left'] as Node)['object'], 'values') && ((child['left'] as Node)['property'] as Node)['type'] === 'Computed'
        && named(((child['left'] as Node)['property'] as Node)['expression'], 'semantic')));
    const returned = checked !== undefined && enclosing(module, checked).some(scope => scope['type'] === 'ArrowFunctionExpression'
      && nodesOf(scope).some(entry => entry['type'] === 'ReturnStatement' && (entry['argument'] as Node | undefined)?.['type'] === 'ObjectExpression'
        && ((entry['argument'] as Node)['properties'] as Node[]).some(property => named(property, 'values') || (named(property['key'], 'values') && named(property['value'], 'values')))));
    const requests = nodes.some(entry => entry['type'] === 'CallExpression' && (entry['callee'] as Node)['type'] === 'MemberExpression'
      && named((entry['callee'] as Node)['object'], 'requests') && named((entry['callee'] as Node)['property'], 'map')
      && nodesOf(entry).some(child => child['type'] === 'ObjectPattern' && ['role', 'fields', 'edgeRole'].every(name => nodesOf(child).some(property => named(property['key'], name)))));
    const plans = nodes.find(entry => entry['type'] === 'VariableDeclarator' && named(entry['id'], 'plans'));
    const planCall = plans?.['init'] as Node | undefined;
    const directRequests = planCall?.['type'] === 'CallExpression' && (planCall['callee'] as Node)['type'] === 'MemberExpression'
      && named((planCall['callee'] as Node)['object'], 'requests') && named((planCall['callee'] as Node)['property'], 'map');
    const result = nodes.find(entry => entry['type'] === 'ReturnStatement' && (entry['argument'] as Node | undefined)?.['type'] === 'CallExpression'
      && ((entry['argument'] as Node)['callee'] as Node)['type'] === 'MemberExpression'
      && named((((entry['argument'] as Node)['callee'] as Node)['object']), 'plans')
      && named((((entry['argument'] as Node)['callee'] as Node)['property']), 'map'));
    const resultCall = result?.['argument'] as Node | undefined;
    const resultMap = resultCall === undefined ? undefined : (resultCall['arguments'] as {expression: Node}[])[0]?.expression;
    const batchRead = nodes.find(entry => entry['type'] === 'VariableDeclarator' && named(entry['id'], 'batches'));
    const batchAwait = batchRead?.['init'] as Node | undefined;
    const batchCall = batchAwait?.['type'] === 'AwaitExpression' ? batchAwait['argument'] as Node : undefined;
    const batchPlan = batchCall?.['type'] === 'CallExpression' ? (batchCall['arguments'] as {expression: Node}[])[1]?.expression : undefined;
    const orderedRead = batchCall !== undefined && named(batchCall['callee'], 'readKindsAssertions') && batchPlan?.['type'] === 'CallExpression' && (batchPlan['callee'] as Node)['type'] === 'MemberExpression'
      && named((batchPlan['callee'] as Node)['object'], 'plans') && named((batchPlan['callee'] as Node)['property'], 'map');
    const forwarding = batchPlan === undefined ? undefined : (batchPlan['arguments'] as {expression: Node}[])[0]?.expression;
    const forwardsRequest = forwarding?.['type'] === 'ArrowFunctionExpression' && named((forwarding['params'] as Node[])[0], 'plan')
      && (forwarding['body'] as Node)['type'] === 'MemberExpression' && named((forwarding['body'] as Node)['object'], 'plan') && named((forwarding['body'] as Node)['property'], 'request');
    const indexed = resultMap?.['type'] === 'ArrowFunctionExpression' && named((resultMap['params'] as Node[])[1], 'index')
      && checked !== undefined && nodesOf(resultMap).includes(checked) && nodesOf(resultMap).some(entry => entry['type'] === 'MemberExpression' && named(entry['object'], 'batches')
      && (entry['property'] as Node)['type'] === 'Computed' && named((entry['property'] as Node)['expression'], 'index'));
    return roleChecked && mappingSource && mapped && returned && requests && directRequests && resultMap !== undefined && orderedRead && forwardsRequest && indexed
      ? [String((projector['identifier'] as Node)['value'])] : [];
  }));
}

function semanticBatchRequests(call: Node, projectors: Set<string>): Node[] | undefined {
  if (call['type'] !== 'CallExpression' || !projectors.has(String((call['callee'] as Node)['value']))) return undefined;
  const array = (call['arguments'] as {expression: Node}[])[1]?.expression;
  if (array?.['type'] !== 'ArrayExpression') return undefined;
  const elements = array['elements'] as {expression: Node}[];
  return elements.every(element => element?.expression['type'] === 'ObjectExpression') ? elements.map(element => element.expression) : undefined;
}

function semanticRequestRole(request: Node): string | undefined {
  const properties = request['properties'] as Node[];
  const role = stringValue(properties.find(property => named(property['key'], 'role'))?.['value'] as Node ?? {});
  const edgeNode = properties.find(property => named(property['key'], 'edgeRole'))?.['value'] as Node | undefined;
  const edge = edgeNode === undefined ? undefined : stringValue(edgeNode);
  return role === undefined || (edgeNode !== undefined && edge === undefined) ? undefined : edge === undefined ? role : `${role}.${edge}`;
}

/** Infer a private records row/collection role from the actual projector call and local return chain. */
function recordExpressionRole(module: GateModule, expression: Node, at: Node, depth = 0): string | undefined {
  if (depth > 24) return undefined;
  const recur = (value: Node, place = at): string | undefined => recordExpressionRole(module, value, place, depth + 1);
  if (expression['type'] === 'AwaitExpression' || expression['type'] === 'ParenthesisExpression' || expression['type'] === 'TsNonNullExpression') return recur((expression['argument'] ?? expression['expression']) as Node);
  if (expression['type'] === 'ConditionalExpression') { const yes=recur(expression['consequent'] as Node), no=recur(expression['alternate'] as Node); return yes===no?yes:undefined; }
  if (expression['type'] === 'CallExpression') {
    const callee = expression['callee'] as Node;
    if (named(callee, 'semanticRecords')) {
      const args = expression['arguments'] as { expression: Node }[];
      const role = stringValue(args[1]?.expression ?? {});
      const edge = args[3]?.expression === undefined ? undefined : stringValue(args[3].expression);
      return role === undefined ? undefined : edge === undefined ? role : `${role}.${edge}`;
    }
    if (callee['type'] === 'MemberExpression' && ['filter','sort','find'].some((name) => named(callee['property'], name))) return recur(callee['object'] as Node);
    if (callee['type'] === 'Identifier') {
      const declaration = nodesOf(module.tree).find((entry) => entry['type'] === 'FunctionDeclaration' && named(entry['identifier'], String(callee['value'])));
      if (declaration === undefined) return undefined;
      const returns = nodesOf(declaration).filter((entry) => entry['type'] === 'ReturnStatement' && entry['argument'] !== null
        && !((entry['argument'] as Node)['type'] === 'ArrayExpression' && ((entry['argument'] as Node)['elements'] as Node[]).length === 0));
      const roles = returns.map((entry) => recur(entry['argument'] as Node, entry));
      return roles.length > 0 && roles.every((role) => role === roles[0]) ? roles[0] : undefined;
    }
  }
  if (expression['type'] === 'MemberExpression' && (expression['property'] as Node)['type'] === 'Computed'
    && ((expression['property'] as Node)['expression'] as Node)['type'] === 'NumericLiteral') {
    let object = expression['object'] as Node;
    while (['AwaitExpression', 'ParenthesisExpression', 'TsNonNullExpression'].includes(String(object['type']))) object = (object['argument'] ?? object['expression']) as Node;
    const requests = semanticBatchRequests(object, semanticBatchProjectors(module));
    if (requests !== undefined) {
      const request = requests[Number(((expression['property'] as Node)['expression'] as Node)['value'])];
      return request === undefined ? undefined : semanticRequestRole(request);
    }
    return recur(expression['object'] as Node);
  }
  if (expression['type'] !== 'Identifier') return undefined;
  const name = String(expression['value']);
  for (const scope of enclosing(module, at)) {
    if (scope['type'] === 'FunctionDeclaration' && !enclosing(module, scope).some(parent => parent['type'] === 'ExportDeclaration')) {
      const index = (scope['params'] as Node[]).findIndex(parameter => named(parameter['pat'], name) && (parameter['pat'] as Node)['ctxt'] === expression['ctxt']);
      if (index >= 0) {
        const calls = nodesOf(module.tree).filter(entry => entry['type'] === 'CallExpression' && (named(entry['callee'], String((scope['identifier'] as Node)['value']))
          || (index === 0 && (entry['callee'] as Node)['type'] === 'MemberExpression' && named((entry['callee'] as Node)['property'], 'map')
            && named((entry['arguments'] as { expression: Node }[])[0]?.expression, String((scope['identifier'] as Node)['value'])))));
        const roles = calls.map(call => {
          const callee = call['callee'] as Node;
          const argument = callee['type'] === 'MemberExpression' ? callee['object'] as Node : (call['arguments'] as { expression: Node }[])[index]?.expression;
          return argument === undefined ? undefined : recur(argument, call);
        });
        if (roles.length > 0 && roles[0] !== undefined && roles.every(role => role === roles[0])) return roles[0];
        return undefined;
      }
    }
    if (scope['type'] === 'ArrowFunctionExpression' && (scope['params'] as Node[]).some((entry) => named(entry, name) && entry['ctxt'] === expression['ctxt'])) {
      const call = enclosing(module, scope).find((entry) => entry['type'] === 'CallExpression');
      const callee = call?.['callee'] as Node | undefined;
      if (callee?.['type'] === 'MemberExpression') return recur(callee['object'] as Node, call!);
    }
    if (scope['type'] !== 'BlockStatement' && scope['type'] !== 'Module') continue;
    const destructured = nodesOf(scope).filter(entry => entry['type'] === 'VariableDeclarator' && (entry['id'] as Node)['type'] === 'ArrayPattern'
      && enclosing(module, entry).find(parent => parent['type'] === 'BlockStatement' || parent['type'] === 'Module') === scope);
    for (const declaration of destructured) {
      const index = ((declaration['id'] as Node)['elements'] as (Node | null)[]).findIndex(element => {
        const binding = element?.['type'] === 'AssignmentPattern' ? element['left'] as Node : element;
        return binding !== null && named(binding, name) && binding?.['ctxt'] === expression['ctxt'];
      });
      let init = declaration['init'] as Node | undefined;
      if (init?.['type'] === 'AwaitExpression') init = init['argument'] as Node;
      const requests = init == null ? undefined : semanticBatchRequests(init, semanticBatchProjectors(module));
      if (index >= 0 && requests?.[index] !== undefined) return semanticRequestRole(requests[index]!);
    }
    const declarations = nodesOf(scope).filter((entry) => entry['type'] === 'VariableDeclarator' && named(entry['id'], name)
      && (entry['id'] as Node)['ctxt'] === expression['ctxt']
      && enclosing(module, entry).find((parent) => parent['type'] === 'BlockStatement' || parent['type'] === 'Module') === scope);
    if (declarations.length === 1 && declarations[0]!['init'] !== null) return recur(declarations[0]!['init'] as Node, declarations[0]!);
  }
  return undefined;
}

/** A private records projection's requested slots must belong to its exact checked role schema. */
function semanticRecordSlotsLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  if (module.file !== 'src/graph/records.ts') return false;
  const roles = semanticRoleSlots(modules);
  if (roles.size === 0) return false;
  const imported = nodesOf(module.tree).some((entry) => entry['type'] === 'ImportDeclaration'
    && stringValue(entry['source'] as Node) === '../model/semantic-role-protocol.js'
    && nodesOf(entry).some((specifier) => specifier['type'] === 'ImportSpecifier' && named(specifier['local'], 'checkRoleProperties')));
  const projector = nodesOf(module.tree).find((entry) => entry['type'] === 'FunctionDeclaration' && named(entry['identifier'], 'semanticRecords'));
  const batches = semanticBatchProjectors(module);
  if (!imported || (batches.size === 0 && (projector === undefined || !nodesOf(projector).some((entry) => entry['type'] === 'CallExpression' && named(entry['callee'], 'checkRoleProperties'))))) return false;
  for (const call of nodesOf(module.tree)) {
    const requests = semanticBatchRequests(call, batches);
    if (requests === undefined) continue;
    for (const request of requests) {
      const role = semanticRequestRole(request);
      const properties = request['properties'] as Node[];
      const property = properties.find(entry => entry['value'] === node || (entry['value'] as Node | undefined)?.['type'] === 'ArrayExpression'
        && ((entry['value'] as Node)['elements'] as {expression: Node}[]).some(element => element.expression === node));
      if (property === undefined || role === undefined) continue;
      if (named(property['key'], 'role')) return roles.has(stringValue(node) ?? '');
      if (named(property['key'], 'fields')) return roles.get(role)?.has(stringValue(node) ?? '') ?? false;
    }
  }
  const parents = enclosing(module, node);
  const parent = parents[0];
  if (parent?.['type'] === 'CallExpression' && named(parent['callee'], 'semanticRoleFields')) {
    const importedFields = nodesOf(module.tree).some((entry) => entry['type'] === 'ImportDeclaration' && stringValue(entry['source'] as Node) === '../model/semantic-role-protocol.js'
      && nodesOf(entry).some((specifier) => specifier['type'] === 'ImportSpecifier' && named(specifier['local'], 'semanticRoleFields')));
    return importedFields && (parent['arguments'] as { expression: Node }[])[0]?.expression === node && roles.has(stringValue(node) ?? '');
  }
  if (parent?.['type'] === 'CallExpression' && named(parent['callee'], 'semanticRecords')) {
    const args = parent['arguments'] as { expression: Node }[];
    return args[1]?.expression === node && roles.has(stringValue(node) ?? '');
  }
  let receiver: Node | undefined;
  if (parent?.['type'] === 'Computed' && parents[1]?.['type'] === 'MemberExpression') {
    let projection = parents[1]['object'] as Node;
    if (projection['type'] === 'Identifier') {
      const alias = nodesOf(module.tree).find(entry => entry['type'] === 'VariableDeclarator' && named(entry['id'], String(projection['value'])) && (entry['id'] as Node)['ctxt'] === projection['ctxt']);
      projection = alias?.['init'] as Node;
    }
    if (projection?.['type'] === 'MemberExpression' && ['key','values'].some((name) => named(projection['property'], name))) receiver = projection['object'] as Node;
  }
  if (parent?.['type'] === 'CallExpression' && named(parent['callee'], 'scalar')) {
    const args = parent['arguments'] as { expression: Node }[];
    const scalar = nodesOf(module.tree).find((entry) => entry['type'] === 'FunctionDeclaration' && named(entry['identifier'], 'scalar'));
    if (args[1]?.expression === node && scalar !== undefined && nodesOf(scalar).some((entry) => entry['type'] === 'MemberExpression' && named(entry['property'], 'values'))) receiver = args[0]?.expression;
  }
  if (receiver !== undefined) {
    const role = recordExpressionRole(module, receiver, node);
    return role !== undefined && (roles.get(role)?.has(stringValue(node) ?? '') ?? false);
  }
  const array = parent;
  if (array?.['type'] !== 'ArrayExpression') return false;
  const declaration = parents[1]?.['type'] === 'VariableDeclarator' ? parents[1] : undefined;
  const calls = nodesOf(module.tree).filter((entry) => entry['type'] === 'CallExpression' && named(entry['callee'], 'semanticRecords')
    && ((entry['arguments'] as { expression: Node }[])[2]?.expression === array
      || (declaration !== undefined && named((entry['arguments'] as { expression: Node }[])[2]?.expression, String((declaration['id'] as Node)['value'])))));
  if (calls.length === 0) return false;
  return calls.every((call) => {
    const args = call['arguments'] as { expression: Node }[];
    const role = stringValue(args[1]?.expression ?? {});
    const edge = args[3]?.expression === undefined ? undefined : stringValue(args[3].expression);
    return role !== undefined && (roles.get(edge === undefined ? role : `${role}.${edge}`)?.has(stringValue(node) ?? '') ?? false);
  });
}

/** Engine role slots come from the exported checked TypeBox protocol, not catalogue vocabulary. */
function semanticRoleSlots(modules: Map<string, GateModule>): Map<string, Set<string>> {
  const roles = new Map<string, Set<string>>();
  const module = modules.get('src/model/semantic-role-protocol.ts');
  if (module === undefined) return roles;
  const declaration = nodesOf(module.tree).find((entry) => entry['type'] === 'VariableDeclarator' && named(entry['id'], 'ROLE_BINDING_SCHEMA'));
  if (declaration === undefined || !enclosing(module, declaration).some((entry) => entry['type'] === 'ExportDeclaration')) return roles;
  const imported = nodesOf(module.tree).some((entry) => entry['type'] === 'ImportDeclaration' && stringValue(entry['source'] as Node) === 'typebox'
    && nodesOf(entry).some((specifier) => specifier['type'] === 'ImportSpecifier' && named(specifier['local'], 'Type')));
  if (!imported) return roles;
  const checker = nodesOf(module.tree).find((entry) => entry['type'] === 'FunctionDeclaration' && named(entry['identifier'], 'checkRoleProperties'));
  if (checker === undefined || !nodesOf(checker).some((entry) => entry['type'] === 'MemberExpression' && named(entry['object'], 'Value') && named(entry['property'], 'Check'))
    || !nodesOf(checker).some((entry) => named(entry, 'ROLE_BINDING_SCHEMA'))) return roles;
  const valueImport = nodesOf(module.tree).some((entry) => entry['type'] === 'ImportDeclaration' && stringValue(entry['source'] as Node) === 'typebox/value'
    && nodesOf(entry).some((specifier) => specifier['type'] === 'ImportSpecifier' && named(specifier['local'], 'Value')));
  const projectionModule = modules.get('src/knowledge/semantic-bindings.ts');
  const projector = projectionModule === undefined ? undefined : nodesOf(projectionModule.tree).find((entry) => entry['type'] === 'FunctionDeclaration' && named(entry['identifier'], 'semanticEntities'));
  const checkerImport = projectionModule !== undefined && nodesOf(projectionModule.tree).some((entry) => entry['type'] === 'ImportDeclaration' && stringValue(entry['source'] as Node) === '../model/semantic-role-protocol.js'
    && nodesOf(entry).some((specifier) => specifier['type'] === 'ImportSpecifier' && named(specifier['local'], 'checkRoleProperties')));
  if (!valueImport || !checkerImport || projector === undefined || !nodesOf(projector).some((entry) => entry['type'] === 'CallExpression' && named(entry['callee'], 'checkRoleProperties'))) return roles;
  for (const object of nodesOf(declaration).filter((entry) => entry['type'] === 'ObjectExpression')) {
    const properties = object['properties'] as Node[];
    const role = properties.find((entry) => named(entry['key'], 'role'))?.['value'] as Node | undefined;
    const fields = properties.find((entry) => named(entry['key'], 'properties'))?.['value'] as Node | undefined;
    if (role?.['type'] !== 'CallExpression' || fields?.['type'] !== 'CallExpression') continue;
    const roleName = stringValue((role['arguments'] as { expression: Node }[])[0]?.expression ?? {});
    const fieldsObject = (fields['arguments'] as { expression: Node }[])[0]?.expression;
    if (roleName === undefined || fieldsObject?.['type'] !== 'ObjectExpression') continue;
    roles.set(roleName, new Set((fieldsObject['properties'] as Node[]).flatMap((entry) => {
      const key = entry['key'] as Node;
      return typeof key['value'] === 'string' ? [key['value']] : [];
    })));
  }
  return roles;
}

/** Follow a projected collection through filter/sort/map receiver chains to its checked semantic role. */
function semanticCollectionRole(module: GateModule, expression: Node): string | undefined {
  let collection = expression;
  while (collection['type'] === 'CallExpression') {
    const callee = collection['callee'] as Node;
    if (callee['type'] !== 'MemberExpression') break;
    collection = callee['object'] as Node;
  }
  if (collection['type'] !== 'Identifier') return undefined;
  const declaration = nodesOf(module.tree).find((entry) => entry['type'] === 'VariableDeclarator' && named(entry['id'], String(collection['value'])));
  const init = declaration?.['init'] as Node | undefined;
  const call = init?.['type'] === 'AwaitExpression' ? init['argument'] as Node : init;
  if (call?.['type'] !== 'CallExpression' || !named(call['callee'], 'semanticEntities')) return undefined;
  const imported = nodesOf(module.tree).some((entry) => entry['type'] === 'ImportDeclaration'
    && stringValue(entry['source'] as Node)?.endsWith('/semantic-bindings.js')
    && nodesOf(entry).some((specifier) => specifier['type'] === 'ImportSpecifier' && named(specifier['local'], 'semanticEntities')));
  if (!imported) return undefined;
  return stringValue((call['arguments'] as { expression: Node }[])[2]?.expression ?? {});
}

function semanticProjectionLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  const parents = enclosing(module, node);
  const roles = semanticRoleSlots(modules);
  if (roles.size === 0) return false;
  if (module.file === 'src/model/semantic-role-protocol.ts') {
    const declaration = parents.find((entry) => entry['type'] === 'VariableDeclarator' && named(entry['id'], 'ROLE_BINDING_SCHEMA'));
    if (declaration !== undefined) {
      const literalCall = parents[0];
      return literalCall?.['type'] === 'CallExpression' && nodesOf(literalCall['callee'] as Node).some((entry) => named(entry, 'Literal'));
    }
  }
  const member = parents[0]?.['type'] === 'Computed' ? parents[1] : undefined;
  if (member?.['type'] !== 'MemberExpression') return false;
  const properties = member['object'] as Node;
  if (properties?.['type'] !== 'MemberExpression' || !named(properties['property'], 'properties')) return false;
  const receiver = properties['object'] as Node;
  if (receiver['type'] !== 'Identifier') return false;
  for (const callback of parents.filter((entry) => entry['type'] === 'ArrowFunctionExpression')) {
    if (!(callback['params'] as Node[]).some((entry) => named(entry, String(receiver['value'])))) continue;
    const call = enclosing(module, callback).find((entry) => entry['type'] === 'CallExpression');
    const callee = call?.['callee'] as Node | undefined;
    if (callee?.['type'] !== 'MemberExpression') continue;
    const role = semanticCollectionRole(module, callee['object'] as Node);
    if (role !== undefined && roles.get(role)?.has(stringValue(node) ?? '')) return true;
  }
  return false;
}

/** A row callback retains the exact protected kind and selected field list of its imported reader. */
function systemRecordProjectionLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  const parents = enclosing(module, node);
  const computed = parents[0];
  const member = parents[1];
  if (computed?.['type'] !== 'Computed' || member?.['type'] !== 'MemberExpression') return false;
  const receiver = member['object'] as Node;
  if (receiver['type'] !== 'Identifier') return false;
  const callback = parents.find((entry) => entry['type'] === 'ArrowFunctionExpression');
  if (callback === undefined) return false;
  const values = nodesOf(callback).find((entry) => entry['type'] === 'VariableDeclarator' && named(entry['id'], String(receiver['value'])));
  const projection = values?.['init'] as Node | undefined;
  if (projection?.['type'] !== 'MemberExpression' || !named(projection['property'], 'values')) return false;
  const row = projection['object'] as Node;
  const params = callback['params'] as Node[];
  if (!params.some((entry) => named(entry, String(row['value'])))) return false;
  const callbackCall = enclosing(module, callback).find((entry) => entry['type'] === 'CallExpression');
  const operation = callbackCall?.['callee'] as Node | undefined;
  if (operation?.['type'] !== 'MemberExpression' || !['map','flatMap'].some((name) => named(operation['property'], name))) return false;
  const collection = operation['object'] as Node;
  const declaration = nodesOf(module.tree).find((entry) => entry['type'] === 'VariableDeclarator' && named(entry['id'], String(collection['value'])));
  const awaited = declaration?.['init'] as Node | undefined;
  const call = awaited?.['type'] === 'AwaitExpression' ? awaited['argument'] as Node : awaited;
  if (call?.['type'] !== 'CallExpression' || !named(call['callee'], 'readKindAssertions')) return false;
  const imported = nodesOf(module.tree).some((entry) => entry['type'] === 'ImportDeclaration' && resolve('/', module.file, '..', stringValue(entry['source'] as Node) ?? '') === '/src/graph/records.js'
    && nodesOf(entry).some((specifier) => specifier['type'] === 'ImportSpecifier' && named(specifier['local'], 'readKindAssertions')));
  if (!imported) return false;
  const args = call['arguments'] as { expression: Node }[];
  const kind = args[2]?.expression;
  const fields = args[3]?.expression;
  if (kind === undefined || fields?.['type'] !== 'ArrayExpression') return false;
  const field = stringValue(node);
  return field !== undefined && (systemFields(modules).get(stringValue(kind) ?? '')?.has(field) ?? false)
    && (fields['elements'] as { expression: Node }[]).some((entry) => stringValue(entry.expression) === field);
}

function systemEdgeRelationLiteral(module: GateModule, node: Node): boolean {
  if (module.file !== 'src/graph/system-contract.ts') return false;
  const parents = enclosing(module, node);
  const declaration = parents.find((entry) => entry['type'] === 'FunctionDeclaration' && named(entry['identifier'], 'SYSTEM_EDGE_DEFINITIONS'));
  if (declaration === undefined || !enclosing(module, declaration).some((entry) => entry['type'] === 'ExportDeclaration')) return false;
  const array = parents[0];
  if (array?.['type'] !== 'ArrayExpression') return false;
  const member = parents[1];
  const call = parents[2];
  if (member?.['type'] !== 'MemberExpression' || !named(member['property'], 'map') || call?.['type'] !== 'CallExpression') return false;
  return nodesOf(call).some((entry) => entry['type'] === 'TemplateElement' && (entry['cooked'] === 'system.assertion-' || entry['raw'] === 'system.assertion-'))
    && nodesOf(declaration).some((entry) => entry['type'] === 'TsTypeReference' && named(entry['typeName'], 'EdgeContract'));
}

/** Fixed GraphQL assertion envelopes are engine declarations, not product field selections. */
function assertionSchemaLiteral(module: GateModule, node: Node): boolean {
  if (module.file !== 'src/graphql/schema.ts') return false;
  const parents = enclosing(module, node);
  const property = parents[0];
  if (property?.['type'] !== 'KeyValueProperty' || !named(property['key'], 'name')) return false;
  const declaration = parents.find((entry) => entry['type'] === 'VariableDeclarator'
    && (named(entry['id'], 'ASSERTION_SCHEMA_TYPES') || named(entry['id'], 'ASSERTION_SCHEMA_SELECTORS')));
  if (declaration === undefined || !enclosing(module, declaration).some((entry) => entry['type'] === 'ExportDeclaration')) return false;
  const annotation = ((declaration['id'] as Node)['typeAnnotation'] as Node | undefined)?.['typeAnnotation'];
  const expected = named(declaration['id'], 'ASSERTION_SCHEMA_TYPES') ? 'TypeDef' : 'ArgumentDef';
  if (annotation === undefined || !nodesOf(annotation as Node).some((entry) => entry['type'] === 'TsTypeReference' && named(entry['typeName'], expected))) return false;
  const object = parents[1];
  if (object?.['type'] !== 'ObjectExpression') return false;
  return (object['properties'] as Node[]).some((entry) => entry['type'] === 'KeyValueProperty' && named(entry['key'], 'type'));
}

/** Read the exact protected field registry, never a union of names exempted across the engine. */
function systemFields(modules: Map<string, GateModule>): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const authority = modules.get('src/graph/system-contract.ts');
  if (authority === undefined) return result;
  const declaration = nodesOf(authority.tree).find((entry) => entry['type'] === 'VariableDeclarator' && named(entry['id'], 'SYSTEM_VERTEX_DEFINITIONS')
    && enclosing(authority, entry).some((parent) => parent['type'] === 'ExportDeclaration'));
  const array = declaration?.['init'] as Node | undefined;
  if (array?.['type'] !== 'ArrayExpression') return result;
  for (const item of array['elements'] as { expression: Node }[]) {
    const properties = item.expression['properties'] as Node[] | undefined;
    const kind = properties?.find((entry) => named(entry['key'], 'name'))?.['value'] as Node | undefined;
    const fields = properties?.find((entry) => named(entry['key'], 'fields'))?.['value'] as Node | undefined;
    if (kind === undefined || fields?.['type'] !== 'ArrayExpression') continue;
    const kindName = stringValue(kind) ?? (kind['type'] === 'Identifier' ? (() => {
      const constant = nodesOf(authority.tree).find((entry) => entry['type'] === 'VariableDeclarator' && named(entry['id'], String(kind['value']))
        && enclosing(authority, entry).some((parent) => parent['type'] === 'ExportDeclaration'));
      return constant?.['init'] === undefined ? undefined : stringValue(constant['init'] as Node);
    })() : undefined);
    if (kindName === undefined) continue;
    result.set(kindName, new Set((fields['elements'] as { expression: Node }[]).flatMap((element) => {
      const field = (element.expression['properties'] as Node[] | undefined)?.find((entry) => named(entry['key'], 'name'))?.['value'] as Node | undefined;
      const value = field === undefined ? undefined : stringValue(field);
      return value === undefined ? [] : [value];
    })));
  }
  const generated = nodesOf(authority.tree).find(entry => entry['type'] === 'VariableDeclarator' && named(entry['id'], 'SYSTEM_CONTRACT')
    && enclosing(authority, entry).some(parent => parent['type'] === 'ExportDeclaration'));
  for (const call of generated === undefined ? [] : nodesOf(generated).filter(entry => entry['type'] === 'CallExpression')) {
    const callee = call['callee'] as Node;
    const mapper = (call['arguments'] as { expression: Node }[])[0]?.expression;
    if (callee['type'] !== 'MemberExpression' || !named(callee['property'], 'map') || mapper?.['type'] !== 'Identifier') continue;
    const collection = callee['object'] as Node;
    const kinds = nodesOf(authority.tree).find(entry => entry['type'] === 'VariableDeclarator' && named(entry['id'], String(collection['value']))
      && (entry['id'] as Node)['ctxt'] === collection['ctxt']);
    const mapping = nodesOf(authority.tree).find(entry => entry['type'] === 'FunctionDeclaration' && named(entry['identifier'], String(mapper['value']))
      && (entry['identifier'] as Node)['ctxt'] === mapper['ctxt']);
    const returned = mapping === undefined ? undefined : nodesOf(mapping).find(entry => entry['type'] === 'ReturnStatement');
    const object = returned?.['argument'] as Node | undefined;
    const parameter = ((mapping?.['params'] as Node[] | undefined)?.[0]?.['pat']) as Node | undefined;
    const properties = object?.['properties'] as Node[] | undefined;
    if (object?.['type'] !== 'ObjectExpression' || !properties?.some(entry => entry['type'] === 'Identifier' && named(entry, String(parameter?.['value'])))
      || !properties.some(entry => named(entry['key'], 'capability') && stringValue(entry['value'] as Node) === 'system')) continue;
    const fields = properties.find(entry => named(entry['key'], 'fields'))?.['value'] as Node | undefined;
    if (fields?.['type'] !== 'ArrayExpression') continue;
    const slots = new Set(nodesOf(fields).filter(entry => entry['type'] === 'KeyValueProperty' && named(entry['key'], 'name'))
      .map(entry => stringValue(entry['value'] as Node)).filter((name): name is string => name !== undefined));
    const values = kinds?.['init'] as Node | undefined;
    if (values?.['type'] !== 'TsConstAssertion' && values?.['type'] !== 'TsAsExpression') continue;
    const array = values['expression'] as Node;
    if (array['type'] !== 'ArrayExpression') continue;
    for (const element of array['elements'] as { expression: Node }[]) {
      const name = stringValue(element.expression);
      if (name !== undefined) result.set(name, slots);
    }
  }
  return result;
}

/** Registry declarations and typed storage readers may name only the field of the exact protected kind. */
function systemFieldLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  const parents = enclosing(module, node);
  if (module.file === 'src/graph/system-contract.ts') {
    const declaration = parents.find((entry) => entry['type'] === 'VariableDeclarator' && named(entry['id'], 'SYSTEM_VERTEX_DEFINITIONS'));
    if (declaration !== undefined && enclosing(module, declaration).some((entry) => entry['type'] === 'ExportDeclaration')) {
      const key = parents[0];
      if (key?.['type'] === 'KeyValueProperty' && named(key['key'], 'name')
        && parents.some((entry) => entry['type'] === 'KeyValueProperty' && named(entry['key'], 'fields'))) return true;
      const keyProperty = parents.find((entry) => entry['type'] === 'KeyValueProperty' && named(entry['key'], 'key'));
      const evidenceField = parents[0]?.['type'] === 'KeyValueProperty' && ['digestField', 'contentField'].some((name) => named(parents[0]!['key'], name))
        ? parents.find((entry) => entry['type'] === 'KeyValueProperty' && named(entry['key'], 'evidence')) : undefined;
      const authorityProperty = keyProperty ?? evidenceField;
      const entry = authorityProperty === undefined ? undefined : enclosing(module, authorityProperty)[0];
      if (entry?.['type'] !== 'ObjectExpression') return false;
      const properties = entry['properties'] as Node[];
      const kind = properties.find((property) => named(property['key'], 'name'))?.['value'] as Node | undefined;
      return kind !== undefined && (systemFields(modules).get(stringValue(kind) ?? '')?.has(stringValue(node) ?? '') ?? false);
    }
  }
  const array = parents[0];
  const readerCall = parents[1];
  const readerName = named(readerCall?.['callee'], 'readKindAssertions') ? 'readKindAssertions'
    : named(readerCall?.['callee'], 'loadAssertions') ? 'loadAssertions' : undefined;
  if (array?.['type'] === 'ArrayExpression' && readerCall?.['type'] === 'CallExpression' && readerName !== undefined) {
    const args = readerCall['arguments'] as { expression: Node }[];
    const authority = readerName === 'loadAssertions' ? '/src/graph/assertion-read.js' : '/src/graph/records.js';
    const imported = nodesOf(module.tree).some((entry) => entry['type'] === 'ImportDeclaration' && resolve('/', module.file, '..', stringValue(entry['source'] as Node) ?? '') === authority && nodesOf(entry).some((specifier) => specifier['type'] === 'ImportSpecifier' && named(specifier['local'], readerName)));
    const kind = args[2]?.expression;
    return imported && args[3]?.expression === array && kind !== undefined
      && (systemFields(modules).get(stringValue(kind) ?? '')?.has(stringValue(node) ?? '') ?? false);
  }
  if (module.file !== 'src/graph/operation-host.ts') return false;
  const call = parents[0];
  if (call?.['type'] !== 'CallExpression') return false;
  const name = (call['callee'] as Node | undefined)?.['value'];
  const kindIndex = name === 'selected' ? 1 : name === 'set' ? 2 : undefined;
  if (kindIndex === undefined) return false;
  const args = call['arguments'] as { expression: Node }[];
  if (args[kindIndex + 2]?.expression !== node) return false;
  const kind = args[kindIndex]?.expression;
  const value = stringValue(node);
  if (kind === undefined || value === undefined) return false;
  const authority = systemFields(modules);
  if (!authority.get(stringValue(kind) ?? '')?.has(value)) return false;
  const declaration = nodesOf(module.tree).find((entry) => entry['type'] === 'FunctionDeclaration' && named(entry['identifier'], String(name)));
  if (declaration === undefined) return false;
  // The helper is the storage adapter, not an arbitrary same-named local function.
  return nodesOf(declaration).some((entry) => entry['type'] === 'CallExpression'
    && named(entry['callee'], name === 'selected' ? 'loadAssertions' : 'writeAssertion'));
}

/** The protected contract's declarations are vocabulary only if they feed its typed vertex registry. */
function protectedContractLiteral(module: GateModule, node: Node): boolean {
  if (module.file !== 'src/graph/system-contract.ts') return false;
  const all = nodesOf(module.tree);
  const contract = all.find(entry => entry['type'] === 'VariableDeclarator' && named(entry['id'], 'SYSTEM_CONTRACT')
    && nodesOf(entry['id'] as Node).some(type => type['type'] === 'TsTypeReference' && named(type['typeName'], 'GraphContract'))
    && enclosing(module, entry).some(parent => parent['type'] === 'ExportDeclaration'));
  if (contract === undefined) return false;
  const parents = enclosing(module, node);
  const field = parents[0];
  if (field?.['type'] === 'KeyValueProperty' && named(field['key'], 'name') && parents.includes(contract)) return true;
  const list = parents.find(entry => entry['type'] === 'VariableDeclarator'
    && ['OPERATIONAL_KINDS', 'IDENTITY_KINDS'].some(name => named(entry['id'], name)));
  if (list !== undefined && parents[0]?.['type'] === 'ArrayExpression') return nodesOf(contract).some(entry => entry['type'] === 'MemberExpression'
    && named(entry['object'], String((list['id'] as Node)['value'])));
  const identity = parents.find(entry => entry['type'] === 'FunctionDeclaration' && named(entry['identifier'], 'identityKind'));
  return identity !== undefined && field?.['type'] === 'KeyValueProperty' && named(field['key'], 'name')
    && nodesOf(identity['returnType'] as Node).some(type => type['type'] === 'TsTypeReference' && named(type['typeName'], 'VertexContract'))
    && nodesOf(contract).some(entry => entry['type'] === 'CallExpression' && (entry['arguments'] as { expression: Node }[]).some(arg => named(arg.expression, 'identityKind')));
}

/** Comparisons against an explicitly typed engine parameter keep that declaration's vocabulary. */
function typedEngineComparisonLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  const parents = enclosing(module, node);
  const comparison = parents[0];
  const switchNode = comparison?.['type'] === 'SwitchCase' && comparison['test'] === node ? parents[1] : undefined;
  if (switchNode?.['type'] !== 'SwitchStatement' && (comparison?.['type'] !== 'BinaryExpression' || !['===', '!=='].includes(String(comparison['operator'])))) return false;
  const other = switchNode?.['type'] === 'SwitchStatement' ? switchNode['discriminant'] as Node : (comparison!['left'] === node ? comparison!['right'] : comparison!['left']) as Node;
  const cases = [
    { file: 'src/sql-driver.ts', type: 'SqlTransactionKind', property: undefined },
    { file: 'src/graph/contract.ts', type: 'FieldContract', property: 'type' },
    { file: 'src/graph/contract.ts', type: 'FieldType', property: undefined },
    { file: 'src/graph/evidence-targets.ts', type: 'EvidenceLocatorDraft', property: 'type' },
  ];
  for (const expected of cases) {
    const receiver = expected.property === undefined ? other : other['type'] === 'MemberExpression' && named(other['property'], expected.property) ? other['object'] as Node : undefined;
    if (receiver?.['type'] !== 'Identifier') continue;
    const imported = module.file === expected.file || nodesOf(module.tree).some(entry => entry['type'] === 'ImportDeclaration'
      && resolve('/', module.file, '..', stringValue(entry['source'] as Node) ?? '') === `/${expected.file.slice(0, -3)}.js`
      && nodesOf(entry).some(specifier => specifier['type'] === 'ImportSpecifier' && named(specifier['local'], expected.type)));
    if (!imported) continue;
    const scope = parents.find(entry => ['FunctionDeclaration', 'ClassMethod', 'ArrowFunctionExpression', 'FunctionExpression'].includes(String(entry['type'])));
    const parameters = scope === undefined ? undefined : ((scope['function'] ?? scope) as Node)['params'] as Node[] | undefined;
    if (parameters === undefined || !parameters.flatMap(parameter => nodesOf(parameter)).some(entry => entry['type'] === 'Identifier'
      && named(entry, String(receiver['value'])) && entry['ctxt'] === receiver['ctxt']
      && entry['typeAnnotation'] !== undefined && nodesOf(entry['typeAnnotation'] as Node).some(type => type['type'] === 'TsTypeReference' && named(type['typeName'], expected.type)))) continue;
    const authority = modules.get(expected.file);
    const declaration = authority === undefined ? undefined : nodesOf(authority.tree).find(entry => ['TsTypeAliasDeclaration', 'TsInterfaceDeclaration'].includes(String(entry['type'])) && named(entry['id'], expected.type));
    if (declaration === undefined) continue;
    if (nodesOf(declaration).some(entry => stringValue(entry) === stringValue(node))) return true;
    // FieldContract's storage type is itself an authoritative alias.
    if (expected.type === 'FieldContract' && authority !== undefined && nodesOf(authority.tree).some(entry => entry['type'] === 'TsTypeAliasDeclaration'
      && named(entry['id'], 'FieldType') && nodesOf(entry).some(literal => stringValue(literal) === stringValue(node)))) return true;
  }
  return false;
}

/** Exact type declarations are vocabulary only at their authoritative engine boundary. */
function engineTypeLiteral(module: GateModule, node: Node): boolean {
  const declarations: Readonly<Record<string, readonly string[]>> = {
    'src/graph/producer-binding.ts': ['ProducerAction'],
    'src/graph/evidence-targets.ts': ['EvidenceLocatorDraft', 'EvidenceTarget'],
    'src/graph/contract.ts': ['FieldType'],
    'src/knowledge/graph-verdict-rules.ts': ['GraphCondition'],
  };
  if (module.file === 'src/loop/plan.ts') {
    const parents = enclosing(module, node);
    if (parents.some(entry => entry['type'] === 'TsInterfaceDeclaration' && named(entry['id'], 'Unplaced')
      && enclosing(module, entry).some(parent => parent['type'] === 'ExportDeclaration'))
      && parents.some(entry => entry['type'] === 'TsPropertySignature' && named(entry['key'], 'kind'))) return true;
  }
  const fieldBoundary = module.file === 'src/graph/value-types.ts' ? ['ValueTypeDeclaration', 'storage']
    : module.file === 'src/plugin-sdk.ts' ? ['FieldDeclaration', 'type'] : undefined;
  if (fieldBoundary !== undefined) {
    const parents = enclosing(module, node);
    return parents.some(entry => entry['type'] === 'TsPropertySignature' && named(entry['key'], fieldBoundary[1]!))
      && parents.some(entry => entry['type'] === 'TsInterfaceDeclaration' && named(entry['id'], fieldBoundary[0]!)
        && enclosing(module, entry).some(parent => parent['type'] === 'ExportDeclaration'));
  }
  if (module.file === 'src/fill/stage.ts') {
    const declaration = enclosing(module, node).find(entry => entry['type'] === 'TsTypeAliasDeclaration' && named(entry['id'], 'CapabilityScope'));
    if (declaration !== undefined) return nodesOf(module.tree).some(entry => entry['type'] === 'TsInterfaceDeclaration'
      && ['StageConsumes', 'StageProduces'].some(name => named(entry['id'], name))
      && nodesOf(entry).some(property => property['type'] === 'TsPropertySignature' && named(property['key'], 'scope')
        && nodesOf(property).some(type => type['type'] === 'TsTypeReference' && named(type['typeName'], 'CapabilityScope'))));
  }
  const names = declarations[module.file];
  return names !== undefined && enclosing(module, node).some(entry => entry['type'] === 'TsTypeAliasDeclaration'
    && names.some(name => named(entry['id'], name))
    && enclosing(module, entry).some(parent => parent['type'] === 'ExportDeclaration'));
}

/** Database transaction modes are checked against their imported owner and exact argument slot. */
function ownerTransactionLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  const authority = modules.get('src/sql-driver.ts');
  const modes = authority === undefined ? undefined : nodesOf(authority.tree).find(entry => entry['type'] === 'TsTypeAliasDeclaration' && named(entry['id'], 'SqlTransactionKind'));
  if (modes === undefined || !nodesOf(modes).some(entry => stringValue(entry) === stringValue(node))) return false;
  const parents = enclosing(module, node);
  const call = parents[0];
  const callee = call?.['callee'] as Node | undefined;
  if (call?.['type'] !== 'CallExpression' || callee?.['type'] !== 'MemberExpression'
    || !named(callee['property'], 'transaction') || (call['arguments'] as { expression: Node }[])[0]?.expression !== node) return false;
  const receiver = callee['object'] as Node;
  const isOwner = (annotation: Node): boolean => nodesOf(annotation).some(entry => entry['type'] === 'TsTypeReference'
    && named(entry['typeName'], 'DatabaseOwner'));
  const imported = nodesOf(module.tree).some(entry => entry['type'] === 'ImportDeclaration'
    && resolve('/', module.file, '..', stringValue(entry['source'] as Node) ?? '') === '/src/adapters/database-owner.js'
    && nodesOf(entry).some(specifier => specifier['type'] === 'ImportSpecifier' && named(specifier['local'], 'DatabaseOwner')));
  if (receiver['type'] === 'ThisExpression') return module.file === 'src/adapters/database-owner.ts'
    && parents.some(entry => entry['type'] === 'ClassDeclaration' && named(entry['identifier'], 'DatabaseOwner'));
  if (!imported || receiver['type'] !== 'Identifier') return false;
  return parents.some(scope => nodesOf(scope).some(entry => entry['type'] === 'Identifier'
    && named(entry, String(receiver['value'])) && entry['ctxt'] === receiver['ctxt']
    && entry['typeAnnotation'] !== undefined && isOwner(entry['typeAnnotation'] as Node)));
}

/** A private reader's conditional field list must match every literal kind its callers supply. */
function conditionalSystemFieldsLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  const parents = enclosing(module, node);
  const array = parents[0];
  const conditional = parents[1];
  if (array?.['type'] !== 'ArrayExpression' || conditional?.['type'] !== 'ConditionalExpression') return false;
  const test = conditional['test'] as Node;
  if (test['type'] !== 'BinaryExpression' || test['operator'] !== '===' || (test['left'] as Node)['type'] !== 'Identifier') return false;
  const kindName = stringValue(test['right'] as Node);
  const declaration = parents.find(entry => entry['type'] === 'FunctionDeclaration');
  const variable = parents.find(entry => entry['type'] === 'VariableDeclarator');
  if (kindName === undefined || declaration === undefined || variable === undefined
    || enclosing(module, declaration).some(entry => entry['type'] === 'ExportDeclaration')) return false;
  const parameter = test['left'] as Node;
  const index = (declaration['params'] as Node[]).findIndex(entry => named(entry['pat'], String(parameter['value'])));
  if (index < 0) return false;
  const reader = nodesOf(declaration).find(entry => entry['type'] === 'CallExpression' && named(entry['callee'], 'loadAssertions')
    && named((entry['arguments'] as { expression: Node }[])[2]?.expression, String(parameter['value']))
    && named((entry['arguments'] as { expression: Node }[])[3]?.expression, String((variable['id'] as Node)['value'])));
  if (reader === undefined || !nodesOf(module.tree).some(entry => entry['type'] === 'ImportDeclaration'
    && resolve('/', module.file, '..', stringValue(entry['source'] as Node) ?? '') === '/src/graph/assertion-read.js'
    && nodesOf(entry).some(specifier => specifier['type'] === 'ImportSpecifier' && named(specifier['local'], 'loadAssertions')))) return false;
  const calls = nodesOf(module.tree).filter(entry => entry['type'] === 'CallExpression' && named(entry['callee'], String((declaration['identifier'] as Node)['value'])));
  if (calls.length === 0) return false;
  const kinds = calls.map(call => stringValue((call['arguments'] as { expression: Node }[])[index]?.expression ?? {}));
  if (kinds.some(kind => kind === undefined || !systemFields(modules).has(kind))) return false;
  const selected = conditional['consequent'] === array ? kinds.filter(kind => kind === kindName) : kinds.filter(kind => kind !== kindName);
  return selected.length > 0 && selected.every(kind => systemFields(modules).get(kind!)?.has(stringValue(node) ?? ''));
}

/** Role names are admitted only as the checked projector's argument or its forwarded closed parameter. */
function semanticRoleArgumentLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  const roles = semanticRoleSlots(modules);
  if (!roles.has(stringValue(node) ?? '')) return false;
  const imported = nodesOf(module.tree).some(entry => entry['type'] === 'ImportDeclaration'
    && resolve('/', module.file, '..', stringValue(entry['source'] as Node) ?? '') === '/src/knowledge/semantic-bindings.js'
    && nodesOf(entry).some(specifier => specifier['type'] === 'ImportSpecifier' && named(specifier['local'], 'semanticEntities')));
  const bindingImport = nodesOf(module.tree).some(entry => entry['type'] === 'ImportDeclaration'
    && resolve('/', module.file, '..', stringValue(entry['source'] as Node) ?? '') === '/src/knowledge/semantic-bindings.js'
    && nodesOf(entry).some(specifier => specifier['type'] === 'ImportSpecifier' && named(specifier['local'], 'semanticBinding')));
  const parents = enclosing(module, node);
  const call = parents[0];
  if (bindingImport && call?.['type'] === 'CallExpression' && named(call['callee'], 'semanticBinding')
    && (call['arguments'] as { expression: Node }[])[1]?.expression === node) {
    const callee = call['callee'] as Node;
    return nodesOf(module.tree).some(entry => entry['type'] === 'ImportDeclaration'
      && resolve('/', module.file, '..', stringValue(entry['source'] as Node) ?? '') === '/src/knowledge/semantic-bindings.js'
      && nodesOf(entry).some(specifier => specifier['type'] === 'ImportSpecifier' && named(specifier['local'], 'semanticBinding')
        && (specifier['local'] as Node)['ctxt'] === callee['ctxt']));
  }
  if (!imported) return false;
  if (call?.['type'] === 'CallExpression' && named(call['callee'], 'semanticEntities')
    && (call['arguments'] as { expression: Node }[])[2]?.expression === node) {
    const callee = call['callee'] as Node;
    return nodesOf(module.tree).some(entry => entry['type'] === 'ImportDeclaration'
      && resolve('/', module.file, '..', stringValue(entry['source'] as Node) ?? '') === '/src/knowledge/semantic-bindings.js'
      && nodesOf(entry).some(specifier => specifier['type'] === 'ImportSpecifier' && named(specifier['local'], 'semanticEntities')
        && (specifier['local'] as Node)['ctxt'] === callee['ctxt']));
  }
  const parameter = parents.find(entry => entry['type'] === 'Parameter');
  const scope = parents.find(entry => entry['type'] === 'FunctionDeclaration');
  if (parameter === undefined || scope === undefined) return false;
  const pattern = parameter['pat'] as Node;
  const binding = pattern['type'] === 'AssignmentPattern' ? pattern['left'] as Node : pattern;
  const annotation = binding['typeAnnotation'] as Node | undefined;
  if (annotation === undefined) return false;
  const literals = nodesOf(annotation).filter(entry => entry['type'] === 'StringLiteral');
  if (literals.length === 0 || literals.some(entry => !roles.has(stringValue(entry) ?? ''))) return false;
  return nodesOf(scope).some(entry => entry['type'] === 'CallExpression' && named(entry['callee'], 'semanticEntities')
    && named((entry['arguments'] as { expression: Node }[])[2]?.expression, String(binding['value'])));
}

/** Indexed type keys must exist on their actual local or imported interface declaration. */
function interfaceMemberTypeLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  const parents = enclosing(module, node);
  const indexed = parents.find(entry => entry['type'] === 'TsIndexedAccessType');
  const pick = parents.find(entry => entry['type'] === 'TsTypeReference' && ['Pick', 'Omit'].some(name => named(entry['typeName'], name)));
  const argumentsOfPick = (pick?.['typeParams'] as Node | undefined)?.['params'] as Node[] | undefined;
  const object = (indexed?.['objectType'] ?? argumentsOfPick?.[0]) as Node | undefined;
  if (object?.['type'] !== 'TsTypeReference' || (object['typeName'] as Node)['type'] !== 'Identifier') return false;
  if (indexed === undefined && (argumentsOfPick?.[1] === undefined || !nodesOf(argumentsOfPick[1]).includes(node))) return false;
  const name = String((object['typeName'] as Node)['value']);
  const allowed = new Map([['OperationRequest', 'src/graph/operation-host.ts'], ['ProblemInput', 'src/loop/views.ts'], ['ReplyMaker', 'src/server/http.ts'], ['Problem', 'src/loop/views.ts'], ['SourceOpinion', 'src/knowledge/anchors.ts'], ['DocumentSection', 'src/knowledge/anchors.ts']]);
  const target = allowed.get(name);
  if (target === undefined) return false;
  const authority = modules.get(target);
  if (authority === undefined) return false;
  const imported = module.file === target || nodesOf(module.tree).some(entry => entry['type'] === 'ImportDeclaration'
    && resolve('/', module.file, '..', stringValue(entry['source'] as Node) ?? '') === `/${target.slice(0, -3)}.js`
    && nodesOf(entry).some(specifier => specifier['type'] === 'ImportSpecifier' && named(specifier['local'], name)));
  return imported && nodesOf(authority.tree).some(entry => entry['type'] === 'TsInterfaceDeclaration' && named(entry['id'], name)
    && enclosing(authority, entry).some(parent => parent['type'] === 'ExportDeclaration')
    && nodesOf(entry).some(property => property['type'] === 'TsPropertySignature' && named(property['key'], stringValue(node) ?? '')));
}

/** A semantic binding lookup shares the checked projector's exact manifest and role. */
function semanticBindingLookupLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  if (!semanticRoleSlots(modules).has(stringValue(node) ?? '')) return false;
  const parents = enclosing(module, node);
  const call = parents[0];
  let callee = call?.['callee'] as Node | undefined;
  if (callee?.['type'] === 'OptionalChainingExpression') callee = callee['base'] as Node;
  if (call?.['type'] !== 'CallExpression' || callee?.['type'] !== 'MemberExpression' || !named(callee['property'], 'get')
    || (call['arguments'] as { expression: Node }[])[0]?.expression !== node) return false;
  let binding = callee['object'] as Node;
  if (binding['type'] === 'OptionalChainingExpression') binding = binding['base'] as Node;
  if (binding['type'] !== 'MemberExpression' || !named(binding['property'], 'semanticBindings')) return false;
  const manifest = binding['object'] as Node;
  const scope = parents.find(entry => entry['type'] === 'FunctionDeclaration');
  if (scope === undefined) return false;
  const imported = nodesOf(module.tree).some(entry => entry['type'] === 'ImportDeclaration'
    && resolve('/', module.file, '..', stringValue(entry['source'] as Node) ?? '') === '/src/knowledge/semantic-bindings.js'
    && nodesOf(entry).some(specifier => specifier['type'] === 'ImportSpecifier' && named(specifier['local'], 'semanticEntities')));
  return imported && nodesOf(scope).some(entry => entry['type'] === 'CallExpression' && named(entry['callee'], 'semanticEntities')
    && named((entry['arguments'] as { expression: Node }[])[1]?.expression, String(manifest['value']))
    && stringValue((entry['arguments'] as { expression: Node }[])[2]?.expression ?? {}) === stringValue(node));
}

/** Document projection keys belong to its typed checked producer boundary, not arbitrary GraphEntity values. */
function documentProjectionLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  if (module.file !== 'src/knowledge/anchors.ts') return false;
  const roles = semanticRoleSlots(modules);
  const all = nodesOf(module.tree);
  const producer = all.find(entry => entry['type'] === 'FunctionDeclaration' && named(entry['identifier'], 'documentOpinions') && entry['body'] != null);
  if (producer === undefined || !all.some(entry => entry['type'] === 'ImportDeclaration'
    && stringValue(entry['source'] as Node) === './semantic-bindings.js'
    && nodesOf(entry).some(specifier => specifier['type'] === 'ImportSpecifier' && named(specifier['local'], 'semanticEntities')))
    || !nodesOf(producer).some(entry => entry['type'] === 'CallExpression' && named(entry['callee'], 'semanticEntities'))) return false;
  const parents = enclosing(module, node);
  const parameter = parents.find(entry => entry['type'] === 'Parameter');
  if (parameter !== undefined && parents.some(entry => entry['type'] === 'FunctionDeclaration' && named(entry['identifier'], 'documentOpinions')))
    return ['document', 'source'].includes(stringValue(node) ?? '') && roles.has(stringValue(node) ?? '');
  const key = stringValue(node) ?? '';
  const property = parents[0]?.['type'] === 'Computed' ? parents[1] : undefined;
  if (property?.['type'] === 'MemberExpression') {
    const receiver = property['object'] as Node;
    if (receiver['type'] === 'MemberExpression' && named(receiver['property'], 'properties')) {
      const scope = parents.find(entry => entry['type'] === 'FunctionDeclaration');
      if (scope === undefined) return false;
      const parameters = scope['params'] as Node[];
      const origin = receiver['object'] as Node;
      const direct = parameters.some(entry => named(entry['pat'], String(origin['value']))
        && (entry['pat'] as Node)['ctxt'] === origin['ctxt']
        && nodesOf(entry).some(type => type['type'] === 'TsTypeReference' && named(type['typeName'], 'DocumentOpinion')));
      const callback = parents.find(entry => entry['type'] === 'ArrowFunctionExpression'
        && (entry['params'] as Node[]).some(parameter => named(parameter, String(origin['value'])) && parameter['ctxt'] === origin['ctxt']));
      const callbackCall = callback === undefined ? undefined : enclosing(module, callback).find(entry => entry['type'] === 'CallExpression');
      const callee = callbackCall?.['callee'] as Node | undefined;
      const collection = callee?.['type'] === 'MemberExpression' ? callee['object'] as Node : undefined;
      const projected = collection !== undefined && parameters.some(entry => named(entry['pat'], String(collection['value']))
        && nodesOf(entry).some(type => type['type'] === 'TsTypeReference' && named(type['typeName'], 'DocumentOpinion')));
      if ((direct || projected) && roles.get('document')?.has(key)) return true;
    }
  }
  const call = parents[0];
  if (!parents.includes(producer) || call?.['type'] !== 'CallExpression' || !named(call['callee'], 'endpoint')) return false;
  const args = call['arguments'] as { expression: Node }[];
  const collection = args[2]?.expression;
  const declaration = all.find(entry => entry['type'] === 'VariableDeclarator' && named(entry['id'], String(collection?.['value'])));
  const roleCall = declaration === undefined ? undefined : nodesOf(declaration).find(entry => entry['type'] === 'CallExpression' && named(entry['callee'], 'semanticEntities'));
  const role = roleCall === undefined ? undefined : stringValue((roleCall['arguments'] as { expression: Node }[])[2]?.expression ?? {});
  if (role === undefined) return false;
  if (args[3]?.expression === node) return roles.get(role)?.has(key) ?? false;
  return args[1]?.expression === node && ['document','source'].every(name => roles.get(name)?.has(key));
}

/** A runtime key list may select only real members of the exact interface used by its callback. */
function checkedInterfaceKeyListLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  const parents = enclosing(module, node), array = parents[0], member = parents[1], call = parents[2];
  if (array?.['type'] !== 'ArrayExpression' || member?.['type'] !== 'MemberExpression' || !named(member['property'], 'some') || call?.['type'] !== 'CallExpression') return false;
  const callback = (call['arguments'] as { expression: Node }[])[0]?.expression;
  if (callback?.['type'] !== 'ArrowFunctionExpression') return false;
  const parameter = (callback['params'] as Node[])[0];
  const cast = nodesOf(callback).find(entry => entry['type'] === 'TsAsExpression' && named(entry['expression'], String(parameter?.['value']))
    && (entry['typeAnnotation'] as Node)['type'] === 'TsTypeOperator' && (entry['typeAnnotation'] as Node)['op'] === 'keyof');
  const type = ((cast?.['typeAnnotation'] as Node | undefined)?.['typeAnnotation']) as Node | undefined;
  if (type?.['type'] !== 'TsTypeReference' || !named(type['typeName'], 'VertexContract')) return false;
  const authority = modules.get('src/graph/contract.ts');
  const imported = nodesOf(module.tree).some(entry => entry['type'] === 'ImportDeclaration'
    && resolve('/', module.file, '..', stringValue(entry['source'] as Node) ?? '') === '/src/graph/contract.js'
    && nodesOf(entry).some(specifier => specifier['type'] === 'ImportSpecifier' && named(specifier['local'], 'VertexContract')));
  return imported && authority !== undefined && nodesOf(authority.tree).some(entry => entry['type'] === 'TsInterfaceDeclaration' && named(entry['id'], 'VertexContract')
    && nodesOf(entry).some(property => property['type'] === 'TsPropertySignature' && named(property['key'], stringValue(node) ?? '')));
}

/** Metadata vocabulary is declared by the installed manifest contract, not by product kind guesses. */
function manifestContractLiteral(module: GateModule, node: Node): boolean {
  if (module.file !== 'src/graph/manifest-contract.ts') return false;
  const parents = enclosing(module, node);
  const declaration = parents.find(entry => entry['type'] === 'VariableDeclarator' && named(entry['id'], 'WORKFLOW_STAGE'));
  const contract = nodesOf(module.tree).find(entry => entry['type'] === 'VariableDeclarator' && named(entry['id'], 'MANIFEST_CONTRACT')
    && enclosing(module, entry).some(parent => parent['type'] === 'ExportDeclaration')
    && nodesOf(entry['id'] as Node).some(type => type['type'] === 'TsTypeReference' && named(type['typeName'], 'GraphContract')));
  if (declaration === undefined || contract === undefined || !nodesOf(declaration['id'] as Node).some(type => type['type'] === 'TsTypeReference' && named(type['typeName'], 'VertexContract'))
    || !nodesOf(contract).some(entry => named(entry, 'WORKFLOW_STAGE'))) return false;
  if (parents[0]?.['type'] === 'KeyValueProperty' && named(parents[0]['key'], 'name')) return true;
  const call = parents[0];
  return call?.['type'] === 'CallExpression' && named(call['callee'], 'generatedTableName')
    && (call['arguments'] as { expression: Node }[])[0]?.expression === node;
}

/** A loop result discriminator is valid only in pushes to its explicitly typed result collection. */
function loopResultLiteral(module: GateModule, node: Node): boolean {
  if (module.file !== 'src/loop/plan.ts') return false;
  const parents = enclosing(module, node), property = parents[0], object = parents[1], call = parents[2];
  if (property?.['type'] !== 'KeyValueProperty' || !named(property['key'], 'kind') || object?.['type'] !== 'ObjectExpression'
    || call?.['type'] !== 'CallExpression') return false;
  const callee = call['callee'] as Node;
  if (callee['type'] !== 'MemberExpression' || !named(callee['property'], 'push')) return false;
  const receiver = callee['object'] as Node;
  const declaration = nodesOf(module.tree).find(entry => entry['type'] === 'VariableDeclarator' && named(entry['id'], String(receiver['value']))
    && (entry['id'] as Node)['ctxt'] === receiver['ctxt']);
  if (declaration === undefined || !nodesOf(declaration['id'] as Node).some(entry => entry['type'] === 'TsTypeReference' && named(entry['typeName'], 'Unplaced'))) return false;
  const contract = nodesOf(module.tree).find(entry => entry['type'] === 'TsInterfaceDeclaration' && named(entry['id'], 'Unplaced')
    && enclosing(module, entry).some(parent => parent['type'] === 'ExportDeclaration'));
  const slot = contract === undefined ? undefined : nodesOf(contract).find(entry => entry['type'] === 'TsPropertySignature' && named(entry['key'], 'kind'));
  return slot !== undefined && nodesOf(slot).some(entry => entry['type'] === 'StringLiteral' && stringValue(entry) === stringValue(node));
}

/** Trigger targets come from the same storage schema's CREATE TABLE declarations. */
function graphSchemaTableLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  const parents = enclosing(module, node);
  const loop = parents.find(entry => entry['type'] === 'ForOfStatement');
  if (TABLE_SOURCES.includes(module.file) && loop !== undefined) {
    if (parents[0]?.['type'] !== 'ArrayExpression' || loop?.['right'] !== parents[0]) return false;
    const variable = nodesOf(loop['left'] as Node).find(entry => entry['type'] === 'VariableDeclarator');
    const binding = variable?.['id'] as Node | undefined;
    if (binding?.['type'] !== 'Identifier') return false;
    const trigger = nodesOf(loop['body'] as Node).some(entry => {
      if (entry['type'] !== 'TemplateLiteral') return false;
      const quasis = entry['quasis'] as Node[];
      return (entry['expressions'] as Node[]).some((expression, index) => {
        const prefix = quasis.slice(0, index + 1).map(quasi => String(quasi['cooked'])).join('${expression}');
        const target = /CREATE\s+(?:OR\s+REPLACE\s+|CONSTRAINT\s+)?TRIGGER\s+\S+\s+(?:BEFORE|AFTER|INSTEAD\s+OF)\s+(?:INSERT|UPDATE(?:\s+OF\s+[\w,\s]+)?|DELETE|TRUNCATE)(?:\s+OR\s+(?:INSERT|UPDATE|DELETE|TRUNCATE))*\s+ON\s+("?)$/u.exec(prefix);
        return target !== null && new RegExp(`^${target[1]}\\s`, 'u').test(String(quasis[index + 1]?.['cooked']))
          && named(expression, String(binding['value'])) && expression['ctxt'] === binding['ctxt'];
      });
    });
    const definition = modules.get('src/adapters/schemas/graph-definition.ts');
    const schema = definition === undefined ? undefined : nodesOf(definition.tree).find(entry => entry['type'] === 'VariableDeclarator' && named(entry['id'], 'SCHEMA')
      && enclosing(definition, entry).some(parent => parent['type'] === 'ExportDeclaration'));
    return trigger && schema !== undefined && nodesOf(schema).some(entry => entry['type'] === 'TemplateElement'
      && [...String(entry['cooked']).matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(/gu)].some(match => match[1] === stringValue(node)));
  }
  if (module.file !== 'src/adapters/schemas/graph-definition.ts') return false;
  const array = parents[0], member = parents[1], call = parents[2];
  if (array?.['type'] !== 'ArrayExpression' || member?.['type'] !== 'MemberExpression' || !named(member['property'], 'map') || call?.['type'] !== 'CallExpression') return false;
  const schema = parents.find(entry => entry['type'] === 'VariableDeclarator' && named(entry['id'], 'SCHEMA')
    && enclosing(module, entry).some(parent => parent['type'] === 'ExportDeclaration'));
  if (schema === undefined) return false;
  const callback = (call['arguments'] as { expression: Node }[])[0]?.expression;
  if (callback?.['type'] !== 'ArrowFunctionExpression') return false;
  const parameter = (callback['params'] as Node[])[0];
  const templates = nodesOf(callback).filter(entry => entry['type'] === 'TemplateLiteral');
  const trigger = templates.some(entry => /CREATE OR REPLACE TRIGGER immutable BEFORE UPDATE OR DELETE ON $/u.test(String((entry['quasis'] as Node[])[0]?.['cooked']))
    && named((entry['expressions'] as Node[])[0], String(parameter?.['value'])));
  const table = stringValue(node);
  return trigger && table !== undefined && nodesOf(schema).some(entry => entry['type'] === 'TemplateElement'
    && [...String(entry['cooked']).matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(/gu)].some(match => match[1] === table));
}

/** Trace phase names describe the operation actually executed by the enclosing span callback. */
function tracePhaseLiteral(module: GateModule, node: Node): boolean {
  const parents = enclosing(module, node), property = parents[0], object = parents[1], call = parents[2];
  if (property?.['type'] !== 'KeyValueProperty' || stringValue(property['key'] as Node) !== 'madarch.phase'
    || object?.['type'] !== 'ObjectExpression' || call?.['type'] !== 'CallExpression' || !named(call['callee'], 'withSpan')) return false;
  const args = call['arguments'] as { expression: Node }[];
  if (args[1]?.expression !== object) return false;
  const imported = nodesOf(module.tree).some(entry => entry['type'] === 'ImportDeclaration'
    && resolve('/', module.file, '..', stringValue(entry['source'] as Node) ?? '') === '/src/obs/trace.js'
    && nodesOf(entry).some(specifier => specifier['type'] === 'ImportSpecifier' && named(specifier['local'], 'withSpan')
      && (specifier['local'] as Node)['ctxt'] === (call['callee'] as Node)['ctxt']));
  const callback = args[2]?.expression;
  return imported && callback?.['type'] === 'ArrowFunctionExpression'
    && nodesOf(callback).some(entry => entry['type'] === 'CallExpression' && (entry['callee'] as Node)['type'] === 'MemberExpression'
      && named((entry['callee'] as Node)['property'], stringValue(node) ?? ''));
}

/** GraphQL argument reads use the schema's declared selectors and the resolver's argument binding. */
function graphSelectorArgumentLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  const authority = modules.get('src/graphql/schema.ts');
  if (authority === undefined) return false;
  const selectors = nodesOf(authority.tree).find(entry => entry['type'] === 'VariableDeclarator' && named(entry['id'], 'ASSERTION_SCHEMA_SELECTORS')
    && enclosing(authority, entry).some(parent => parent['type'] === 'ExportDeclaration'));
  if (selectors === undefined || !nodesOf(selectors).some(entry => entry['type'] === 'KeyValueProperty' && named(entry['key'], 'name') && stringValue(entry['value'] as Node) === stringValue(node))) return false;
  const parents = enclosing(module, node), computed = parents[0], member = parents[1];
  if (computed?.['type'] !== 'Computed' || member?.['type'] !== 'MemberExpression') return false;
  const receiver = member['object'] as Node;
  const callback = parents.find(entry => entry['type'] === 'ArrowFunctionExpression'
    && named((entry['params'] as Node[])[1], String(receiver['value']))
    && ((entry['params'] as Node[])[1])?.['ctxt'] === receiver['ctxt']);
  if (callback === undefined) return false;
  const property = enclosing(module, callback).find(entry => entry['type'] === 'ClassProperty');
  if (property === undefined || property['value'] !== callback) return false;
  const type = ((property['typeAnnotation'] as Node | undefined)?.['typeAnnotation']) as Node | undefined;
  if (type?.['type'] !== 'TsTypeReference' || !named(type['typeName'], 'GraphQLFieldResolver')) return false;
  return nodesOf(module.tree).some(entry => entry['type'] === 'ImportDeclaration' && stringValue(entry['source'] as Node) === 'graphql'
    && nodesOf(entry).some(specifier => specifier['type'] === 'ImportSpecifier' && named(specifier['local'], 'GraphQLFieldResolver')
      && (specifier['local'] as Node)['ctxt'] === (type['typeName'] as Node)['ctxt']));
}

/** MCP argument names must exist in the published tool schema and pass their declared validator. */
function checkedMcpArgumentLiteral(module: GateModule, node: Node): boolean {
  if (module.file !== 'src/mcp/authored.ts') return false;
  const parents = enclosing(module, node), computed = parents[0];
  const name = stringValue(node);
  const scope = parents.find(entry => entry['type'] === 'FunctionDeclaration');
  if (scope === undefined) return false;
  const diagnostic = computed?.['type'] === 'NewExpression' && named(computed['callee'], 'WriteRefusal')
    && (computed['arguments'] as { expression: Node }[])[1]?.expression === node;
  const variable = diagnostic ? nodesOf(scope).find(entry => entry['type'] === 'VariableDeclarator'
    && (entry['init'] as Node | null)?.['type'] === 'MemberExpression'
    && ((entry['init'] as Node)['property'] as Node)['type'] === 'Computed'
    && stringValue((((entry['init'] as Node)['property'] as Node)['expression']) as Node) === name) : parents[2];
  const access = diagnostic ? variable?.['init'] as Node | undefined : parents[1];
  if ((!diagnostic && computed?.['type'] !== 'Computed') || access?.['type'] !== 'MemberExpression'
    || variable?.['type'] !== 'VariableDeclarator' || variable['init'] !== access) return false;
  const receiver = access['object'] as Node;
  const tools = nodesOf(module.tree).find(entry => entry['type'] === 'VariableDeclarator' && named(entry['id'], 'PRODUCT_TOOLS')
    && enclosing(module, entry).some(parent => parent['type'] === 'ExportDeclaration'));
  if (tools === undefined) return false;
  const declarations: Node[] = [tools];
  for (let index = 0; index < declarations.length; index += 1) {
    const references = nodesOf(declarations[index]!).filter(entry => entry['type'] === 'ArrayExpression')
      .flatMap(array => (array['elements'] as { spread?: unknown; expression: Node }[]).filter(element => element.spread != null).map(element => element.expression));
    for (const reference of references) {
      if (reference?.['type'] !== 'Identifier') continue;
      const declaration = nodesOf(module.tree).find(entry => entry['type'] === 'VariableDeclarator' && named(entry['id'], String(reference['value']))
        && (entry['id'] as Node)['ctxt'] === reference['ctxt']);
      if (declaration !== undefined && !declarations.includes(declaration)) declarations.push(declaration);
    }
  }
  const property = declarations.flatMap(declaration => nodesOf(declaration)).find(entry => entry['type'] === 'KeyValueProperty' && named(entry['key'], name ?? ''));
  let schema = property?.['value'] as Node | undefined;
  if (schema?.['type'] === 'CallExpression') {
    const callee = schema['callee'] as Node;
    if (callee['type'] !== 'MemberExpression' || !named(callee['object'], 'Type') || !named(callee['property'], 'Optional')
      || !nodesOf(module.tree).some(entry => entry['type'] === 'ImportDeclaration' && stringValue(entry['source'] as Node) === 'typebox'
        && nodesOf(entry).some(specifier => specifier['type'] === 'ImportSpecifier' && named(specifier['local'], 'Type')
          && (specifier['local'] as Node)['ctxt'] === (callee['object'] as Node)['ctxt']))) return false;
    schema = (schema['arguments'] as { expression: Node }[])[0]?.expression;
  }
  if (schema?.['type'] !== 'Identifier') return false;

  const args = nodesOf(scope).find(entry => entry['type'] === 'VariableDeclarator' && named(entry['id'], String(receiver['value']))
    && (entry['id'] as Node)['ctxt'] === receiver['ctxt']);
  if (args === undefined || !nodesOf(args).some(entry => entry['type'] === 'TsAsExpression')) return false;
  return nodesOf(scope).some(entry => entry['type'] === 'CallExpression' && (entry['callee'] as Node)['type'] === 'MemberExpression'
    && named((entry['callee'] as Node)['object'], 'Value') && named((entry['callee'] as Node)['property'], 'Check')
    && named((entry['arguments'] as { expression: Node }[])[0]?.expression, String(schema['value']))
    && named((entry['arguments'] as { expression: Node }[])[1]?.expression, String((variable['id'] as Node)['value'])));
}

/** A bound semantic slot comes only from the checked binding function and that role's schema. */
function checkedBindingSlotLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  const parents = enclosing(module, node);
  if (parents[0]?.['type'] !== 'Computed' || parents[1]?.['type'] !== 'MemberExpression') return false;
  let object = (parents[1] as Node)['object'] as Node;
  const path: string[] = [stringValue(node) ?? ''];
  while (object['type'] === 'OptionalChainingExpression' || object['type'] === 'MemberExpression') {
    if (object['type'] === 'OptionalChainingExpression') { object = object['base'] as Node; continue; }
    const property = object['property'] as Node;
    const name = property['type'] === 'Computed' ? stringValue(property['expression'] as Node) : String(property['value']);
    if (name === undefined) return false;
    path.unshift(name);
    object = object['object'] as Node;
  }
  if (object['type'] !== 'Identifier') return false;
  const declaration = nodesOf(module.tree).find(entry => entry['type'] === 'VariableDeclarator' && named(entry['id'], String(object['value']))
    && (entry['id'] as Node)['ctxt'] === object['ctxt']);
  const call = declaration?.['init'] as Node | undefined;
  if (call?.['type'] !== 'CallExpression') return false;
  const callee = call['callee'] as Node;
  if (!nodesOf(module.tree).some(entry => entry['type'] === 'ImportDeclaration'
    && resolve('/', module.file, '..', stringValue(entry['source'] as Node) ?? '') === '/src/knowledge/semantic-bindings.js'
    && nodesOf(entry).some(specifier => specifier['type'] === 'ImportSpecifier' && named(specifier['imported'] ?? specifier['local'], 'semanticBinding')
      && (specifier['local'] as Node)['ctxt'] === callee['ctxt'] && named(specifier['local'], String(callee['value']))))) return false;
  const role = stringValue((call['arguments'] as { expression: Node }[])[1]?.expression ?? {});
  if (role === undefined || !['fields', 'edges', 'values'].includes(path[0] ?? '')) return false;
  if (!(semanticRoleSlots(modules).get(role)?.has(path[1] ?? '') ?? false)) return false;
  const protocol = modules.get('src/model/semantic-role-protocol.ts');
  if (protocol === undefined) return false;
  const roleObject = nodesOf(protocol.tree).find(entry => entry['type'] === 'ObjectExpression'
    && (entry['properties'] as Node[]).some(property => named(property['key'], 'role')
      && stringValue((((property['value'] as Node)['arguments'] as { expression: Node }[] | undefined)?.[0]?.expression) ?? {}) === role));
  const properties = (roleObject?.['properties'] as Node[] | undefined)?.find(entry => named(entry['key'], 'properties'));
  const slot = nodesOf((properties?.['value'] as Node | undefined) ?? {}).find(entry => entry['type'] === 'KeyValueProperty' && named(entry['key'], path[1] ?? ''));
  if (slot === undefined) return false;
  const edge = nodesOf(slot).some(entry => entry['type'] === 'KeyValueProperty' && stringValue(entry['key'] as Node) === 'x-semantic-edge'
    && (entry['value'] as Node)['type'] === 'BooleanLiteral' && (entry['value'] as Node)['value'] === true);
  return path.length === 2 && (path[0] === 'edges' ? edge : !edge);
}

/** The receipt key is an operation namespace only at the checked host request boundary. */
function operationReceiptKeyLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  const authority = modules.get('src/graph/operation-host.ts');
  if (authority === undefined) return false;
  const contract = nodesOf(authority.tree).find(entry => entry['type'] === 'TsInterfaceDeclaration' && named(entry['id'], 'OperationRequest')
    && enclosing(authority, entry).some(parent => parent['type'] === 'ExportDeclaration'));
  if (contract === undefined || !nodesOf(contract).some(entry => entry['type'] === 'TsPropertySignature' && named(entry['key'], 'key'))) return false;
  if (!nodesOf(authority.tree).some(entry => entry['type'] === 'CallExpression' && named(entry['callee'], 'operationReceipt')
    && ((entry['arguments'] as { expression: Node }[])[3]?.expression)?.['type'] === 'MemberExpression'
    && named((((entry['arguments'] as { expression: Node }[])[3]?.expression) as Node)['property'], 'key'))) return false;
  const parents = enclosing(module, node), property = parents[0];
  if (property?.['type'] === 'CallExpression' && (property['arguments'] as { expression: Node }[])[3]?.expression === node) {
    const callee = property['callee'] as Node;
    return nodesOf(module.tree).some(entry => entry['type'] === 'ImportDeclaration'
      && resolve('/', module.file, '..', stringValue(entry['source'] as Node) ?? '') === '/src/graph/operation-host.js'
      && nodesOf(entry).some(specifier => specifier['type'] === 'ImportSpecifier' && named(specifier['imported'] ?? specifier['local'], 'operationReceipt')
        && (specifier['local'] as Node)['ctxt'] === callee['ctxt'] && named(specifier['local'], String(callee['value']))));
  }
  if (property?.['type'] !== 'KeyValueProperty' || !named(property['key'], 'key') || property['value'] !== node) return false;
  const scope = parents.find(entry => entry['type'] === 'FunctionDeclaration');
  const type = (scope?.['returnType'] as Node | undefined)?.['typeAnnotation'] as Node | undefined;
  if (type?.['type'] !== 'TsTypeReference' || !named(type['typeName'], 'OperationRequest')) return false;
  if (!nodesOf(module.tree).some(entry => entry['type'] === 'ImportDeclaration'
    && resolve('/', module.file, '..', stringValue(entry['source'] as Node) ?? '') === '/src/graph/operation-host.js'
    && nodesOf(entry).some(specifier => specifier['type'] === 'ImportSpecifier' && named(specifier['imported'] ?? specifier['local'], 'OperationRequest')
      && (specifier['local'] as Node)['ctxt'] === (type['typeName'] as Node)['ctxt']))) return false;
  return parents[1]?.['type'] === 'ObjectExpression' && parents[2]?.['type'] === 'ReturnStatement';
}

/** Protocol literals are exempt only in the declaration or validator that proves their wire role. */
function externalProtocolLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  const value = stringValue(node);
  if (value === undefined) return false;
  if (operationReceiptKeyLiteral(module, node, modules) || checkedBindingSlotLiteral(module, node, modules) || checkedMcpArgumentLiteral(module, node) || graphSelectorArgumentLiteral(module, node, modules) || tracePhaseLiteral(module, node) || graphSchemaTableLiteral(module, node, modules) || loopResultLiteral(module, node) || manifestContractLiteral(module, node) || checkedInterfaceKeyListLiteral(module, node, modules) || declarationProtocolLiteral(module, node, modules) || documentProjectionLiteral(module, node, modules) || semanticBindingLookupLiteral(module, node, modules) || interfaceMemberTypeLiteral(module, node, modules) || semanticRoleArgumentLiteral(module, node, modules) || conditionalSystemFieldsLiteral(module, node, modules) || protectedContractLiteral(module, node) || typedEngineComparisonLiteral(module, node, modules) || engineTypeLiteral(module, node) || ownerTransactionLiteral(module, node, modules) || checkedLocatorLiteral(module, node, modules) || protectedSelectionFieldLiteral(module, node, modules) || protectedRowFieldLiteral(module, node, modules) || machineStateSubsetLiteral(module, node, modules) || stateSelectorListLiteral(module, node, modules) || transactionModeLiteral(module, node, modules) || systemSelectorListLiteral(module, node, modules) || semanticRecordSlotsLiteral(module, node, modules) || semanticProjectionLiteral(module, node, modules) || systemRecordProjectionLiteral(module, node, modules) || systemEdgeRelationLiteral(module, node) || assertionSchemaLiteral(module, node) || systemFieldLiteral(module, node, modules) || likec4GrammarLiteral(module, node) || lifecycleOutcomeLiteral(module, node, modules) || closedCommandLiteral(module, node) || pluginCommandLiteral(module, node) || daemonMemberLiteral(module, node, modules) || indexedFileDiscriminant(module, node) || protocolSchemaLiteral(module, node) || pluginManifestDiagnostic(module, node)) return true;
  const ancestors = enclosing(module, node);
  // Only the response predicate's property test, not arbitrary strings inside the predicate, has a wire role.
  if (module.file === 'src/plugin/wire.ts') {
    const guard = ancestors.find((entry) => entry['type'] === 'FunctionDeclaration' && named(entry['identifier'], 'isResponse'));
    const test = ancestors[0];
    if (guard !== undefined && test?.['type'] === 'BinaryExpression' && test['operator'] === 'in' && test['left'] === node) {
      const annotation = guard['returnType'] as Node | undefined;
      if (annotation !== undefined) {
        const members = nodesOf(annotation).filter((entry) => entry['type'] === 'TsPropertySignature');
        const rpc = members.find((entry) => named(entry['key'], 'jsonrpc'));
        const field = members.some((entry) => named(entry['key'], value));
        if (field && rpc !== undefined && nodesOf(rpc).some((entry) => stringValue(entry) === '2.0')) return true;
      }
    }
  }
  // A file-form union in the stored file index is a declared wire type, not a product kind identifier.
  if (module.file === 'src/plugin/product-source.ts') {
    const property = ancestors.find((entry) => entry['type'] === 'TsPropertySignature');
    if ((property?.['key'] as Node | undefined)?.['value'] === 'form') {
      const literals = nodesOf(property!).map(stringValue).filter((entry): entry is string => entry !== undefined);
      if (literals.length === 2 && literals.includes('text') && literals.includes('binary')) return true;
    }
  }
  // An exact argv slot compared with all three aliases is command grammar, not a string elsewhere in the branch.
  if ((module.file === 'src/product/cli.ts' || module.file === 'src/plugin/cli.ts') && value === 'help') {
    const branch = ancestors.find((entry) => entry['type'] === 'IfStatement');
    const test = branch?.['test'] as Node | undefined;
    const comparison = ancestors[0];
    if (test !== undefined && nodesOf(test).includes(node) && comparison?.['type'] === 'BinaryExpression' && comparison['operator'] === '===') {
      const argv = comparison['left'] as Node | undefined;
      const slot = argv?.['property'] as Node | undefined;
      if (argv?.['type'] === 'MemberExpression' && named(argv['object'], 'args') && slot?.['type'] === 'Computed'
        && (slot['expression'] as Node | undefined)?.['type'] === 'NumericLiteral' && (slot['expression'] as Node)['value'] === 0) {
        const aliases = nodesOf(test).filter((entry) => entry['type'] === 'BinaryExpression' && entry['operator'] === '===')
          .filter((entry) => {
            const left = entry['left'] as Node;
            const property = left['property'] as Node | undefined;
            return left['type'] === 'MemberExpression' && named(left['object'], 'args') && property?.['type'] === 'Computed'
              && (property['expression'] as Node | undefined)?.['value'] === 0;
          }).map((entry) => stringValue(entry['right'] as Node));
        if (aliases.includes('--help') && aliases.includes('-h')) return true;
      }
    }
  }
  return false;
}

/** Gate 1: no string literal of the engine names a kind or a field the starter catalogue alone declares. */
export function productDataViolations(root: string, modules: Map<string, GateModule> = modulesOf(root)): ArchitectureViolation[] {
  const format = manifestFormatWords(root);
  const names = new Set<string>();
  for (const kind of catalogueKinds(root)) {
    // A word the manifest format itself declares is the engine's vocabulary, not product data (`labels`, `definition`).
    if (!format.has(kind.name)) names.add(kind.name);
    if (kind.id !== undefined && !format.has(kind.id)) names.add(kind.id);
    for (const field of kind.fields) if (!format.has(field.name)) names.add(field.name);
  }
  const found: ArchitectureViolation[] = [];
  for (const module of modules.values()) {
    for (const node of nodesOf(module.tree)) {
      const value = stringValue(node);
      if (value === undefined || !names.has(value) || externalProtocolLiteral(module, node, modules)) continue;
      found.push({ rule: 'no-product-data', file: module.file, line: module.lineAt(spanOf(node)?.start ?? 1), symbol: value });
    }
    for (const node of nodesOf(module.tree)) {
      if (node['type'] !== 'ImportDeclaration') continue;
      const specifier = node['source'] as Node | undefined;
      const text = specifier === undefined ? undefined : stringValue(specifier);
      if (text === undefined) continue;
      const target = resolve(resolve(root, ...module.file.split('/')), '..', text.split('/').slice(0, -1).join('/'));
      const fromRoot = relative(resolve(root), target).split('\\').join('/');
      if (fromRoot === 'catalog' || fromRoot.startsWith('catalog/')) {
        found.push({ rule: 'no-product-data', file: module.file, line: module.lineAt(spanOf(node)?.start ?? 1), symbol: `import ${text}` });
      }
    }
  }
  return once(found);
}

// ---- gate 2: everything is a vertex or an edge -------------------------------------------------

/** The only modules allowed to make a table: the graph core's installation and the generator from the manifest. */
export const TABLE_SOURCES: readonly string[] = ['src/adapters/schemas/graph-contract.ts', 'src/adapters/schemas/graph-definition.ts'];

/** The tables one SQL text creates, read by PostgreSQL's own parser. */
async function createdTables(text: string): Promise<string[]> {
  const first = text.trimStart().split(/\s/u)[0]?.toUpperCase();
  if (first !== 'CREATE' && !/create\s+table/iu.test(text)) return [];
  let parsed: unknown;
  try {
    parsed = parseSql(text);
  } catch {
    // A statement built across literals (`'CREATE TABLE IF NOT EXISTS ' + name`) is no single SQL text: it is still a
    // CREATE TABLE in that module, and the gate reports it as one rather than passing it over.
    return first === 'CREATE' ? ['a table named by a statement built across literals'] : [];
  }
  const tables: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (value === null || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    if (node['CreateStmt'] !== undefined) {
      const statement = node['CreateStmt'] as Record<string, unknown>;
      const relation = statement['relation'] as Record<string, unknown> | undefined;
      const name = relation?.['relname'];
      if (typeof name === 'string') tables.push(name);
    }
    if (node['CreateForeignTableStmt'] !== undefined || node['CreateTableAsStmt'] !== undefined) {
      tables.push('a table without a plain name');
    }
    for (const entry of Object.values(node)) walk(entry);
  };
  walk(parsed);
  return tables;
}

/** Gate 2: CREATE TABLE only in the graph core's installation and the generator from the manifest. */
export async function tableSourceViolations(root: string, modules: Map<string, GateModule> = modulesOf(root)): Promise<ArchitectureViolation[]> {
  await loadModule();
  const found: ArchitectureViolation[] = [];
  for (const module of modules.values()) {
    if (TABLE_SOURCES.includes(module.file)) continue;
    for (const node of nodesOf(module.tree)) {
      const text = stringValue(node);
      if (text === undefined || !/create\s+table/iu.test(text)) continue;
      for (const table of await createdTables(text)) {
        found.push({ rule: 'one-table-source', file: module.file, line: module.lineAt(spanOf(node)?.start ?? 1), symbol: table });
      }
    }
  }
  return once(found);
}

/** An explicitly declared entity-reference shape is an edge, even inside typed JSON. */
function embeddedIdentity(schema: unknown): boolean {
  if (schema === null || typeof schema !== 'object') return false;
  if (Array.isArray(schema)) return schema.some(embeddedIdentity);
  const node = schema as Record<string, unknown>;
  if (node['reference'] !== undefined) return true;
  const properties = node['properties'];
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    const fields = properties as Record<string, unknown>;
    const key = fields['key'];
    if (fields['kind'] !== undefined && key !== null && typeof key === 'object' && (key as Record<string, unknown>)['type'] === 'object') return true;
  }
  return Object.values(node).some(embeddedIdentity);
}

/** Gate 2: references are edges; JSON metadata requires a valid bounded Draft 2020-12 schema (0039 item 4). */
export function cataloguePointerViolations(root: string): ArchitectureViolation[] {
  const found: ArchitectureViolation[] = [];
  for (const kind of catalogueKinds(root)) {
    for (const field of kind.fields) {
      let pointer = field.reference !== undefined;
      if (field.type === 'json') {
        try {
          const schema = field.schema as Record<string, unknown> | undefined;
          if (schema?.['$schema'] !== 'https://json-schema.org/draft/2020-12/schema') throw new Error('JSON metadata requires Draft 2020-12');
          validateDeclaredJsonSchema(schema);
          pointer ||= embeddedIdentity(schema);
        } catch { pointer = true; }
      }
      if (pointer) found.push({ rule: 'catalogue-pointers', file: `catalog/${kind.path}`, line: field.line, symbol: field.name });
    }
  }
  return once(found);
}

// ---- gate 4: no regex in the engine ------------------------------------------------------------

/** The modules allowed a regular expression, with why. Empty: the engine parses with syntax trees, never with patterns. */
export const REGEX_APPROVED: readonly { readonly file: string; readonly why: string }[] = [];

/** Gate 4: a RegExp literal, `new RegExp` or `RegExp(` is refused outside the approved modules. */
export function regexViolations(root: string, modules: Map<string, GateModule> = modulesOf(root)): ArchitectureViolation[] {
  const approved = new Set(REGEX_APPROVED.map((entry) => entry.file));
  const found: ArchitectureViolation[] = [];
  for (const module of modules.values()) {
    if (approved.has(module.file)) continue;
    for (const node of nodesOf(module.tree)) {
      if (node['type'] === 'RegExpLiteral') {
        const pattern = typeof node['pattern'] === 'string' ? node['pattern'] : '';
        found.push({ rule: 'no-regex', file: module.file, line: module.lineAt(spanOf(node)?.start ?? 1), symbol: `/${pattern}/` });
      }
      if (node['type'] !== 'NewExpression' && node['type'] !== 'CallExpression') continue;
      const callee = node['callee'] as Node | undefined;
      const name = callee === undefined ? undefined : callee['type'] === 'Identifier' ? callee['value'] : undefined;
      if (name === 'RegExp') {
        found.push({ rule: 'no-regex', file: module.file, line: module.lineAt(spanOf(node)?.start ?? 1), symbol: `${node['type'] === 'NewExpression' ? 'new ' : ''}RegExp` });
      }
    }
  }
  return once(found);
}

// ---- gate 5: extraction is plugins only --------------------------------------------------------

/** The plugin host, and the modules that are infrastructure rather than extraction, each with why. */
export const FILE_AND_PROCESS_ALLOWED: readonly { readonly file: string; readonly why: string }[] = [
  { file: 'src/plugin/host.ts', why: 'the plugin host: the sandbox in which a plugin reads a repository' },
  { file: 'src/plugin/sandbox.ts', why: 'the plugin host: the sandbox in which a plugin reads a repository' },
  { file: 'src/product/git.ts', why: 'the git command a lifecycle step runs' },
  { file: 'src/product/lifecycle.ts', why: 'the lifecycle commands: init, clone, demo, serve' },
  { file: 'src/product/cli.ts', why: 'the command line itself' },
  { file: 'src/product/daemon.ts', why: 'the background server process' },
  { file: 'src/product/store-preparation.ts', why: 'the store preparation boundary' },
  { file: 'src/product/home.ts', why: 'the products home on disk' },
  { file: 'src/product/draft.ts', why: 'the product folder a person makes' },
  { file: 'src/adapters/postgres-cluster.ts', why: 'the PostgreSQL server madarch installs' },
  { file: 'src/adapters/postgres-install.ts', why: 'the PostgreSQL server madarch installs' },
  { file: 'src/identity/identity.ts', why: 'who the user is, asked of git' },
  { file: 'src/render/read-worker.ts', why: 'the renderer in a process of its own' },
  { file: 'src/obs/trace.ts', why: 'the trace writer' },
  { file: 'src/skills/install.ts', why: 'the skill set installed on disk' },
];

const FILE_SPECIFIERS = new Set(['node:fs', 'fs', 'node:fs/promises', 'fs/promises']);
const PROCESS_SPECIFIERS = new Set(['node:child_process', 'child_process', 'node:worker_threads', 'worker_threads']);
const SPAWN_CALLEES = new Set(['execFile', 'execFileSync', 'spawn', 'spawnSync', 'exec', 'execSync']);

/** Gate 5: a module reads a file or starts a process only in the plugin host or a named piece of infrastructure. */
export function extractionViolations(root: string, modules: Map<string, GateModule> = modulesOf(root)): ArchitectureViolation[] {
  const allowed = new Set(FILE_AND_PROCESS_ALLOWED.map((entry) => entry.file));
  const found: ArchitectureViolation[] = [];
  for (const module of modules.values()) {
    if (allowed.has(module.file) || module.file.startsWith('src/plugin/')) continue;
    for (const node of nodesOf(module.tree)) {
      if (node['type'] === 'ImportDeclaration') {
        const source = node['source'] as Node | undefined;
        const text = source === undefined ? undefined : stringValue(source);
        if (text === undefined) continue;
        if (FILE_SPECIFIERS.has(text) || PROCESS_SPECIFIERS.has(text)) {
          found.push({ rule: 'extraction-boundary', file: module.file, line: module.lineAt(spanOf(node)?.start ?? 1), symbol: text });
        }
        continue;
      }
      if (node['type'] !== 'CallExpression' && node['type'] !== 'NewExpression') continue;
      const callee = node['callee'] as Node | undefined;
      const name = callee?.['type'] === 'Identifier' ? callee['value'] : callee?.['type'] === 'MemberExpression' ? (callee['property'] as Node | undefined)?.['value'] : undefined;
      if (typeof name !== 'string') continue;
      if (SPAWN_CALLEES.has(name) || (name === 'spawn' && callee?.['object'] !== undefined)) {
        found.push({ rule: 'extraction-boundary', file: module.file, line: module.lineAt(spanOf(node)?.start ?? 1), symbol: `${name}()` });
      }
    }
  }
  return once(found);
}

// ---- gate 6: one command list and one route list, no aliases -----------------------------------

/** The commands `madarch` answers to, whole: a new command is added here on purpose, in the commit that adds it. */
export const CLOSED_COMMANDS: readonly string[] = [
  'bootstrap', 'clone', 'daemon-serve', 'demo', 'fill', 'fill-stages', 'init', 'list', 'remote', 'rename', 'repo',
  'reset', 'serve', 'start', 'status', 'stop', 'trace', 'upgrade', 'version',
];

/** Gate 6: the command line's commands are exactly the closed list, and every kept route is one the server answers. */
export function commandListViolations(root: string): ArchitectureViolation[] {
  const file = 'src/product/cli.ts';
  const module = parseModule(file, readFileSync(resolve(root, ...file.split('/')), 'utf8'), false);
  const declared = new Set<string>(CLOSED_COMMANDS);
  const found: ArchitectureViolation[] = [];
  const answered = new Set<string>();
  for (const node of nodesOf(module.tree)) {
    if (node['type'] !== 'VariableDeclaration') continue;
    const declarations = node['declarations'];
    if (!Array.isArray(declarations)) continue;
    for (const declaration of declarations as Node[]) {
      const name = declaration['id'] as Node | undefined;
      if (name?.['value'] !== 'COMMANDS') continue;
      const init = declaration['init'] as Node | undefined;
      if (init?.['type'] !== 'ObjectExpression') continue;
      const properties = init['properties'];
      if (!Array.isArray(properties)) continue;
      for (const property of properties as Node[]) {
        const key = property['key'] as Node | undefined;
        const command = key === undefined ? undefined : stringValue(key) ?? (key['type'] === 'Identifier' ? String(key['value']) : undefined);
        if (command === undefined) continue;
        answered.add(command);
        if (!declared.has(command)) found.push({ rule: 'one-command-list', file, line: module.lineAt(spanOf(property)?.start ?? 1), symbol: command });
      }
    }
  }
  for (const command of CLOSED_COMMANDS) {
    // A command the list keeps and the command line no longer answers: the list and the commands are one list.
    if (!answered.has(command)) found.push({ rule: 'one-command-list', file, line: 1, symbol: `declared ${command}` });
  }
  return once(found);
}

/** Gate 6's other half: a route table entry names a route of the one address map, and never spells a path of its own. */
export function routeAliasViolations(root: string): ArchitectureViolation[] {
  const httpFile = 'src/server/http.ts';
  const http = parseModule(httpFile, readFileSync(resolve(root, ...httpFile.split('/')), 'utf8'), false);
  const found: ArchitectureViolation[] = [];
  for (const node of nodesOf(http.tree)) {
    if (node['type'] !== 'ObjectExpression') continue;
    const properties = node['properties'];
    if (!Array.isArray(properties)) continue;
    let method = false;
    let alias: Node | undefined;
    for (const property of properties as Node[]) {
      const key = property['key'] as Node | undefined;
      const name = key?.['type'] === 'Identifier' ? String(key['value']) : key?.['type'] === 'StringLiteral' ? String(key['value']) : undefined;
      if (name === 'method') method = true;
      if (name === 'path') {
        const value = property['value'] as Node | undefined;
        if (value?.['type'] === 'StringLiteral') alias = value;
      }
    }
    if (!method || alias === undefined) continue;
    found.push({ rule: 'route-aliases', file: httpFile, line: http.lineAt(spanOf(alias)?.start ?? 1), symbol: String(alias['value']) });
  }
  return once(found);
}

// ---- gate 7: a page's data comes through the graph ---------------------------------------------

/** Gate 7: an app module imports no `read*` command: a page's data is read through GraphQL, never by a bespoke route. */
export function appGraphReadViolations(root: string, modules: Map<string, GateModule> = modulesOf(root)): ArchitectureViolation[] {
  const found: ArchitectureViolation[] = [];
  for (const module of modules.values()) {
    if (!module.file.startsWith('wiki/app/src/') || module.file.startsWith('wiki/app/src/components/ui/')) continue;
    for (const node of nodesOf(module.tree)) {
      if (node['type'] !== 'ImportDeclaration') continue;
      const source = node['source'] as Node | undefined;
      const specifier = source === undefined ? undefined : stringValue(source);
      if (specifier === undefined || !/(?:^|\/)command\.js$/u.test(specifier)) continue;
      const bindings = node['specifiers'];
      if (!Array.isArray(bindings)) continue;
      for (const binding of bindings as Node[]) {
        const imported = binding['local'] as Node | undefined;
        const name = imported === undefined ? undefined : imported['value'];
        if (typeof name === 'string' && name.startsWith('read')) {
          found.push({ rule: 'app-graph-reads', file: module.file, line: module.lineAt(spanOf(binding)?.start ?? 1), symbol: name });
        }
      }
    }
  }
  return once(found);
}

// ---- gate 10: I/O runs inside a span -----------------------------------------------------------

/** The calls that reach outside the process: a file, the network, a database or a child process. */
export const IO_CALLEES: readonly string[] = [
  'fetch', 'readFile', 'readFileSync', 'readdir', 'readdirSync', 'stat', 'statSync', 'writeFile', 'writeFileSync',
  'mkdir', 'mkdirSync', 'rm', 'rmSync', 'rename', 'copyFile', 'createWriteStream', 'createReadStream',
  'execFile', 'execFileSync', 'spawn', 'spawnSync', 'exec', 'connect', 'listen', 'query', 'request',
];

/** The functions that open a span; `withSpan` first, then the trace API's own children. */
const SPAN_CALLEES = new Set(['withSpan', 'withSpanSync', 'startSpan', 'startActiveSpan']);

function calleeName(node: Node): string | undefined {
  const callee = node['callee'] as Node | undefined;
  if (callee === undefined) return undefined;
  if (callee['type'] === 'Identifier') return String(callee['value']);
  if (callee['type'] === 'MemberExpression') {
    const property = callee['property'] as Node | undefined;
    return property === undefined ? undefined : String(property['value']);
  }
  return undefined;
}

/** Every function-like node a node stands in, the nearest first. */
function enclosingFunctions(node: Node): Node[] {
  const chain: Node[] = [];
  let current = node['parent'] as Node | undefined;
  while (current !== undefined) {
    if (typeof current['type'] === 'string' && /Function|ArrowFunction/u.test(String(current['type']))) chain.push(current);
    current = current['parent'] as Node | undefined;
  }
  return chain;
}

/** Gate 10: a call that leaves the process stands inside a function that opens a span. */
export function ioSpansViolations(root: string, modules: Map<string, GateModule> = modulesOf(root)): ArchitectureViolation[] {
  const found: ArchitectureViolation[] = [];
  for (const module of modules.values()) {
    const tree = module.tree;
    const nodes = nodesOf(tree);
    for (const node of nodes) {
      if (node['type'] !== 'CallExpression' && node['type'] !== 'NewExpression') continue;
      const name = calleeName(node);
      if (name === undefined || !IO_CALLEES.includes(name)) continue;
      const chain = enclosingFunctions(node);
      const spanned = chain.some((fn) => nodesOf(fn).some((child) => SPAN_CALLEES.has(calleeName(child) ?? '') === true));
      if (spanned) continue;
      found.push({ rule: 'io-spans', file: module.file, line: module.lineAt(spanOf(node)?.start ?? 1), symbol: `${name}()` });
    }
  }
  return once(found);
}

// ---- gate 11: one state machine -----------------------------------------------------------------

/** The module that persists the fill's state machines, and the tables whose state it alone writes. */
export const STATE_MACHINE_STORE = 'src/fill/state-store.ts';
const STATE_TABLES = new Set(['fill_run', 'fill_unit']);

/** Gate 11: a run's or a unit's state is written only by the state-machine store. */
export async function stateMachineViolations(root: string, modules: Map<string, GateModule> = modulesOf(root)): Promise<ArchitectureViolation[]> {
  await loadModule();
  const found: ArchitectureViolation[] = [];
  for (const module of modules.values()) {
    if (module.file === STATE_MACHINE_STORE) continue;
    for (const node of nodesOf(module.tree)) {
      const text = stringValue(node);
      if (text === undefined || !/update\s+(?:fill_run|fill_unit)\b/iu.test(text)) continue;
      let parsed: unknown;
      try { parsed = parseSql(text); } catch { continue; }
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) { for (const item of value) walk(item); return; }
        if (value === null || typeof value !== 'object') return;
        const held = value as Record<string, unknown>;
        const update = held['UpdateStmt'] as Record<string, unknown> | undefined;
        if (update !== undefined) {
          const relation = update['relation'] as Record<string, unknown> | undefined;
          const name = relation?.['relname'];
          if (typeof name === 'string' && STATE_TABLES.has(name)) {
            found.push({ rule: 'one-state-machine', file: module.file, line: module.lineAt(spanOf(node)?.start ?? 1), symbol: name });
          }
        }
        for (const entry of Object.values(held)) walk(entry);
      };
      walk(parsed);
    }
  }
  return once(found);
}


// ---- gate 8: the UI is built from the kit only -------------------------------------------------

/** The app's own components: a `.tsx` outside tests, the build and the kit. */
function uiModules(modules: Map<string, GateModule>): GateModule[] {
  return [...modules.values()].filter((module) => module.file.endsWith('.tsx') && !module.file.startsWith('wiki/app/src/components/ui/'));
}

/** Gate 8: outside the kit no intrinsic element stands and no element carries a className. */
export function uiKitViolations(root: string, modules: Map<string, GateModule> = modulesOf(root)): ArchitectureViolation[] {
  const found: ArchitectureViolation[] = [];
  for (const module of uiModules(modules)) {
    for (const node of nodesOf(module.tree)) {
      if (node['type'] !== 'JSXOpeningElement') continue;
      const name = node['name'] as Node | undefined;
      const tag = name?.['type'] === 'Identifier' ? String(name['value']) : undefined;
      if (tag !== undefined && /^[a-z]/u.test(tag)) {
        found.push({ rule: 'ui-kit-only', file: module.file, line: module.lineAt(spanOf(node)?.start ?? 1), symbol: `element <${tag}>` });
      }
      const attributes = node['attributes'];
      if (!Array.isArray(attributes)) continue;
      for (const attribute of attributes as Node[]) {
        if (attribute['type'] !== 'JSXAttribute') continue;
        const held = attribute['name'] as Node | undefined;
        if (held?.['type'] === 'Identifier' && held['value'] === 'className') {
          found.push({ rule: 'ui-kit-only', file: module.file, line: module.lineAt(spanOf(attribute)?.start ?? 1), symbol: `className on <${tag ?? 'a component'}>` });
        }
      }
    }
  }
  return once(found);
}

// ---- gate 9: every visible string through i18n -------------------------------------------------

/** The props that are structure, not words a reader sees: a literal in one is not a missing translation. */
const NON_TEXT_PROPS = new Set([
  'className', 'style', 'id', 'role', 'type', 'name', 'value', 'href', 'to', 'src', 'key', 'ref', 'as', 'variant',
  'size', 'slot', 'target', 'rel', 'htmlFor', 'tabIndex', 'method', 'action', 'dir', 'lang', 'form', 'autoComplete',
  'inputMode', 'spellCheck', 'contentEditable', 'draggable', 'data-testid',
]);

/** Gate 9: a JSX text or a literal in a visible prop is refused outside the locale files. */
export function i18nViolations(root: string, modules: Map<string, GateModule> = modulesOf(root)): ArchitectureViolation[] {
  const found: ArchitectureViolation[] = [];
  for (const module of uiModules(modules)) {
    for (const node of nodesOf(module.tree)) {
      if (node['type'] === 'JSXText') {
        const text = typeof node['value'] === 'string' ? node['value'].trim() : '';
        if (text !== '') found.push({ rule: 'i18n-text', file: module.file, line: module.lineAt(spanOf(node)?.start ?? 1), symbol: text.slice(0, 40) });
        continue;
      }
      if (node['type'] !== 'JSXAttribute') continue;
      const held = node['name'] as Node | undefined;
      const name = held?.['type'] === 'Identifier' ? String(held['value']) : undefined;
      if (name === undefined || NON_TEXT_PROPS.has(name) || name.startsWith('data-') || name.startsWith('aria-')) continue;
      const value = node['value'] as Node | undefined;
      const literal = value?.['type'] === 'StringLiteral' && typeof value['value'] === 'string' ? value['value'] : undefined;
      if (literal !== undefined && literal.trim() !== '') found.push({ rule: 'i18n-text', file: module.file, line: module.lineAt(spanOf(node)?.start ?? 1), symbol: `${name}: ${literal.slice(0, 40)}` });
    }
  }
  return once(found);
}
