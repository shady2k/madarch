/**
 * A plugin's closure and its one hash (decision 0035, item 4): every file the
 * plugin may load — its code, its locked dependencies, its contract and its
 * interpreter's pin — read from the plugin's folder, sorted by code point of
 * their relative paths, and digested into one sha256. A run then copies the
 * closure into a private snapshot, hashes the snapshot and executes only it,
 * so a change in the product's working tree never reaches a running plugin.
 *
 * The files are the plugin folder's own: a symlink is refused (a closure file
 * that answers elsewhere is not a file of the closure), and so is a plugin
 * folder with no `plugin.json`, whose entry names a file the folder lacks, or
 * whose runtime pin is not the runtime this host would run it with.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { builtinModules } from 'node:module';
import { ClosureRefusal } from './closure-refusal.js';
export { ClosureRefusal } from './closure-refusal.js';
import { walk, dependencyFiles } from './dependency-files.js';
import { PluginContractFile, type PluginRights } from './protocol.js';
import { SDK_SOURCE } from './sdk-asset.js';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { byCodePoint } from '../model/order.js';
import { LineCounter, parseDocument } from 'yaml';

/** Where a refusal stands, as every error of this codebase names it. */
const WHERE = 'src/plugin/closure.ts';

/** The plugin's own description, kept in the closure under this name. */
export const PLUGIN_MANIFEST_FILE = 'plugin.json';

/**
 * `plugin.json`: who the plugin is, what its entry is, and the runtime it is
 * written for. The runtime is the interpreter's pin: a plugin built for one
 * Bun version does not run on another without being built again, so the pin
 * is part of the hash and checked before the process starts.
 */
export const PluginManifest = Type.Object(
  {
    name: Type.String({ minLength: 1, pattern: '^[a-z][a-z0-9-]*$', description: 'The plugin\'s name: lower case letters, digits and dashes.' }),
    version: Type.String({ minLength: 1, description: 'The plugin\'s version, the plugin author\'s own.' }),
    entry: Type.String({ minLength: 1, description: 'The module the host starts, relative to the plugin folder.' }),
    runtime: Type.Object(
      {
        name: Type.Literal('bun', { description: 'The interpreter this build runs plugins with.' }),
        version: Type.String({ minLength: 1, description: 'The interpreter version the plugin is built for; the host refuses one it does not run.' }),
      },
      { additionalProperties: false },
    ),
    produces: Type.Array(Type.Object({
      kind: Type.String({ minLength: 1 }),
      fields: Type.Union([Type.Literal('*'), Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })]),
      reads: Type.Optional(Type.Array(Type.Union([
        Type.String({ minLength: 1 }),
        Type.Object({ kind: Type.String({ minLength: 1 }), version: Type.Literal('earlier'), producer: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      ]))),
      refines: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      coverage: Type.Optional(Type.Literal('gaps')),
    }, { additionalProperties: false }), { minItems: 1 }),
    tools: Type.Optional(Type.Array(Type.Object({
      name: Type.String({ pattern: '^[a-z][a-z0-9-]*$' }),
      sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    }, { additionalProperties: false }))),
    concurrency: Type.Optional(Type.Integer({ minimum: 1 })),
    description: Type.Optional(Type.String({ minLength: 1 })),
    agent: Type.Optional(Type.Object({
      prompt: Type.String({ minLength: 1 }),
      catalogue: Type.Optional(Type.Boolean()),
      roots: Type.Array(Type.String({ minLength: 1 })),
      writeRoots: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    }, { additionalProperties: false, description: 'Agent instructions and virtual repository/path roots; no adapter or credentials.' })),
  },
  { additionalProperties: false, description: 'A plugin folder\'s own description: its name, version, entry and interpreter pin.' },
);
export type PluginManifest = Static<typeof PluginManifest>;

/** One file of a closure, as the hash reads it. */
export interface ClosureFile {
  /** The path relative to the plugin folder, with `/` as the separator, in code point order among the closure's files. */
  readonly path: string;
  /** The file's sha256, in lower case hex. */
  readonly sha256: string;
  readonly bytes: number;
  /** The mode bits the snapshot copies back. */
  readonly mode: number;
  /** The bytes of a file madarch hands the plugin rather than one its folder holds: the SDK. */
  readonly content?: Uint8Array;
}

/** One plugin's closure: its folder, its manifest, its files and their one hash. */
export interface Closure {
  readonly folder: string;
  readonly manifest: PluginManifest;
  readonly files: readonly ClosureFile[];
  readonly hash: string;
}

/** Locate a runtime import's literal, ignoring comments and unrelated string values. */
function importLine(text: string, name: string): number {
  const tokens = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g;
  const previous: string[] = [];
  const scanner = new Bun.Transpiler({ loader: 'js' });
  for (const token of text.matchAll(tokens)) {
    const value = token[0];
    if (value.startsWith('//') || value.startsWith('/*')) continue;
    const last = previous.at(-1);
    const beforeLast = previous.at(-2);
    const isImport = last === 'from' || last === 'import' || (last === '(' && (beforeLast === 'import' || beforeLast === 'require'));
    if (isImport && (value.startsWith('"') || value.startsWith("'"))) {
      const imported = scanner.scanImports(`import ${value};`)[0];
      if (imported?.path === name) return text.slice(0, token.index).split('\n').length;
    }
    previous.push(value);
    if (previous.length > 2) previous.shift();
  }
  throw new Error(`Cannot locate runtime import ${JSON.stringify(name)} in its scanned source`);
}

/** Resolve every statically named runtime import against precisely the files the snapshot will carry. */
function validateImports(folder: string, files: readonly { path: string; file: string }[], entryPath: string): void {
  const held = new Set(files.map((file) => resolve(file.file)));
  const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`), 'bun', 'bun:ffi', 'bun:jsc', 'bun:sqlite', 'bun:test']);
  const pending = [files.find((file) => file.path === entryPath)!];
  const visited = new Set<string>();
  for (const entry of pending) {
    if (visited.has(entry.file)) continue;
    visited.add(entry.file);
    if (!/\.(?:[cm]?[jt]sx?)$/.test(entry.path) || /\.d\.[cm]?ts$/.test(entry.path)) continue;
    const text = readFileSync(entry.file, 'utf8').replace(/^#![^\n]*/, (line) => ' '.repeat(line.length));
    const loader = entry.path.endsWith('tsx') ? 'tsx' : entry.path.endsWith('jsx') ? 'jsx' : /\.[cm]?ts$/.test(entry.path) ? 'ts' : 'js';
    let imports: ReturnType<Bun.Transpiler['scanImports']>;
    try { imports = new Bun.Transpiler({ loader }).scanImports(text); }
    catch (error) { throw new ClosureRefusal('plugin-import', `${entry.file}:1: cannot scan imports: ${(error as Error).message}`, entry.file); }
    for (const imported of imports) {
      if (builtins.has(imported.path) || imported.path === SDK_PACKAGE) continue;
      let target: string;
      try { target = Bun.resolveSync(imported.path, dirname(entry.file)); } catch (error) {
        const line = importLine(text, imported.path);
        throw new ClosureRefusal('plugin-import', `${entry.file}:${line}: import ${JSON.stringify(imported.path)} cannot resolve inside the declared dependency closure ${folder}: ${(error as Error).message}`, entry.file, line);
      }
      if (held.has(resolve(target))) {
        pending.push(files.find((file) => resolve(file.file) === resolve(target))!);
        continue;
      }
      const line = importLine(text, imported.path);
      throw new ClosureRefusal('plugin-import', `${entry.file}:${line}: import ${JSON.stringify(imported.path)} cannot resolve inside the declared dependency closure ${folder} (resolved outside the closure to ${target})`, entry.file, line);
    }
  }
}

/** The sha256 of one file's bytes. */
function digestOf(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * The one hash of a closure: a sha256 over every file's path and its own
 * digest, in code point order of the paths. Paths and digests are separated
 * by NUL bytes, so two different listings can never render the same bytes.
 */
export function closureHashOf(files: readonly Pick<ClosureFile, 'path' | 'sha256'>[]): string {
  const hasher = createHash('sha256');
  for (const file of [...files].sort((left, right) => byCodePoint(left.path, right.path))) {
    hasher.update(file.path, 'utf8');
    hasher.update('\u0000', 'utf8');
    hasher.update(file.sha256, 'utf8');
    hasher.update('\u0000', 'utf8');
  }
  return hasher.digest('hex');
}

/** The plugin's manifest, or the refusal that names the file, the line and what is wrong. */
export function readPluginManifest(folder: string): PluginManifest {
  const file = join(folder, PLUGIN_MANIFEST_FILE);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new ClosureRefusal('plugin-manifest', `${WHERE}:1: ${file} cannot be read: a plugin folder carries its ${PLUGIN_MANIFEST_FILE} (its name, version, entry and interpreter pin) beside its code`, file);
  }
  return parsePluginManifest(text, file);
}

/** The same manifest check over pinned or working-tree bytes, without executing a plugin. */
export function pluginManifestLine(text: string, path: readonly (string | number)[]): number {
  const counter = new LineCounter();
  const document = parseDocument(text, { lineCounter: counter });
  const node = document.getIn([...path], true) as { range?: readonly number[] } | undefined;
  return counter.linePos(node?.range?.[0] ?? 0).line;
}

export function parsePluginManifest(text: string, file: string): PluginManifest {
  file = resolve(file);
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { throw new ClosureRefusal('plugin-manifest', `${file}:1: ${(error as Error).message}`, file); }
  const body = value as Partial<PluginManifest> | null;
  const refuse = (key: string, message: string): never => {
    const line = pluginManifestLine(text, [key]);
    throw new ClosureRefusal('plugin-manifest', `${file}:${line}: ${message}`, file, line);
  };
  if (body !== null && typeof body === 'object') {
    if (body.concurrency !== undefined && (!Number.isInteger(body.concurrency) || body.concurrency < 1)) refuse('concurrency', `plugin ${body.name ?? '?'} concurrency must be a positive integer`);
    if (!Array.isArray(body.produces) || body.produces.length === 0) refuse('produces', `plugin ${body.name ?? '?'} declares no output; declare produces, including Problem records for checks`);
  }
  if (!Value.Check(PluginManifest, value)) {
    const first = [...Value.Errors(PluginManifest, value)][0];
    const path = first?.instancePath.split('/').slice(1) ?? [];
    const line = pluginManifestLine(text, path);
    throw new ClosureRefusal('plugin-manifest', `${file}:${line}: ${first === undefined ? 'the manifest is not a plugin manifest' : `${first.instancePath === '' ? 'the manifest' : first.instancePath.slice(1)}: ${first.message}`}`, file, line);
  }
  return value;
}

/**
 * The rights a plugin's own contract declares (decision 0035, items 7 and 9): read from the closure's `contract.json`
 * before the process starts, because the sandbox binds the repository only for a plugin that declared it. The
 * introduction repeats the declaration, and the host refuses an introduction that differs.
 */
export function pluginRightsOf(closure: Closure): PluginRights {
  const file = join(closure.folder, 'contract.json');
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ClosureRefusal('plugin-contract', `${file}:1: the plugin contract cannot be read (${(error as Error).message}): a plugin folder carries its contract.json, which states the rights the host grants it`, file);
  }
  if (!Value.Check(PluginContractFile, value)) {
    const first = [...Value.Errors(PluginContractFile, value)][0];
    throw new ClosureRefusal('plugin-contract', `${file}:1: ${first === undefined ? 'the contract does not fit the protocol' : first.message}`, file);
  }
  const contract = value as { rights?: PluginRights };
  return contract.rights ?? { network: 'none' };
}

/**
 * What a plugin's own contract says it reads (madarch-stm0.7.1, piece 3): `whole-graph` for a plugin that reads the
 * graph once after every other plugin turn, `unit` for one that reads a unit at a time. Read from `contract.json`
 * before the process starts, and the introduction repeats it.
 */
export function pluginReadsOf(closure: Closure): 'unit' | 'whole-graph' {
  const file = join(closure.folder, 'contract.json');
  const value = JSON.parse(readFileSync(file, 'utf8')) as { reads?: unknown };
  return value.reads === 'whole-graph' ? 'whole-graph' : 'unit';
}

/** The one dependency madarch hands every plugin: the SDK, at the name a plugin imports it by. */
export const SDK_PACKAGE = 'madarch-plugin-sdk';

/**
 * The package files madarch writes into a closure for the SDK: its manifest and
 * its one module, the SDK's own source as this build carries it. They are part
 * of the closure's hash, so a plugin's version includes the SDK it runs with.
 */
export function sdkClosureFiles(): ClosureFile[] {
  const packageJson = `${JSON.stringify({ name: SDK_PACKAGE, version: '1.0.0', type: 'module', main: 'index.ts', description: 'The madarch extraction plugin SDK, embedded in the madarch build that hands it out.' }, null, 2)}\n`;
  const entries: { path: string; content: Uint8Array }[] = [
    { path: `node_modules/${SDK_PACKAGE}/package.json`, content: Buffer.from(packageJson, 'utf8') },
    { path: `node_modules/${SDK_PACKAGE}/index.ts`, content: Buffer.from(SDK_SOURCE, 'utf8') },
  ];
  return entries.map((entry) => ({ path: entry.path, sha256: createHash('sha256').update(entry.content).digest('hex'), bytes: entry.content.length, mode: 0o644, content: entry.content }));
}

/**
 * One plugin folder's closure: its own files and the installed packages reached
 * through declared dependencies, in code point order. Imports are resolved before
 * the hash is returned; nothing outside those files may satisfy an import.
 */
export function closureOf(folder: string): Closure {
  folder = resolve(folder);
  const manifest = readPluginManifest(folder);
  const missing: ClosureRefusal[] = [];
  const entries = [...walk(folder), ...dependencyFiles(folder, (error) => missing.push(error))];
  const own = entries.map((entry) => {
    const stat = lstatSync(entry.file);
    return { path: entry.path, sha256: digestOf(entry.file), bytes: stat.size, mode: stat.mode & 0o777 };
  });
  if (!own.some((file) => file.path === manifest.entry)) {
    throw new ClosureRefusal('plugin-entry', `${WHERE}:1: ${join(folder, manifest.entry)} is the entry ${PLUGIN_MANIFEST_FILE} names, and the plugin folder holds no such file`, join(folder, manifest.entry));
  }
  const ownSdk = existsSync(join(folder, 'node_modules', SDK_PACKAGE)) ? { path: `node_modules/${SDK_PACKAGE}` } : undefined;
  if (ownSdk !== undefined) {
    throw new ClosureRefusal('plugin-sdk-conflict', `${WHERE}:1: ${join(folder, ownSdk.path)} stands in the plugin's folder, and madarch hands every plugin its own SDK at that name: remove the copy, and import ${SDK_PACKAGE} from the closure madarch builds`, join(folder, ownSdk.path));
  }
  validateImports(folder, entries, manifest.entry);
  if (missing[0] !== undefined) throw missing[0];
  const files = [...own, ...sdkClosureFiles()].sort((left, right) => byCodePoint(left.path, right.path));
  return { folder, manifest, files, hash: closureHashOf(files) };
}

/** The runtime pin this host runs plugins with: the Bun it is built on, by its own version. */
export function hostRuntimeVersion(): string {
  return Bun.version;
}

/** The refusal of a manifest whose interpreter pin this host does not run, or undefined when it does. */
export function interpreterPinProblem(closure: Closure, runtimeVersion = hostRuntimeVersion()): ClosureRefusal | undefined {
  if (closure.manifest.runtime.version === runtimeVersion) return undefined;
  const file = join(closure.folder, PLUGIN_MANIFEST_FILE);
  return new ClosureRefusal('interpreter-pin', `${file}:1: the plugin is pinned to ${closure.manifest.runtime.name} ${closure.manifest.runtime.version}, and this madarch runs ${closure.manifest.runtime.name} ${runtimeVersion}: build the plugin again for this interpreter, or run it under the madarch release that pins the one it names`, file);
}
