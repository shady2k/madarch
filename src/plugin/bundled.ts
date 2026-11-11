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
import { readFileSync } from 'node:fs';
import { closureHashOf, sdkClosureFiles } from './closure.js';

// @ts-expect-error Bun's text loader answers the file's text as the default export; TypeScript has no such module.
import glossaryMain from '../../plugins/glossary/main.ts' with { type: 'text' };
import glossaryContract from '../../plugins/glossary/contract.json' with { type: 'text' };
import glossaryManifest from '../../plugins/glossary/plugin.json' with { type: 'text' };
// @ts-expect-error Bun's text loader answers the file's text as the default export; TypeScript has no such module.
import dbSchemaMain from '../../plugins/db-schema/main.ts' with { type: 'text' };
// @ts-expect-error Bun's text loader answers the file's text as the default export; TypeScript has no such module.
import dbSchemaAmbient from '../../plugins/db-schema/ambient.d.ts' with { type: 'text' };
import dbSchemaContract from '../../plugins/db-schema/contract.json' with { type: 'text' };
import dbSchemaManifest from '../../plugins/db-schema/plugin.json' with { type: 'text' };
import dbSchemaPostgresWasm from '../../plugins/db-schema/node_modules/libpg-query/wasm/libpg-query.wasm' with { type: 'file' };
// @ts-expect-error Bun's text loader answers the file's text as the default export; TypeScript has no such module.
import dbSchemaPostgresGlue from '../../plugins/db-schema/node_modules/libpg-query/wasm/libpg-query.js' with { type: 'text' };
import dbSchemaPostgresIndex from '../../plugins/db-schema/node_modules/libpg-query/wasm/index.js' with { type: 'text' };
import dbSchemaPostgresPackage from '../../plugins/db-schema/node_modules/libpg-query/package.json' with { type: 'text' };
// @ts-expect-error Bun's text loader answers the file's text as the default export; TypeScript has no such module.
import dbSchemaPostgresLicense from '../../plugins/db-schema/node_modules/libpg-query/LICENSE' with { type: 'text' };
import dbSchemaTypesIndex from '../../plugins/db-schema/node_modules/@pgsql/types/index.js' with { type: 'text' };
import dbSchemaTypesValues from '../../plugins/db-schema/node_modules/@pgsql/types/types.js' with { type: 'text' };
import dbSchemaTypesEnums from '../../plugins/db-schema/node_modules/@pgsql/types/enums.js' with { type: 'text' };
import dbSchemaTypesPackage from '../../plugins/db-schema/node_modules/@pgsql/types/package.json' with { type: 'text' };
// @ts-expect-error Bun's text loader answers the file's text as the default export; TypeScript has no such module.
import dbSchemaTypesLicense from '../../plugins/db-schema/node_modules/@pgsql/types/LICENSE' with { type: 'text' };
// @ts-expect-error Bun's text loader answers the file's text as the default export; TypeScript has no such module.
import dbSchemaParserIndex from '../../plugins/db-schema/node_modules/@babel/parser/lib/index.js' with { type: 'text' };
import dbSchemaParserPackage from '../../plugins/db-schema/node_modules/@babel/parser/package.json' with { type: 'text' };
// @ts-expect-error Bun's text loader answers the file's text as the default export; TypeScript has no such module.
import dbSchemaParserLicense from '../../plugins/db-schema/node_modules/@babel/parser/LICENSE' with { type: 'text' };

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

/** The plugins this build carries, in code point order of their ids. */
export const BUNDLED_PLUGINS: readonly BundledPlugin[] = [
  {
    id: 'db-schema',
    folder: 'plugins/db-schema',
    version: '1.0.0',
    files: [
      { path: 'ambient.d.ts', content: dbSchemaAmbient as unknown as string },
      { path: 'contract.json', content: dbSchemaContract as unknown as string },
      { path: 'main.ts', content: dbSchemaMain as string },
      { path: 'node_modules/@babel/parser/LICENSE', content: dbSchemaParserLicense as unknown as string },
      { path: 'node_modules/@babel/parser/lib/index.js', content: dbSchemaParserIndex as unknown as string },
      { path: 'node_modules/@babel/parser/package.json', content: dbSchemaParserPackage as unknown as string },
      { path: 'node_modules/@pgsql/types/LICENSE', content: dbSchemaTypesLicense as unknown as string },
      { path: 'node_modules/@pgsql/types/enums.js', content: dbSchemaTypesEnums as unknown as string },
      { path: 'node_modules/@pgsql/types/index.js', content: dbSchemaTypesIndex as unknown as string },
      { path: 'node_modules/@pgsql/types/package.json', content: dbSchemaTypesPackage as unknown as string },
      { path: 'node_modules/@pgsql/types/types.js', content: dbSchemaTypesValues as unknown as string },
      { path: 'node_modules/libpg-query/LICENSE', content: dbSchemaPostgresLicense as unknown as string },
      { path: 'node_modules/libpg-query/package.json', content: dbSchemaPostgresPackage as unknown as string },
      { path: 'node_modules/libpg-query/wasm/index.js', content: dbSchemaPostgresIndex as unknown as string },
      { path: 'node_modules/libpg-query/wasm/libpg-query.js', content: dbSchemaPostgresGlue as unknown as string },
      { path: 'node_modules/libpg-query/wasm/libpg-query.wasm', content: readFileSync(dbSchemaPostgresWasm as unknown as string) },
      { path: 'plugin.json', content: dbSchemaManifest as unknown as string },
    ],
  },
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
