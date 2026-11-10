/**
 * What the git reader produces (decision 0034, item 14): the contract of every
 * kind it fills from a repository's tree and history. The manifest declares a
 * kind and binds it to `capability: git`; the engine takes this contract for
 * that kind and builds its table. No name of these kinds stands in the
 * engine's mechanism (`src/graph/one-graph.ts`).
 *
 * The manifest names a kind with its `code.` prefix (`code.file`); the graph's
 * kind is the same name without the prefix (`file`), which is what the reader
 * and the pages have always called it. `manifestKinds` is that one mapping.
 */
import type { EdgeContract, GraphContract, VertexContract } from '../../graph/contract.js';
import { contractOf, generatedTableName } from '../../graph/contract.js';
import type { KindsManifest } from '../../knowledge/kinds.js';

const text = (name: string): { name: string; type: 'text' } => ({ name, type: 'text' });
const bigint = (name: string, nullable = false): { name: string; type: 'bigint'; nullable?: boolean } => ({ name, type: 'bigint', ...(nullable ? { nullable: true } : {}) });
const integer = (name: string, nullable = false): { name: string; type: 'integer'; nullable?: boolean } => ({ name, type: 'integer', ...(nullable ? { nullable: true } : {}) });
const timestamp = (name: string): { name: string; type: 'timestamp'; nullable: true } => ({ name, type: 'timestamp', nullable: true });

/** The generated table of each git kind and dictionary; the display names stay apart (decision 0034, item 14). */
export const GIT_TABLES = {
  repository: generatedTableName('repository', 'vertex'),
  directory: generatedTableName('directory', 'vertex'),
  file: generatedTableName('file', 'vertex'),
  gitlink: generatedTableName('gitlink', 'vertex'),
  commit: generatedTableName('commit', 'vertex'),
  signature: generatedTableName('signature', 'vertex'),
  path: generatedTableName('path', 'dictionary'),
  blob: generatedTableName('blob', 'dictionary'),
  language: generatedTableName('language', 'dictionary'),
  touched: generatedTableName('touched', 'edge'),
  parent_position: generatedTableName('parent', 'edge'),
  history: generatedTableName('history', 'edge'),
  contains: generatedTableName('contains', 'edge'),
  asIs: generatedTableName('as-is', 'edge'),
  authored: generatedTableName('authored', 'edge'),
  renamed_from: generatedTableName('renamed-from', 'edge'),
} as const;

const vertex: readonly VertexContract[] = [
  // A file's key is its repository and its path (A2 of the amendment): the repository named by its own key, the path
  // by its text. Neither is a column of the file's table; both stand once in the vertex's key.
  { name: 'repository', table: GIT_TABLES.repository, fields: [text('name'), text('url'), { name: 'default_branch', type: 'text', nullable: true }], key: ['name'], capability: 'git' },
  { name: 'directory', table: GIT_TABLES.directory, fields: [{ name: 'repository', type: 'text', reference: 'repository' }, text('path')], key: ['repository', 'path'], capability: 'git' },
  { name: 'file', table: GIT_TABLES.file, fields: [{ name: 'repository', type: 'text', reference: 'repository' }, text('path'), { name: 'mode', type: 'text', nullable: true }, bigint('blob_id', true), { name: 'languages', type: 'json', nullable: true }], key: ['repository', 'path'], capability: 'git', indexes: [{ name: 'file_blob', columns: ['blob_id'] }], checks: [`mode IS NULL OR mode IN ('100644', '100755', '120000')`] },
  { name: 'gitlink', table: GIT_TABLES.gitlink, fields: [{ name: 'repository', type: 'text', reference: 'repository' }, text('path'), text('other_repository'), text('commit_hash')], key: ['repository', 'path'], capability: 'git', checks: [`length(commit_hash) = 40`] },
  { name: 'commit', table: GIT_TABLES.commit, fields: [text('hash'), text('algorithm'), { name: 'subject', type: 'text', nullable: true }, timestamp('author_date'), integer('author_offset_min', true), timestamp('commit_date'), integer('commit_offset_min', true)], key: ['hash'], capability: 'git', checks: [`algorithm IN ('sha1', 'sha256')`, `(author_date IS NULL) = (author_offset_min IS NULL)`, `(commit_date IS NULL) = (commit_offset_min IS NULL)`] },
  { name: 'signature', table: GIT_TABLES.signature, fields: [text('name'), text('email')], key: ['name', 'email'], capability: 'git' },
];

const edge: readonly EdgeContract[] = [
  { name: 'contains', table: GIT_TABLES.contains, from: ['repository', 'directory'], to: ['directory', 'file', 'gitlink'], repeats: false, fields: [], capability: 'git' },
  { name: 'as-is', table: GIT_TABLES.asIs, from: ['repository'], to: ['commit'], repeats: false, fields: [], capability: 'git' },
  { name: 'history', table: GIT_TABLES.history, from: ['repository'], to: ['commit'], repeats: false, fields: [integer('walk')], capability: 'git' },
  { name: 'parent', table: GIT_TABLES.parent_position, from: ['commit'], to: ['commit'], repeats: false, fields: [integer('position')], capability: 'git' },
  { name: 'touched', table: GIT_TABLES.touched, from: ['commit'], to: ['file'], repeats: false, fields: [text('change'), bigint('added', true), bigint('removed', true)], capability: 'git', checks: [`change IN ('added', 'modified', 'deleted', 'renamed')`] },
  { name: 'authored', table: GIT_TABLES.authored, from: ['signature'], to: ['commit'], repeats: false, fields: [], capability: 'git' },
  { name: 'renamed-from', table: GIT_TABLES.renamed_from, from: ['file'], to: ['file'], repeats: true, discriminator: 'commit', fields: [], capability: 'git' },
];

const dictionary = [
  { name: 'path', fields: [text('text')], key: ['text'] },
  { name: 'language', fields: [text('name')], key: ['name'] },
  // A text file's bytes are stored once per blob (decision 0035, item 9: only the files producer reads the source), so
  // two files with the same bytes share one row, and a binary file's bytes are kept nowhere.
  { name: 'blob', fields: [text('hash'), text('algorithm'), bigint('bytes'), text('form'), bigint('lines', true), ({ name: 'content', type: 'text', nullable: true } as const)], key: ['hash'], checks: [`(algorithm = 'sha1' AND length(hash) = 40) OR (algorithm = 'sha256' AND length(hash) = 64)`, `(form = 'binary') = (lines IS NULL)`, `(form = 'text') OR (content IS NULL)`] },
];

/** The graph kinds the git capability fills, and the manifest's own names for them. */
export const GIT_CONTRACT: GraphContract = { vertex, edge, dictionary };

/** The wiki's names for the git graph kinds and relations (the contract's, not the engine's). */
export const GIT_WIKI = {
  repository: 'code.repository',
  directory: 'code.directory',
  file: 'code.file',
  commit: 'code.commit',
  author: 'code.author',
  touched: 'code.touched',
  authored: 'code.authored',
  parent: 'code.parent',
  renamedTo: 'code.renamed-to',
  contains: 'code.contains',
} as const;

/** The contract's field names the history readers use. */
export const GIT_FIELDS = {
  change: 'change',
  added: 'added',
  removed: 'removed',
  hash: 'hash',
  effectiveAt: 'effectiveAt',
  committedAt: 'committedAt',
  position: 'position',
  name: 'name',
  walk: 'walk',
} as const;

/** The graph kind names the git reader and the pages use, kept apart from the engine's mechanism. */
export const GIT_KINDS = {
  repository: 'repository',
  directory: 'directory',
  file: 'file',
  gitlink: 'gitlink',
  commit: 'commit',
  signature: 'signature',
  touched: 'touched',
  parent: 'parent',
  history: 'history',
  contains: 'contains',
  asIs: 'as-is',
  authored: 'authored',
  renamedFrom: 'renamed-from',
} as const;

/** The manifest kind name of each graph kind the git reader fills. */
export const GIT_MANIFEST_KINDS: Readonly<Record<string, string>> = {
  'code.repository': 'repository',
  'code.directory': 'directory',
  'code.file': 'file',
  'code.gitlink': 'gitlink',
  'code.commit': 'commit',
  'code.author': 'signature',
};

/** The manifest edge name of each graph edge kind the git reader fills. */
export const GIT_MANIFEST_EDGES: Readonly<Record<string, string>> = {
  'code.contains': 'contains',
  'code.as-is': 'as-is',
  'code.history': 'history',
  'code.parent': 'parent',
  'code.touched': 'touched',
  'code.authored': 'authored',
  'code.renamed-from': 'renamed-from',
};

/**
 * The contract a product's manifest binds to the git reader: the kinds it declares with
 * `capability: git` and the edge kinds it declares the same way, and no table for a kind it does not
 * declare. A product that declares no code kind gets the empty contract and the fill runs no git pass.
 */
export function gitContractOf(manifest: KindsManifest): GraphContract {
  // A manifest that binds any kind to the git capability takes the capability's whole contract: the outputs it
  // produces are one reader's, and a repository's tree has a gitlink even when the product declares no page for it.
  const bound = [...manifest.kinds.values()].some((kind) => kind.capability === 'git') || [...(manifest.edges?.values() ?? [])].some((edge) => edge.capability === 'git');
  if (!bound) return { vertex: [], edge: [], dictionary: [] };
  return contractOf([{ kinds: Object.values(GIT_MANIFEST_KINDS), edges: Object.values(GIT_MANIFEST_EDGES), contract: GIT_CONTRACT }], Object.values(GIT_MANIFEST_KINDS), Object.values(GIT_MANIFEST_EDGES));
}
