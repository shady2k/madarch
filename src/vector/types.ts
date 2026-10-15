/** Vector search metrics supported by the pgvector adapter. */
export type VectorDistanceMetric = 'l2' | 'cosine' | 'innerProduct';

/** One caller-supplied vector stored for a source and vector space. */
export interface VectorRecord {
  source: string;
  space: string;
  itemId: string;
  vector: readonly number[];
}

/** One exact-nearest-neighbor query. */
export interface VectorSearchInput {
  space: string;
  vector: readonly number[];
  metric: VectorDistanceMetric;
  limit: number;
}

/** A matching vector, identified across a multi-source facade. */
export interface VectorMatch {
  source: string;
  itemId: string;
  distance: number;
}

/** Source-scoped exact vector index over the shared SQL database owner. */
export interface AsyncVectorIndex {
  /** Atomically replaces exactly the selected sources; each must be within this facade's source scope. */
  rebuild(sources: readonly string[], records: readonly VectorRecord[]): Promise<void>;
  /** Searches the facade's source set in one vector space. */
  search(input: VectorSearchInput): Promise<readonly VectorMatch[]>;
  /** Waits for this facade's work and closes only this facade. */
  close(): Promise<void>;
}
