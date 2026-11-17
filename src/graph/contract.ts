/** Typed graph declarations and identity-only references (0039 items 1,2,25). */
import { createHash } from 'node:crypto';
import type { JsonSchema, ValueTypes } from './value-types.js';

/** Entity kinds are the declared vertex kinds, shared by reads and endpoint validation. */
export function entityKindNames(kinds: Iterable<{ readonly name: string }>): string[] {
  return Array.from(kinds, kind => kind.name);
}

/** A wildcard permits every declared Entity kind, not arbitrary storage nodes. */
export function endpointKindNames(ends: readonly string[], kinds: Iterable<{ readonly name: string }>): readonly string[] {
  return ends.includes('any') ? entityKindNames(kinds) : ends;
}

/** Typed assertion value storage, decision 0039 item 25. */
export function assertionValueTableName(kind: string, sort: 'vertex' | 'edge', property: string): string {
  return `a_${createHash('sha256').update(`${sort}\0${kind}\0${property}`, 'utf8').digest('hex').slice(0, 32)}`;
}


/** The sort of table a generated name belongs to: a vertex's opinions, an edge's, or a dictionary. */
export type TableSort = 'vertex' | 'edge' | 'dictionary';

/**
 * The table name generated from a kind's name (decision 0034, item 14): the display name is kept apart,
 * the name is a lower-case identifier within PostgreSQL's 63-byte bound, and the digest makes two kinds
 * whose names differ only in punctuation or after the slug's cut keep different tables.
 */
export function generatedTableName(kind: string, sort: TableSort): string {
  const slug = [...kind.toLowerCase()].map(char => 'abcdefghijklmnopqrstuvwxyz0123456789'.includes(char) ? char : '_').join('').slice(0, 40) || 'kind';
  const digest = createHash('sha256').update(`${sort}\0${kind}`, 'utf8').digest('hex').slice(0, 8);
  const prefix = sort === 'vertex' ? 'k' : sort === 'edge' ? 'e' : 'd';
  return `${prefix}_${slug}_${digest}`;
}

/** The PostgreSQL types a field may map to. */
export const FIELD_TYPES = ['text', 'integer', 'bigint', 'boolean', 'timestamp', 'json'] as const;
export type FieldType = typeof FIELD_TYPES[number];
export function fieldTypeOf(value: unknown): FieldType | undefined {
  return FIELD_TYPES.find(type => type === value);
}

export interface FieldContract {
  readonly name: string;
  readonly type: FieldType;
  readonly valueType?: string;
  readonly schema?: JsonSchema;
  /** Whether the column admits null; a new column of a new table is NOT NULL unless this is true. */
  readonly nullable?: boolean;
  /**
   * Whether a read names its subject by this field's value (`madarch-64o5.74`): the generator indexes the
   * field's value table, so a subject is found by its name through the assertions that state it and never by
   * reading every subject of the kind.
   */
  readonly lookup?: boolean;
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

export type Cardinality = 'one' | 'optional' | 'many' | 'some';
export interface EdgeCardinality { readonly from: Cardinality; readonly to: Cardinality }
export interface EdgeWords { readonly [language: string]: { readonly out: string; readonly in: string }; readonly en: { readonly out: string; readonly in: string }; readonly ru: { readonly out: string; readonly in: string } }
export interface KeyEdgeContract { readonly role: string; readonly edge: string; readonly direction: 'from' | 'to'; readonly onDelete: 'restrict' | 'cascade' }

export interface VertexContract {
  readonly evidence?: {readonly immutable:true;readonly digestField?:string;readonly contentField?:string;readonly digestAlgorithm?:'sha256'};
  readonly contractUid?: string;
  readonly identity?: {readonly namespace: string; readonly origin: readonly string[]};
  readonly keyEdges?: readonly KeyEdgeContract[];
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
  readonly contractUid?: string;
  readonly cardinality: EdgeCardinality;
  readonly labels: EdgeWords;
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
  readonly valueTypes?: ValueTypes;
  readonly vertex: readonly VertexContract[];
  readonly edge: readonly EdgeContract[];
  readonly dictionary: readonly DictionaryContract[];
}

/** Evidence is graph lineage, never a hidden string identity (0039.14,31). */
export interface EvidenceDraft {
 readonly target: EntityRefDraft;
 readonly relation?: string;
 readonly locator?: Readonly<Record<string, unknown>>;
}
export type EvidenceEntry = EvidenceDraft;

/** One entity a producer names: its kind and the values of its key's fields (decision 0034, item 14). */
export interface EntityRefDraft {
  readonly keyEdges?: Readonly<Record<string, EntityRefDraft>>;
  readonly kind: string;
  readonly key: Readonly<Record<string, KeyValueDraft>>;
  /** Stable identity; references may resolve an existing entity by uid with an empty key. Births still require the declared key. */
  readonly uid?: string;
}

/** One key field's value: text, a number, a boolean, or the entity a reference field names. */
export type KeyValueDraft = string | number | boolean;

/**
 * One vertex a producer publishes: its kind, its natural key, the field values it states, the evidence those values
 * rest on, and the language of a text value. The values of the key's fields are the entity's identity and are not
 * opinions; every other value is. One draft is the producer's whole opinion of the entity: a field it leaves out is a
 * field it has no opinion on.
 */
export interface VertexDraft {
  readonly validFrom?: string;
  readonly validTo?: string | null;
  readonly keyEdges?: Readonly<Record<string, EntityRefDraft>>;
  /** Replace only these fields; fields outside the scope keep their prior opinions. */
  readonly selectedFields?: readonly string[];
  /** The stable uid of a keyless entity written again; absent, the writer makes a new one. */
  readonly uid?: string;
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
  readonly validFrom?: string;
  readonly validTo?: string | null;
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
  readonly keyEdges?: Readonly<Record<string, EntityRefDraft>>;
  /** Withdraw only these fields, preserving the producer's other fields. */
  readonly selectedFields?: readonly string[];
  readonly kind: string;
  readonly key: Readonly<Record<string, KeyValueDraft>>;
  readonly producer: string;
  /** A keyless entity is withdrawn by its persistent random uid. */
  readonly uid?: string;
  /** An explicit person action withdraws the entity, not only one producer's opinion. */
  readonly withdrawAll?: boolean;
}

/** The empty contract: a product that declares no kind filled by a capability. */
export const EMPTY_CONTRACT: GraphContract = { vertex: [], edge: [], dictionary: [] };

/** Immutable canonical contract revision bound by the authenticated operation host. */
export function graphContractVersion(contract:GraphContract):string{
 const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value!==null&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical((value as Record<string,unknown>)[key])])):value;
 return createHash('sha256').update(JSON.stringify(canonical(contract))).digest('hex');
}
