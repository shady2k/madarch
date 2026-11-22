/** Presentation vocabulary for ordinary repository plugins; no native storage contract. */
/** The graph kind names the git reader reads, kept apart from the engine's mechanism. */
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

