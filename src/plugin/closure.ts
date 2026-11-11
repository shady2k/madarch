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
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { PluginContractFile, type PluginRights } from './protocol.js';
import { SDK_SOURCE } from './sdk-asset.js';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { byCodePoint } from '../model/order.js';

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
    description: Type.Optional(Type.String({ minLength: 1 })),
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

/** A closure that cannot be read, or a snapshot whose bytes moved: the cause, and where. */
export class ClosureRefusal extends Error {
  readonly code: string;
  readonly file: string;
  readonly line: number;
  constructor(code: string, message: string, file: string, line = 1) {
    super(message);
    this.name = 'ClosureRefusal';
    this.code = code;
    this.file = file;
    this.line = line;
  }
}

/** The path of one file, as the closure names it: relative, with `/` separators whatever the platform. */
function closurePath(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

/** Every file under a folder, in code point order of their closure paths; a symlink is refused by name. */
function walk(folder: string): { path: string; file: string }[] {
  const found: { path: string; file: string }[] = [];
  const visit = (dir: string): void => {
    const names = readdirSync(dir, { withFileTypes: true }).map((entry) => entry.name).sort(byCodePoint);
    for (const name of names) {
      const file = join(dir, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) {
        throw new ClosureRefusal('closure-symlink', `${WHERE}:1: ${file} is a symbolic link: a plugin's closure is its own files, and a link that answers elsewhere is not one of them. Replace it with the file it names, or keep the dependency inside the plugin's folder`, file);
      }
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) found.push({ path: closurePath(folder, file), file });
    }
  };
  visit(folder);
  return found.sort((left, right) => byCodePoint(left.path, right.path));
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
export function parsePluginManifest(text: string, file: string): PluginManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ClosureRefusal('plugin-manifest', `${file}:1: ${(error as Error).message}`, file);
  }
  if (!Value.Check(PluginManifest, value)) {
    const first = [...Value.Errors(PluginManifest, value)][0];
    throw new ClosureRefusal('plugin-manifest', `${file}:1: ${first === undefined ? 'the manifest is not a plugin manifest' : `${first.instancePath === '' ? 'the manifest' : first.instancePath.slice(1)}: ${first.message}`}`, file);
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
 * One plugin folder's closure: its manifest, every file under it in code point
 * order of their paths, and the one hash over them. Reading a folder never
 * follows a link and never reads outside it.
 */
export function closureOf(folder: string): Closure {
  const manifest = readPluginManifest(folder);
  const own = walk(folder).map((entry) => {
    const stat = lstatSync(entry.file);
    return { path: entry.path, sha256: digestOf(entry.file), bytes: stat.size, mode: stat.mode & 0o777 };
  });
  if (!own.some((file) => file.path === manifest.entry)) {
    throw new ClosureRefusal('plugin-entry', `${WHERE}:1: ${join(folder, manifest.entry)} is the entry ${PLUGIN_MANIFEST_FILE} names, and the plugin folder holds no such file`, join(folder, manifest.entry));
  }
  const ownSdk = own.find((file) => file.path.startsWith(`node_modules/${SDK_PACKAGE}/`));
  if (ownSdk !== undefined) {
    throw new ClosureRefusal('plugin-sdk-conflict', `${WHERE}:1: ${join(folder, ownSdk.path)} stands in the plugin's folder, and madarch hands every plugin its own SDK at that name: remove the copy, and import ${SDK_PACKAGE} from the closure madarch builds`, join(folder, ownSdk.path));
  }
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
