/**
 * What a deterministic extractor returns (decision 0028): plain records keyed by
 * their logical identity, with no database, no time and no run in them. A
 * driver gives them time (the commit's effective date), identity rows and
 * versions when it writes the graph; an extractor only reads bytes and says
 * what they declare, so the same bytes give the same records anywhere.
 *
 * Kinds and relation types here are the engine's own extractor schema, under
 * the `code.` prefix (0028, "two namespaces"); a product's kinds come from its
 * registry and are never named by an extractor.
 */

/** A kind or relation type of the extractor schema: always under `code.`. */
export type SchemaKey = `code.${string}`;

/**
 * A node's logical key: the same thing gives the same key in every run, and the
 * key names no run, date or database id. Write it as `<kind>:<stable parts>`,
 * for example `code.file:services/orders/go.mod` or
 * `code.table:orders/public.orders`; parts are joined with `/` or `#` and never
 * hold a space.
 */
export type NodeKey = string;

/** Where in a file a record was read: half-open byte offsets, 1-based lines. */
export interface SourceSpan {
  /** The repository path, `/`-separated, relative to the repository root. */
  readonly path: string;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly lineStart: number;
  readonly lineEnd: number;
}

/** A property value: JSON, kept small; file bytes are never copied into one. */
export type PropertyValue = string | number | boolean | null | readonly PropertyValue[] | { readonly [key: string]: PropertyValue };

export interface ExtractedNode {
  readonly key: NodeKey;
  readonly kind: SchemaKey;
  /** What a reader sees as the node's name. */
  readonly label: string;
  readonly properties: { readonly [key: string]: PropertyValue };
  /** Where the node is declared, when it is declared in one place. */
  readonly span?: SourceSpan;
}

export interface ExtractedEdge {
  readonly type: SchemaKey;
  readonly from: NodeKey;
  readonly to: NodeKey;
  /**
   * Tells apart parallel edges of one type between the same two nodes (two
   * foreign keys between the same tables, say); empty when they cannot exist.
   */
  readonly discriminator: string;
  readonly properties: { readonly [key: string]: PropertyValue };
  /** The site the edge was read at, for a positioned edge (an occurrence). */
  readonly span?: SourceSpan;
}

/**
 * What could not be read, said rather than left silent: the path, why, and
 * what was skipped. An extractor never drops a file without one.
 */
export interface ExtractionGap {
  readonly path: string;
  readonly reason: string;
}

export interface Extraction {
  /** The extractor that produced it, e.g. `code.extract.contracts`. */
  readonly producer: SchemaKey;
  readonly nodes: readonly ExtractedNode[];
  readonly edges: readonly ExtractedEdge[];
  readonly gaps: readonly ExtractionGap[];
}

/**
 * One repository tree as an extractor reads it: its paths in code point order
 * and the bytes of each. A test builds one over a folder; the driver over a
 * commit.
 */
export interface TreeReader {
  readonly paths: readonly string[];
  read(path: string): Uint8Array;
}
