import { pageTemplateKind, type KindsManifest } from '../product/manifest/kinds.js';
import { CATALOG_RAW_KINDS } from './catalog-starter.js';
import { generatedTableName, type FieldContract, type VertexContract } from '../graph/contract.js';

/** The roles the catalogue gives the kind a product's page templates are published as. */
export interface CataloguePageTemplate {
  /** The catalogue kind's name, the kind its entities are written as. */
  readonly name: string;
  /** The role naming a template's name. */
  readonly nameField: string;
  /** The role naming a template's body: the declared text field that holds it. */
  readonly bodyField: string;
  /** The role naming the file the template was read from, when the catalogue declares one. */
  readonly pathField?: string;
  /** The kind's table, as the graph contract states it: the columns its templates are written in. */
  readonly vertex: VertexContract;
}

/** The template kind and field roles shared by publication, graph reads and the schema. */
export function productPageTemplate(manifest: KindsManifest): Omit<CataloguePageTemplate, 'vertex'> & { readonly fallback?: VertexContract } {
  const kind = pageTemplateKind(manifest);
  const catalogue = cataloguePageTemplate();
  if (kind === undefined) return { ...catalogue, fallback: catalogue.vertex };
  return {
    name: kind.name,
    nameField: kind.pageTemplate!['name'] ?? catalogue.nameField,
    bodyField: kind.pageTemplate!['body'] ?? catalogue.bodyField,
    ...((kind.pageTemplate!['path'] ?? catalogue.pathField) === undefined ? {} : { pathField: kind.pageTemplate!['path'] ?? catalogue.pathField }),
  };
}

let held: CataloguePageTemplate | undefined;

/**
 * The catalogue's own declaration of the page-template kind (the owner's decision of 2026-11-15): the catalogue says how a
 * product's templates are held as entities, and a product whose manifest declares no kind of its own publishes them into
 * this one, so a product made before the decision still serves the templates it holds. The engine finds the kind by the
 * role the catalogue file declares, never by its name.
 */
export function cataloguePageTemplate(): CataloguePageTemplate {
  if (held !== undefined) return held;
  for (const [name, raw] of Object.entries(CATALOG_RAW_KINDS)) {
    const role = raw['page-template'];
    if (role === null || typeof role !== 'object' || Array.isArray(role)) continue;
    const roles = role as Record<string, unknown>;
    const nameField = roles['name'];
    const bodyField = roles['body'];
    if (typeof nameField !== 'string' || typeof bodyField !== 'string') {
      throw new Error(`catalog/${name}.yaml:1: the catalogue's "page-template" role names a "name" and a "body" field, got ${JSON.stringify(role)}`);
    }
    const pathField = typeof roles['path'] === 'string' ? roles['path'] : undefined;
    const key = Array.isArray(raw['key']) && raw['key'].every((one) => typeof one === 'string') ? raw['key'] as string[] : [nameField];
    const fields: FieldContract[] = [];
    for (const field of Array.isArray(raw['fields']) ? raw['fields'] as Record<string, unknown>[] : []) {
      if (typeof field?.['name'] !== 'string' || typeof field['type'] !== 'string') continue;
      fields.push({ name: field['name'], type: field['type'] as FieldContract['type'], ...(field['nullable'] === true ? { nullable: true } : {}) });
    }
    for (const one of [nameField, bodyField, ...(pathField === undefined ? [] : [pathField])]) {
      if (!fields.some((field) => field.name === one)) fields.push({ name: one, type: 'text' });
    }
    held = {
      name,
      nameField,
      bodyField,
      ...(pathField === undefined ? {} : { pathField }),
      vertex: { name, table: generatedTableName(name, 'vertex'), fields, key, capability: 'agent' },
    };
    return held;
  }
  throw new Error('catalog: none of the catalogue kinds declares a "page-template" role: a product\'s templates have no kind to be held as');
}
