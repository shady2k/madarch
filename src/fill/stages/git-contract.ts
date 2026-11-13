/** Presentation vocabulary for ordinary repository plugins; no native storage contract. */
import { generatedTableName } from '../../graph/contract.js';

export const GIT_TABLES = {
  repository: generatedTableName('code.repository', 'vertex'),
  directory: generatedTableName('code.directory', 'vertex'),
  file: generatedTableName('code.file', 'vertex'),
  gitlink: generatedTableName('code.gitlink', 'vertex'),
  commit: generatedTableName('code.commit', 'vertex'),
  signature: generatedTableName('code.author', 'vertex'),
  touched: generatedTableName('code.touched', 'edge'),
  parent_position: generatedTableName('code.parent', 'edge'),
  history: generatedTableName('code.history', 'edge'),
  contains: generatedTableName('code.contains', 'edge'),
  asIs: generatedTableName('code.as-is', 'edge'),
  authored: generatedTableName('code.authored', 'edge'),
  renamed_from: generatedTableName('code.renamed-from', 'edge'),
} as const;

export const GIT_WIKI = {
  repository: 'code.repository',
  directory: 'code.directory',
  file: 'code.file',
  commit: 'code.commit',
  author: 'code.author',
  touched: 'code.touched',
  authored: 'code.authored',
  parent: 'code.parent',
  renamedFrom: 'code.renamed-from',
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
  repository: 'code.repository',
  directory: 'code.directory',
  file: 'code.file',
  gitlink: 'code.gitlink',
  commit: 'code.commit',
  signature: 'code.author',
  touched: 'code.touched',
  parent: 'code.parent',
  history: 'code.history',
  contains: 'code.contains',
  asIs: 'code.as-is',
  authored: 'code.authored',
  renamedFrom: 'code.renamed-from',
} as const;

