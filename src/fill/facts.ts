/**
 * The few fact-vocabulary values the fill still uses (decision 0034): a repository path, the
 * repository forms, a coverage gap, and the rank fields a read's membership leaves out. The
 * rest of the old fact schema is gone with its store; the one graph's kinds are the manifest's.
 */
const repositoryPathBrand = Symbol('repository-path');

/** A path relative to a repository's root, in its portable form. */
export type RepositoryPath = string & { readonly [repositoryPathBrand]: 'repository-path' };

function repositoryPathProblem(value: string): string | undefined {
  if (value === '') return 'a repository path is empty: a file has a path from the repository\'s root';
  if (value.startsWith('/')) return `${JSON.stringify(value)} is an absolute path: a repository path starts at the repository's root`;
  if (/^[A-Za-z]:[\\/]/u.test(value)) return `${JSON.stringify(value)} is a path of a machine's drive: a repository path starts at the repository's root`;
  const legs = value.split('/');
  if (legs.at(-1) === '') return `${JSON.stringify(value)} ends with a separator: a repository path names a file or a folder`;
  for (const leg of legs) {
    if (leg === '') return `${JSON.stringify(value)} holds an empty leg: a repository path names one folder after another`;
    if (leg === '.') return `${JSON.stringify(value)} holds a "." leg: a repository path stands relative to the repository's root already`;
    if (leg === '..') return `${JSON.stringify(value)} climbs out of the repository: a repository path never goes above the root`;
  }
  return undefined;
}

/** Reads a repository path, folding a machine separator and refusing what is not portable. */
export function repositoryPath(value: string): RepositoryPath {
  if (typeof value !== 'string') throw new Error(`${JSON.stringify(value)} is no path: a repository path is text`);
  const folded = value.replace(/\\/gu, '/').replace(/^\.\//u, '');
  const problem = repositoryPathProblem(folded);
  if (problem !== undefined) throw new Error(problem);
  return folded as RepositoryPath;
}

/** Whether a value is a repository path, without throwing. */
export function isRepositoryPath(value: string): value is RepositoryPath {
  return repositoryPathProblem(value.replace(/\\/gu, '/').replace(/^\.\//u, '')) === undefined;
}

/** The forms a repository may be pinned as. */
export const REPOSITORY_FORMS = ['code', 'product'] as const;
export type RepositoryForm = (typeof REPOSITORY_FORMS)[number];

/** Why a scope could not be read completely. */
export const COVERAGE_GAP_REASONS = ['budget', 'error', 'inaccessible', 'too-large', 'unsupported'] as const;
export type CoverageGapReason = (typeof COVERAGE_GAP_REASONS)[number];

/** One thing a scope's coverage could not read, and why. */
export interface CoverageGap {
  readonly what: string;
  readonly reason: CoverageGapReason;
}

/** The fields a fact's value holds as one measurement of the whole graph rather than of the node. */
export const FACT_RANK_FIELDS: Readonly<Record<string, readonly string[]>> = {
  file: ['importance'],
  symbol: ['importance'],
};
