/** Repository identity used by the loop's graph-backed views. */
export interface RepositoryRef {
  readonly name: string;
  /** The folder the repository is checked out in. */
  readonly path: string;
}
