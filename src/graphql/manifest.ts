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
  /** The kind a reference field names. */
  readonly reference?: string;
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
}

/** A product's published manifest: what the schema is derived from, and nothing else. */
export interface PublishedManifest {
  readonly kinds: readonly PublishedKind[];
  readonly edges: readonly PublishedEdge[];
}

function fieldOf(declared: FieldDecl | PluginFieldDecl): PublishedField {
  const nullable = 'required' in declared ? declared.required === false : declared.nullable === true;
  return {
    name: declared.name,
    type: declared.type,
    ...(nullable ? { nullable: true } : {}),
    ...(declared.reference === undefined ? {} : { reference: declared.reference }),
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
    kinds: [...manifest.kinds.values()].map((kind) => ({ name: kind.name, fields: fieldsOf(kind, manifest), key: keyOf(kind, manifest) })),
    edges: [...(manifest.edges?.values() ?? [])].map((edge) => ({
      name: edge.name,
      from: edge.from,
      to: edge.to,
      repeats: edge.repeats,
      ...(edge.discriminator === undefined ? {} : { discriminator: edge.discriminator }),
      fields: edgeFieldsOf(edge, manifest),
    })),
  };
}
