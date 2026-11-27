/**
 * madarch's own plugins, as the release carries them (decision 0035, items 3 and 4):
 * the plugin folders under `plugins/` of this repository, compiled into the binary as
 * their files' own bytes. `madarch init --template everything` writes their sources into a product, the manifest declares
 * them and the lock records their closure hash, and the hash is computed here from the
 * same bytes — so the closure the release trusts is the closure the product receives,
 * and a plugin folder swapped on disk changes neither.
 *
 * A plugin's closure also holds the dependencies its own folder carries (`node_modules`): the
 * TypeScript parser and the PostgreSQL parser the db-schema plugin reads its literals
 * with are the packages their own authors publish, pinned in the plugin's folder and
 * part of its hash, and the binary carries them as bytes the way it carries the code.
 * They are never written into a product's repository (madarch-64o5.72): a product's git
 * holds the plugin's sources and `madarch/plugins.lock`, and the packages are restored
 * from this binary into the machine store when a plugin runs
 * (`src/plugin/dependency-store.ts`).
 */
import { createHash } from 'node:crypto';
import { closureHashOf, sdkClosureFiles } from './closure.js';
import { isDependencyPath } from './dependency-files.js';

import { pluginFiles } from './bundled-files.js' with { type: 'macro' };

/** One file of a bundled plugin: its text, or the bytes of a file the plugin loads as it is (a WebAssembly module). */
export interface BundledFile {
  readonly path: string;
  readonly content: string | Uint8Array;
}

/** One plugin folder a release carries: its id, its folder in a product, its files and its dependencies. */
export interface BundledPlugin {
  readonly id: string;
  /** The folder the plugin stands in, relative to a product repository, with `/` separators. */
  readonly folder: string;
  /** The plugin's semantic version: the one its manifest and its contract declare. */
  readonly version: string;
  /** The plugin's own files — its code, manifest and contract — in code point order of their paths inside the folder. */
  readonly files: readonly BundledFile[];
  /**
   * The files of the closure its declared dependencies make (`node_modules/...`), in code point order: the machine store
   * holds them, restored there when the plugin runs, and a product's repository never does.
   */
  readonly dependencies: readonly BundledFile[];
  /** The one hash of its closure (`closureOf`), which `madarch/plugins.lock` records. */
  readonly hash: string;
}

/** Preserve binary package assets as bytes; valid UTF-8 stays text for starter readers. */
function contentOf(base64: string): string | Uint8Array {
  const bytes = Buffer.from(base64, 'base64');
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : bytes;
}

/** The sha256 of one file of a closure, from its text or its bytes. */
function sha256Of(content: string | Uint8Array): string {
  return createHash('sha256').update(typeof content === 'string' ? Buffer.from(content, 'utf8') : content).digest('hex');
}

/**
 * One plugin this build carries: its own files and its dependency files separated, and the hash of the closure both make
 * together with the SDK. The files are the macro's reading of `plugins/<id>`, so each id below is named as the literal
 * the build reads.
 */
function bundledPlugin(id: string, version: string, files: readonly { readonly path: string; readonly base64: string }[]): BundledPlugin {
  const all = files.map((file) => ({ path: file.path, content: contentOf(file.base64) }));
  return {
    id,
    folder: `plugins/${id}`,
    version,
    files: all.filter((file) => !isDependencyPath(file.path)),
    dependencies: all.filter((file) => isDependencyPath(file.path)),
    hash: closureHashOfBundled(all),
  };
}

/**
 * The one hash of a bundled plugin's closure: all its files' paths and digests and the SDK's, in code point order, exactly
 * as `closureOf` hashes the folder a product holds beside the dependencies the store restored — a product's copy of these
 * bytes hashes to this value.
 */
function closureHashOfBundled(files: readonly BundledFile[]): string {
  return closureHashOf([
    ...files.map((file) => ({ path: file.path, sha256: sha256Of(file.content) })),
    ...sdkClosureFiles().map((file) => ({ path: file.path, sha256: file.sha256 })),
  ]);
}

/** The plugins this build carries, in code point order of their ids. */
export const BUNDLED_PLUGINS: readonly BundledPlugin[] = [
  bundledPlugin('agent-fill', '1.0.0', pluginFiles('agent-fill')),
  bundledPlugin('db-schema', '1.0.0', pluginFiles('db-schema')),
  bundledPlugin('disk', '1.0.0', pluginFiles('disk')),
  bundledPlugin('git', '1.0.0', pluginFiles('git')),
  bundledPlugin('glossary', '1.0.0', pluginFiles('glossary')),
  bundledPlugin('imports', '1.0.0', pluginFiles('imports')),
  bundledPlugin('test-quarantine', '1.0.0', pluginFiles('test-quarantine')),
];

/** One bundled plugin by its id, or undefined when this release carries none of that name. */
export function bundledPluginById(id: string): BundledPlugin | undefined {
  return BUNDLED_PLUGINS.find((plugin) => plugin.id === id);
}

/** Every bundled plugin's closure hash: what a release trusts without further approval (item 4). */
export function bundledClosureHashes(): readonly string[] {
  return BUNDLED_PLUGINS.map((plugin) => plugin.hash);
}

/**
 * The sources of every bundled plugin, as a product's repository holds them: `plugins/<id>/<file>`, without the files of
 * the `node_modules` its closure holds (madarch-64o5.72). A file whose bytes are not text — a WebAssembly module — answers
 * an empty `content` and its `bytes`, so a reader of the starter set that walks the texts still sees every file's path.
 */
export function bundledPluginFiles(): readonly { readonly path: string; readonly content: string; readonly bytes?: Uint8Array }[] {
  return BUNDLED_PLUGINS.flatMap((plugin) => plugin.files.map((file) => typeof file.content === 'string'
    ? { path: `${plugin.folder}/${file.path}`, content: file.content }
    : { path: `${plugin.folder}/${file.path}`, content: '', bytes: file.content }));
}
