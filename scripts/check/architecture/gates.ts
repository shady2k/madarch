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
import { byCodePoint } from '../../../src/model/order.js';
import { orderedViolations, type ArchitectureViolation } from './violation.js';

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
  const link = (value: unknown, parent: Record<string, unknown> | undefined): void => {
    if (Array.isArray(value)) {
      for (const item of value) link(item, parent);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    if (typeof node['type'] === 'string') {
      // A syntax node knows the node that stands above it. A slot that holds nodes without being one
      // (`{ spread, expression }`, the shape SWC wraps an argument in) hands the parent it was given
      // on, so a node inside a call's arguments still names the function that encloses it.
      if (parent !== undefined) node['parent'] = parent;
      for (const [key, entry] of Object.entries(node)) if (key !== 'span' && key !== 'ctxt' && key !== 'parent') link(entry, node);
      return;
    }
    for (const [key, entry] of Object.entries(node)) if (key !== 'span' && key !== 'ctxt' && key !== 'parent') link(entry, parent);
  };
  link(root, undefined);
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

export interface CatalogueField { readonly name: string; readonly type: string; readonly reference: string | undefined; readonly line: number }
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

/**
 * SourceText exposes the file-read protocol, not a catalogue kind. Only its direct field-name declarations may use
 * properties of FileTextResult; the same word in a resolver, another type or an arbitrary string remains checked.
 */
function fileTextProtocolFields(modules: Map<string, GateModule>): Set<Node> {
  const permitted = new Set<Node>();
  const protocol = modules.get('src/knowledge/file-text-shape.ts');
  const schema = modules.get('src/graphql/schema.ts');
  if (protocol === undefined || schema === undefined) return permitted;
  const fields = new Set<string>();
  for (const node of nodesOf(protocol.tree)) {
    if (node['type'] !== 'TsInterfaceDeclaration' || (node['id'] as Node | undefined)?.['value'] !== 'FileTextResult') continue;
    const body = (node['body'] as Node)['body'] as Node[];
    for (const property of body) {
      if (property['type'] !== 'TsPropertySignature') continue;
      const key = property['key'] as Node;
      if (key['type'] === 'Identifier') fields.add(String(key['value']));
      else if (key['type'] === 'StringLiteral') fields.add(String(key['value']));
    }
  }
  for (const node of nodesOf(schema.tree)) {
    if (node['type'] !== 'CallExpression') continue;
    const callee = node['callee'] as Node;
    if (callee['type'] !== 'MemberExpression' || (callee['object'] as Node)['type'] !== 'ThisExpression'
      || (callee['property'] as Node)['type'] !== 'Identifier' || (callee['property'] as Node)['value'] !== 'type') continue;
    const args = node['arguments'] as { expression: Node }[];
    if (args[0]?.expression['type'] !== 'StringLiteral' || stringValue(args[0].expression) !== 'SourceText') continue;
    const declarations = args[1]?.expression;
    if (declarations?.['type'] !== 'ArrayExpression') continue;
    for (const entry of declarations['elements'] as ({ expression: Node } | null)[]) {
      const field = entry?.expression;
      if (field?.['type'] !== 'ObjectExpression') continue;
      for (const property of field['properties'] as Node[]) {
        if (property['type'] !== 'KeyValueProperty') continue;
        const key = property['key'] as Node;
        if ((key['type'] !== 'Identifier' && key['type'] !== 'StringLiteral') || key['value'] !== 'name') continue;
        const value = property['value'] as Node;
        if (value['type'] === 'StringLiteral' && fields.has(String(value['value']))) permitted.add(value);
      }
    }
  }
  return permitted;
}

/** Gate 1: no string literal of the engine names a kind or a field the starter catalogue alone declares. */
export function productDataViolations(root: string, modules: Map<string, GateModule> = modulesOf(root)): ArchitectureViolation[] {
  const format = manifestFormatWords(root);
  const protocolFields = fileTextProtocolFields(modules);
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
      if (value === undefined || !names.has(value) || protocolFields.has(node)) continue;
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

/** Gate 2, the catalogue's half: a reference field is a pointer, and a free json field is structured data, not a value. */
export function cataloguePointerViolations(root: string): ArchitectureViolation[] {
  const found: ArchitectureViolation[] = [];
  for (const kind of catalogueKinds(root)) {
    for (const field of kind.fields) {
      const path = `catalog/${kind.path}`;
      if (field.reference !== undefined) found.push({ rule: 'catalogue-pointers', file: path, line: field.line, symbol: field.name });
      else if (field.type === 'json') found.push({ rule: 'catalogue-pointers', file: path, line: field.line, symbol: field.name });
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
  { file: 'src/obs/retention.ts', why: 'the raw telemetry retention sweep' },
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

/** The functions that open a span: the two forms of `withSpan`, and the trace API's own children. */
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

/** The words a prop's name carries when a reader reads the prop: `title`, `label`, `alt` and their compounds. */
const TEXT_PROP_WORDS = new Set(['title', 'label', 'alt', 'placeholder', 'description', 'summary', 'caption', 'legend', 'heading', 'text', 'message', 'note', 'hint', 'subtitle']);

/**
 * Whether a JSX attribute names words a reader reads (decision 0036, section 7): the attribute's own name says it —
 * `title`, `label="…"`, `emptyText` — and a prop that names a test, a key or a style says it does not. Nothing here is
 * a list of one product's strings: a name whose last word is a text word is text, every other name configures.
 */
function isTextProp(name: string): boolean {
  if (name.startsWith('data-')) return false;
  if (/Id$/u.test(name) || /Key$/u.test(name)) return false;
  const words = name.split(/(?=[A-Z])|[-_]/u).map((one) => one.toLowerCase()).filter(Boolean);
  const last = words.at(-1);
  if (last === undefined) return false;
  // `aria-label` is read aloud by a screen reader: its words are words a person hears.
  return TEXT_PROP_WORDS.has(last) || name === 'aria-label';
}

/** Whether a text holds a word a person reads: a dash, a separator or a bracket is layout, never language. */
function hasWords(text: string): boolean {
  for (const character of text) if (/[\p{L}\p{N}]/u.test(character)) return true;
  return false;
}

/** Gate 9: a JSX text or a literal in a visible prop is refused outside the locale files. */
export function i18nViolations(root: string, modules: Map<string, GateModule> = modulesOf(root)): ArchitectureViolation[] {
  const found: ArchitectureViolation[] = [];
  for (const module of uiModules(modules)) {
    for (const node of nodesOf(module.tree)) {
      if (node['type'] === 'JSXText') {
        const text = typeof node['value'] === 'string' ? node['value'].trim() : '';
        // An em dash standing for an empty value, a slash between two words: the page's layout, not a sentence.
        if (text !== '' && hasWords(text)) found.push({ rule: 'i18n-text', file: module.file, line: module.lineAt(spanOf(node)?.start ?? 1), symbol: text.slice(0, 40) });
        continue;
      }
      if (node['type'] !== 'JSXAttribute') continue;
      const held = node['name'] as Node | undefined;
      const name = held?.['type'] === 'Identifier' ? String(held['value']) : undefined;
      if (name === undefined || !isTextProp(name)) continue;
      const value = node['value'] as Node | undefined;
      const literal = value?.['type'] === 'StringLiteral' && typeof value['value'] === 'string' ? value['value'] : undefined;
      // A literal the reader reads is refused: the sentence around it belongs to the interface's own catalogue.
      if (literal !== undefined && hasWords(literal)) found.push({ rule: 'i18n-text', file: module.file, line: module.lineAt(spanOf(node)?.start ?? 1), symbol: `${name}: ${literal.slice(0, 40)}` });
    }
  }
  return once(found);
}
