/**
 * madarch's own plugins, as the release carries them (decision 0035, items 3 and 4):
 * the plugin folders under `plugins/` of this repository, compiled into the binary as
 * their files' own bytes. `madarch new` writes them into a product, the manifest declares
 * them and the lock records their closure hash, and the hash is computed here from the
 * same bytes — so the closure the release trusts is the closure the product receives,
 * and a plugin folder swapped on disk changes neither.
 *
 * A plugin's closure holds the dependencies its folder carries (`node_modules`): the
 * TypeScript parser and the PostgreSQL parser the db-schema plugin reads its literals
 * with are the packages their own authors publish, pinned in the plugin's folder and
 * part of its hash, and the binary carries them as bytes the way it carries the code.
 */
import { createHash } from 'node:crypto';
import { closureHashOf, sdkClosureFiles } from './closure.js';

import { pluginFiles } from './bundled-files.js' with { type: 'macro' };

/** One file of a bundled plugin: its text, or the bytes of a file the plugin loads as it is (a WebAssembly module). */
export interface BundledFile {
  readonly path: string;
  readonly content: string | Uint8Array;
}

/** One plugin folder a release carries: its id, its folder in a product, and its files in closure order. */
export interface BundledPlugin {
  readonly id: string;
  /** The folder the plugin stands in, relative to a product repository, with `/` separators. */
  readonly folder: string;
  /** The plugin's semantic version: the one its manifest and its contract declare. */
  readonly version: string;
  /** The files that make its closure, in code point order of their paths inside the folder. */
  readonly files: readonly BundledFile[];
}

/** Preserve binary package assets as bytes; valid UTF-8 stays text for starter readers. */
function contentOf(base64: string): string | Uint8Array {
  const bytes = Buffer.from(base64, 'base64');
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : bytes;
}

/** The plugins this build carries, in code point order of their ids. */
export const BUNDLED_PLUGINS: readonly BundledPlugin[] = [
  {
    id: 'agent-fill',
    folder: 'plugins/agent-fill',
    version: '1.0.0',
    files: [
      { path: 'contract.json', content: agentFillContract as unknown as string },
      { path: 'main.ts', content: agentFillMain as string },
      { path: 'plugin.json', content: agentFillManifest as unknown as string },
      { path: 'prompt.md', content: agentFillPrompt as string },
    ],
  },
  {
    id: 'db-schema',
    folder: 'plugins/db-schema',
    version: '1.0.0',
    files: pluginFiles('db-schema').map((file) => ({ path: file.path, content: contentOf(file.base64) })),
  },
  {
    id: 'glossary',
    folder: 'plugins/glossary',
    version: '1.0.0',
    files: pluginFiles('glossary').map((file) => ({ path: file.path, content: contentOf(file.base64) })),
  },
];

/** The sha256 of one file of a closure, from its text or its bytes. */
function sha256Of(content: string | Uint8Array): string {
  return createHash('sha256').update(typeof content === 'string' ? Buffer.from(content, 'utf8') : content).digest('hex');
}

/**
 * The one hash of a bundled plugin's closure: its files' paths and digests and the SDK's, in code point order, exactly
 * as `closureOf` hashes the folder a product holds — a product's copy of these bytes hashes to this value.
 */
export function bundledClosureHash(plugin: BundledPlugin): string {
  const files = [
    ...plugin.files.map((file) => ({ path: file.path, sha256: sha256Of(file.content) })),
    ...sdkClosureFiles().map((file) => ({ path: file.path, sha256: file.sha256 })),
  ];
  return closureHashOf(files);
}

/** Every bundled plugin's closure hash: what a release trusts without further approval (item 4). */
export function bundledClosureHashes(): readonly string[] {
  return BUNDLED_PLUGINS.map(bundledClosureHash);
}

/**
 * The files of every bundled plugin, as a product's repository holds them: `plugins/<id>/<file>`. A file whose bytes are
 * not text — a WebAssembly module — answers an empty `content` and its `bytes`, so a reader of the starter set that walks
 * the texts still sees every file's path.
 */
export function bundledPluginFiles(): readonly { readonly path: string; readonly content: string; readonly bytes?: Uint8Array }[] {
  return BUNDLED_PLUGINS.flatMap((plugin) => plugin.files.map((file) => typeof file.content === 'string'
    ? { path: `${plugin.folder}/${file.path}`, content: file.content }
    : { path: `${plugin.folder}/${file.path}`, content: '', bytes: file.content }));
}
