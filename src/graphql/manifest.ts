import { withManifestContract } from '../graph/manifest-contract.js';
import { withAssertionContract } from '../graph/system-contract.js';
/**
 * The published manifest a GraphQL schema is derived from (decision 0036, section 1): every kind the product
 * takes, with the typed fields its manifest declares and the fields the plugin that fills it declares, and every
 * edge kind with its ends, its repeat rule and its attributes. The manifest reader's own declarations are the
 * source; this module only merges the plugins' contracts into them and keeps the declaration order, so the
 * schema generator sees one complete declaration per kind and per edge and needs no other product file.
 */
import type { FieldType } from '../graph/contract.js';
import type { EdgeDecl, FieldDecl, KindsManifest, KindDecl, PluginFieldDecl } from '../product/manifest/kinds.js';

/** One typed field of a kind or an edge, as the schema shows it. */
export interface PublishedField {
  readonly name: string;
  readonly type: FieldType;
  readonly nullable?: boolean;
}

/** One kind the product takes: its name, its fields and its natural key. */
export interface PublishedKind {
  readonly name: string;
  readonly fields: readonly PublishedField[];
  readonly key: readonly string[];
}

/** One edge kind the product takes: its ends, its repeat rule, its discriminator and its attributes. */
export interface PublishedEdge {
  readonly name: string;
  readonly from: readonly string[];
  readonly to: readonly string[];
  readonly repeats: boolean;
  readonly discriminator?: string;
  readonly fields: readonly PublishedField[];
  /** The words the edge reads as at each end, per interface language, as its declaration states them. */
  readonly labels: Readonly<Record<string, { readonly out: string; readonly in: string }>>;
}

/** One relation the product's catalogue declares: its name and the words at each end, per language. */
export interface PublishedRelation {
  readonly name: string;
  readonly labels: Readonly<Record<string, { readonly out: string; readonly in: string }>>;
}

/** A product's published manifest: what the schema is derived from, and nothing else. */
export interface PublishedManifest {
  readonly kinds: readonly PublishedKind[];
  readonly edges: readonly PublishedEdge[];
  /** The relation vocabulary, for the relations no edge kind carries (a reference field's own relation). */
  readonly relations: readonly PublishedRelation[];
}

function fieldOf(declared: FieldDecl | PluginFieldDecl): PublishedField {
  const nullable = 'required' in declared ? declared.required === false : declared.nullable === true;
  return {
    name: declared.name,
    type: declared.type,
    ...(nullable ? { nullable: true } : {}),
  };
}

/** A kind's fields: its manifest declares some and the plugins that fill it declare the rest; a name is stated once. */
function fieldsOf(kind: KindDecl, manifest: KindsManifest): PublishedField[] {
  const fields: PublishedField[] = [];
  const named = new Set<string>();
  for (const declared of kind.fields ?? []) {
    if (named.has(declared.name)) continue;
    named.add(declared.name);
    fields.push(fieldOf(declared));
  }
  for (const plugin of manifest.plugins?.values() ?? []) {
    for (const output of plugin.contract?.vertices ?? []) {
      if (output.kind !== kind.name) continue;
      for (const declared of output.fields) {
        if (named.has(declared.name)) continue;
        named.add(declared.name);
        fields.push(fieldOf(declared));
      }
    }
  }
  return fields;
}

/** The natural key the plugin that fills a kind declares, for a manifest declaration that leaves its own out. */
function keyOf(kind: KindDecl, manifest: KindsManifest): readonly string[] {
  if (kind.key !== undefined) return kind.key;
  for (const plugin of manifest.plugins?.values() ?? []) {
    for (const output of plugin.contract?.vertices ?? []) if (output.kind === kind.name && output.key.length > 0) return output.key;
  }
  return [];
}

/** An edge's attributes: the manifest's own typed fields and the arrays the filling plugin's contract declares, each name once. */
function edgeFieldsOf(edge: EdgeDecl, manifest: KindsManifest): PublishedField[] {
  const fields: PublishedField[] = [];
  const named = new Set<string>();
  for (const declared of edge.fields) {
    if (named.has(declared.name)) continue;
    named.add(declared.name);
    fields.push(fieldOf(declared));
  }
  for (const plugin of manifest.plugins?.values() ?? []) {
    for (const output of plugin.contract?.edges ?? []) {
      if (output.kind !== edge.name) continue;
      for (const declared of output.fields ?? []) {
        if (named.has(declared.name)) continue;
        named.add(declared.name);
        fields.push(fieldOf(declared));
      }
    }
  }
  return fields;
}

/**
 * The published manifest of a product's manifest: every kind it takes with its complete contract, and every
 * edge it declares. A plugin's contract supplies the fields the manifest binds, never a kind the manifest does
 * not take, so a plugin whose kinds the product holds none of adds nothing here.
 */
export function publishedManifestOf(manifest: KindsManifest): PublishedManifest {
  return {
    kinds: [...[...manifest.kinds.values()].map((kind) => ({ name: kind.name, fields: fieldsOf(kind, manifest), key: keyOf(kind, manifest) })), ...withAssertionContract(withManifestContract({ vertex: [], edge: [], dictionary: [] })).vertex.filter((kind) => !manifest.kinds.has(kind.name)).map((kind) => ({ name: kind.name, fields: kind.fields, key: kind.key }))],
    edges: [...(manifest.edges?.values() ?? [])].map((edge) => ({
      name: edge.name,
      from: edge.from,
      to: edge.to,
      repeats: edge.repeats,
      ...(edge.discriminator === undefined ? {} : { discriminator: edge.discriminator }),
      fields: edgeFieldsOf(edge, manifest),
      labels: { ...edge.labels },
    })),
    relations: [...(manifest.catalog?.schema.relationLabels ?? new Map()).entries()]
      .map(([name, labels]) => ({ name, labels }))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
  };
}

/**
 * The words a relation reads as at one end, from the published catalogue alone: an edge kind's own `labels`, or the
 * relation vocabulary's for a relation no edge kind carries. Empty when the catalogue names none — a renderer prints no
 * key in its place (owner's decision, 2026-11-15).
 */
export function publishedRelationWords(published: PublishedManifest, name: string, language: string, inverse: boolean): string {
  const labels = published.edges.find((one) => one.name === name)?.labels ?? published.relations.find((one) => one.name === name)?.labels;
  const words = labels?.[language] ?? labels?.[language.split('-')[0]!];
  return words?.[inverse ? 'in' : 'out'] ?? '';
}
