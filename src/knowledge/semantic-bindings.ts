/** Explicit semantic role projections. No role or field is inferred from catalogue names. */
import type { KindsManifest, SemanticBinding } from '../product/manifest/kinds.js';
import type { GraphEntity, GraphReader } from './graph-read.js';
import { checkRoleProperties, semanticRoleOptionalFields } from '../model/semantic-role-protocol.js';

export type SemanticGraph = Pick<GraphReader, 'list'> & Partial<Pick<GraphReader, 'relationEdges'>>;

export function semanticBinding(manifest: Pick<KindsManifest, 'file' | 'semanticBindings'>, role: string): SemanticBinding {
  const binding = manifest.semanticBindings?.get(role);
  if (binding === undefined) throw new Error(`${manifest.file}:1: semantic role "${role}" is required by this operation; declare semantic-bindings.${role}`);
  return binding;
}

/**
 * What a caller projects of a role: the role's fields alone (`edges: false`) when it reads no edge slot. A page that
 * lists entities reads every edge kind the role declares, and a whole edge kind is the costliest read of the graph, so
 * a caller that needs the endpoints' own values alone asks for them alone (madarch-64o5.180).
 */
export interface SemanticProjection {
  /** Whether the role's edge slots are projected: the default, and no edge kind is read when it is false. */
  readonly edges?: boolean;
}

/** Project explicit field and edge bindings into engine role properties, keeping stable graph identity. */
export async function semanticEntities(graph: SemanticGraph, manifest: Pick<KindsManifest, 'file' | 'semanticBindings'>, role: string, projection: SemanticProjection = {}): Promise<GraphEntity[]> {
  const binding = semanticBinding(manifest, role);
  const withEdges = projection.edges !== false;
  const rows: GraphEntity[] = [];
  let after: string | undefined;
  do {
    const page = await graph.list(binding.kind, { limit: 500, ...(after === undefined ? {} : { after }) });
    rows.push(...page.rows);
    after = page.next ?? undefined;
  } while (after !== undefined);
  const edges = new Map<string, Awaited<ReturnType<GraphReader['relationEdges']>>['rows']>();
  // No row is no edge slot to fill: a whole edge kind is the costliest read of the graph, and a projection that names
  // nothing pays for none of them (madarch-64o5.180).
  for (const edge of withEdges && rows.length > 0 ? Object.values(binding.edges ?? {}) : []) {
    if (edges.has(edge.kind)) continue;
    if (graph.relationEdges === undefined) throw new Error(`${manifest.file}:${edge.line}: semantic role "${role}" requires graph edge reads`);
    const found = await graph.relationEdges(edge.kind, 200_000);
    if (found.total !== found.rows.length) throw new Error(`${manifest.file}:${edge.line}: semantic role "${role}" reads ${found.rows.length} of ${found.total} ${edge.kind} edges; refusing a partial projection`);
    edges.set(edge.kind, found.rows);
  }
  const optionalFields = semanticRoleOptionalFields(role);
  return rows.map((entity) => {
    const properties: Record<string, unknown> = {};
    for (const [property, field] of Object.entries(binding.fields)) {
      const optional = optionalFields.get(property);
      if (!Object.hasOwn(entity.properties, field)) {
        if (optional !== undefined) continue;
        throw new Error(`${manifest.file}:${binding.line}: ${entity.key}: semantic role "${role}" field "${field}" is absent`);
      }
      const value = entity.properties[field];
      if (value === null && optional === 'non-nullable') continue;
      const values = binding.values?.[property];
      if (values === undefined || value === null) properties[property] = value;
      else {
        const match = Object.entries(values).find(([, declared]) => declared === value);
        if (match === undefined) {
          if (optional !== undefined) continue;
          throw new Error(`${manifest.file}:${binding.line}: ${entity.key}: semantic role "${role}" field "${field}" has no declared semantic value for ${JSON.stringify(value)}`);
        }
        properties[property] = match[0];
      }
    }
    for (const [property, edge] of Object.entries(withEdges ? binding.edges ?? {} : {})) {
      const opposite = edge.direction === 'from' ? 'to' : 'from';
      if (entity.uid === undefined) throw new Error(`${manifest.file}:${edge.line}: ${entity.key}: semantic role "${role}" requires a stable graph UID`);
      properties[property] = edges.get(edge.kind)!.filter((row) => {
        const endpoint = row[edge.direction];
        if (endpoint.uid === undefined) throw new Error(`${manifest.file}:${edge.line}: semantic role "${role}" edge "${edge.kind}" has an endpoint without a UID`);
        return endpoint.uid === entity.uid;
      }).map((row) => {
        const endpoint = row[opposite];
        if (endpoint.uid === undefined) throw new Error(`${manifest.file}:${edge.line}: semantic role "${role}" edge "${edge.kind}" has a target without a UID`);
        return endpoint.uid;
      });
    }
    checkRoleProperties(role, properties, `${manifest.file}:${binding.line}: ${entity.key}`);
    return { ...entity, properties };
  });
}
