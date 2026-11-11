/**
 * The contracts a product's manifest declares, and the table names derived
 * from them (decision 0034, item 14; its amendment of 2026-11-10, A2 and A3): a
 * vertex kind's fields and key, an edge kind's ends, repeat rule and attributes,
 * and a dictionary's values. A capability publishes the contract of what it
 * produces; a manifest that declares a kind filled by it takes that contract. The
 * engine's DDL lives in `adapters/schemas`; this module holds only pure contracts
 * and naming. Every name of a product's kind stands in a contract or a
 * capability's declaration, never in the mechanism.
 *
 * **The key belongs to the vertex.** A contract declares the fields that make its
 * entity unique; they are not columns of the entity's table but the vertex's key
 * (`node.key`), and a producer names an entity by their values. A key field may
 * name another kind: its value is then that entity, named by its kind and key.
 *
 * **An opinion is a row.** The table built for a kind holds one row per opinion
 * about one vertex (or edge): who said it and when, whether it is open, confirmed
 * or closed, the reason and the person of a confirmation, the evidence it rests
 * on, the language of a text value, the opinion a translation came from with that
 * source's digest, the context, and the kind's fields as that producer states
 * them. No field of the kind is a column of the vertex itself.
 *
 * A table is made from a validated name and a fixed type map. A declaration that
 * changes adds a column, replaces a key constraint, or — when a removed or
 * retyped field still holds rows — refuses by naming the kind and the field; it
 * never drops data in silence.
 */
import { createHash } from 'node:crypto';

/** The sort of table a generated name belongs to: a vertex's opinions, an edge's, or a dictionary. */
export type TableSort = 'vertex' | 'edge' | 'dictionary';

/**
 * The table name generated from a kind's name (decision 0034, item 14): the display name is kept apart,
 * the name is a lower-case identifier within PostgreSQL's 63-byte bound, and the digest makes two kinds
 * whose names differ only in punctuation or after the slug's cut keep different tables.
 */
export function generatedTableName(kind: string, sort: TableSort): string {
  const slug = kind.toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 40) || 'kind';
  const digest = createHash('sha256').update(`${sort}\0${kind}`, 'utf8').digest('hex').slice(0, 8);
  const prefix = sort === 'vertex' ? 'k' : sort === 'edge' ? 'e' : 'd';
  return `${prefix}_${slug}_${digest}`;
}

/** The PostgreSQL types a field may map to. */
export type FieldType = 'text' | 'integer' | 'bigint' | 'boolean' | 'timestamp' | 'json';

export interface FieldContract {
  readonly name: string;
  readonly type: FieldType;
  /** Whether the column admits null; a new column of a new table is NOT NULL unless this is true. */
  readonly nullable?: boolean;
  /**
   * The kind a key field names: its value is one entity of that kind, named by the kind and the entity's key values,
   * never by a node id (decision 0034, item 14: "a reference inside a key by the referenced entity's kind and key").
   */
  readonly reference?: string;
}

/** A dictionary holds each value once, with its own natural key. */
export interface DictionaryContract {
  readonly name: string;
  readonly fields: readonly FieldContract[];
  readonly key: readonly string[];
  /** SQL checks a capability states about its values, each a `CHECK (...)` body without the keyword. */
  readonly checks?: readonly string[];
  /** The indexes a capability asks for, beyond the natural key's own. */
  readonly indexes?: readonly { readonly name: string; readonly columns: readonly string[] }[];
}

export interface VertexContract {
  readonly name: string;
  readonly table: string;
  /** Every field the kind declares, its key fields included; the key's own fields are no columns of the table. */
  readonly fields: readonly FieldContract[];
  /** The natural key: fields of this contract, unique per context in `node`. */
  readonly key: readonly string[];
  /** The capability that fills it; a kind is bound to exactly one. */
  readonly capability: string;
  /** SQL checks a capability states about its values, each a `CHECK (...)` body without the keyword. */
  readonly checks?: readonly string[];
  /** The indexes a capability asks for, beyond the natural key's own. */
  readonly indexes?: readonly { readonly name: string; readonly columns: readonly string[] }[];
}

export interface EdgeContract {
  readonly name: string;
  /** The attribute table, when the edge kind has fields. */
  readonly table?: string;
  readonly from: readonly string[];
  readonly to: readonly string[];
  readonly repeats: boolean;
  /** The edge field that tells repeated edges apart. */
  readonly discriminator?: string;
  readonly fields: readonly FieldContract[];
  readonly capability: string;
  /** SQL checks a capability states about its values, each a `CHECK (...)` body without the keyword. */
  readonly checks?: readonly string[];
  /** The indexes a capability asks for, beyond the natural key's own. */
  readonly indexes?: readonly { readonly name: string; readonly columns: readonly string[] }[];
}

export interface GraphContract {
  readonly vertex: readonly VertexContract[];
  readonly edge: readonly EdgeContract[];
  readonly dictionary: readonly DictionaryContract[];
}

/** Where a file value was read: the repository, the commit or content digest, the path and the lines (decision 0035, item 7). */
export interface ClaimEvidenceDraft {
  readonly repository?: string;
  readonly commit?: string;
  readonly path?: string;
  readonly lineStart?: number;
  readonly lineEnd?: number;
}

/** One tagged evidence entry the graph stores (the amendment's point 7): a file place, a conversation, an opinion. */
export type EvidenceEntry =
  | { readonly type: 'file'; readonly repository?: string; readonly commit_or_digest?: string; readonly path?: string; readonly line_start?: number; readonly line_end?: number }
  | { readonly type: 'conversation'; readonly id: string; readonly speaker?: string; readonly at?: string }
  | { readonly type: 'opinion'; readonly id: string };

/** One evidence entry as a draft states it: a plugin's file place, or any tagged entry a producer gives. */
export type EvidenceDraft = ClaimEvidenceDraft | EvidenceEntry;

/** One entity a producer names: its kind and the values of its key's fields (decision 0034, item 14). */
export interface EntityRefDraft {
  readonly kind: string;
  readonly key: Readonly<Record<string, KeyValueDraft>>;
}

/** One key field's value: a text or a number, or the entity a reference field names. */
export type KeyValueDraft = string | number | EntityRefDraft;

/**
 * One vertex a producer publishes: its kind, its natural key, the field values it states, the evidence those values
 * rest on, and the language of a text value. The values of the key's fields are the entity's identity and are not
 * opinions; every other value is. One draft is the producer's whole opinion of the entity: a field it leaves out is a
 * field it has no opinion on.
 */
export interface VertexDraft {
  readonly kind: string;
  /** The entity's natural key values, by the kind's key fields; a reference is its entity's kind and key. */
  readonly key: Readonly<Record<string, KeyValueDraft>>;
  /** The field values this producer states, by field name; a field it did not read is left out. */
  readonly values?: Readonly<Record<string, unknown>>;
  /** Where the values were read, as tagged entries (a file place, a conversation, an opinion). */
  readonly evidence?: readonly EvidenceDraft[];
  /** The language of the text value the opinion states; null for a value that is no text. */
  readonly lang?: string;
  readonly producer: string;
  readonly producerVersion: string;
}

/**
 * One edge a producer states: its ends by kind and key, its discriminator and the opinion that it exists. It stands
 * here, with the other drafts, so a stage may write it without reaching into the store's writer.
 */
export interface EdgeDraft {
  readonly kind: string;
  readonly from: EntityRefDraft;
  readonly to: EntityRefDraft;
  readonly discriminator?: string;
  readonly values?: Readonly<Record<string, unknown>>;
  readonly evidence?: readonly EvidenceDraft[];
  readonly lang?: string;
  readonly producer: string;
  readonly producerVersion: string;
}

/** One edge a producer withdraws: its ends by kind and key, and the discriminator that tells repeats apart. */
export interface EdgeRemovalDraft {
  readonly kind: string;
  readonly from: EntityRefDraft;
  readonly to: EntityRefDraft;
  readonly discriminator?: string;
  readonly producer: string;
}

/** One entity a producer no longer holds: its opinions are closed and it leaves the reads (a removal of a term). */
export interface VertexRemovalDraft {
  readonly kind: string;
  readonly key: Readonly<Record<string, KeyValueDraft>>;
  readonly producer: string;
}

/** The empty contract: a product that declares no kind filled by a capability. */
export const EMPTY_CONTRACT: GraphContract = { vertex: [], edge: [], dictionary: [] };

/** The columns a reader or a writer names without the kind's own: the opinion's own, in the order `OPINION_COLUMNS`. */
export const OPINION_FIELDS = ['id', 'said_by', 'said_at', 'state', 'confirmed_field', 'reason', 'confirmed_with', 'evidence', 'lang', 'translated_from', 'source_digest', 'context_id'] as const;

/** The contract a manifest's declarations make: the capability's own tables for every kind it binds. */
export function contractOf(capabilityContracts: readonly { readonly kinds: readonly string[]; readonly edges: readonly string[]; readonly contract: GraphContract }[], declaredKinds: readonly string[], declaredEdges: readonly string[]): GraphContract {
  const vertex: VertexContract[] = [];
  const edge: EdgeContract[] = [];
  const dictionary: DictionaryContract[] = [];
  for (const entry of capabilityContracts) {
    for (const kind of entry.contract.vertex) if (declaredKinds.includes(kind.name) && entry.kinds.includes(kind.name)) vertex.push(kind);
    for (const one of entry.contract.edge) if (declaredEdges.includes(one.name) && entry.edges.includes(one.name)) edge.push(one);
    for (const one of entry.contract.dictionary) if (declaredKinds.some((kind) => entry.kinds.includes(kind)) && !dictionary.some((held) => held.name === one.name)) dictionary.push(one);
  }
  return { vertex, edge, dictionary };
}
