/**
 * madarch's own plugins, as the release carries them (decision 0035, items 3 and 4):
 * the plugin folders under `plugins/` of this repository, compiled into the binary as
 * their files' own text. `madarch new` writes them into a product, the manifest declares
 * them and the lock records their closure hash, and the hash is computed here from the
 * same texts — so the closure the release trusts is the closure the product receives,
 * and a plugin folder swapped on disk changes neither.
 */
import { createHash } from 'node:crypto';
import { closureHashOf, sdkClosureFiles } from './closure.js';

// @ts-expect-error Bun's text loader answers the file's text as the default export; TypeScript has no such module.
import glossaryMain from '../../plugins/glossary/main.ts' with { type: 'text' };
import glossaryContract from '../../plugins/glossary/contract.json' with { type: 'text' };
import glossaryManifest from '../../plugins/glossary/plugin.json' with { type: 'text' };

/** One plugin folder a release carries: its id, its folder in a product, and its files in closure order. */
export interface BundledPlugin {
  readonly id: string;
  /** The folder the plugin stands in, relative to a product repository, with `/` separators. */
  readonly folder: string;
  /** The plugin's semantic version: the one its manifest and its contract declare. */
  readonly version: string;
  /** The files that make its closure, in code point order of their paths inside the folder. */
  readonly files: readonly { readonly path: string; readonly content: string }[];
}

/** The plugins this build carries, in code point order of their ids. */
export const BUNDLED_PLUGINS: readonly BundledPlugin[] = [
  {
    id: 'glossary',
    folder: 'plugins/glossary',
    version: '1.0.0',
    files: [
      { path: 'contract.json', content: glossaryContract as unknown as string },
      { path: 'main.ts', content: glossaryMain as string },
      { path: 'plugin.json', content: glossaryManifest as unknown as string },
    ],
  },
];

/** The sha256 of one text, as the closure reads a file. */
function sha256Of(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
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

/** The files of every bundled plugin, as a product's repository holds them: `plugins/<id>/<file>`. */
export function bundledPluginFiles(): readonly { readonly path: string; readonly content: string }[] {
  return BUNDLED_PLUGINS.flatMap((plugin) => plugin.files.map((file) => ({ path: `${plugin.folder}/${file.path}`, content: file.content })));
}
