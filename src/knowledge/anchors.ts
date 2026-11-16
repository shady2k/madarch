/** Document anchors and ranges are structured producer opinions. */
import type { GraphEntity } from './graph-read.js';
import type { KindsManifest } from '../product/manifest/kinds.js';
import { semanticEntities, type SemanticGraph } from './semantic-bindings.js';

export interface DocumentSection {
  readonly anchor: string;
  readonly title: string;
  readonly start: number;
  readonly end: number;
  readonly markdown: string;
}

/** Checked document role values, with repository/commit endpoints resolved to display values. */
export interface SourceOpinion extends GraphEntity {
  properties: { path: string; content: string | null; repository: string | null; commit: string | null };
}

export interface DocumentOpinion extends SourceOpinion {
  properties: SourceOpinion['properties'] & { content: string; anchors: Readonly<Record<string, Omit<DocumentSection, 'anchor'>>> };
}

/** Explicit semantic bindings supply document/source values and their graph endpoints. */
export function documentOpinions(graph: SemanticGraph, manifest: KindsManifest, role?: 'document'): Promise<DocumentOpinion[]>;
export function documentOpinions(graph: SemanticGraph, manifest: KindsManifest, role: 'source'): Promise<SourceOpinion[]>;
export async function documentOpinions(graph: SemanticGraph, manifest: KindsManifest, role: 'document' | 'source' = 'document'): Promise<SourceOpinion[]> {
  const entities = await semanticEntities(graph, manifest, role);
  const repositories = await semanticEntities(graph, manifest, 'repository');
  const commits = manifest.semanticBindings?.get(role)?.edges?.['commit'] === undefined ? [] : await semanticEntities(graph, manifest, 'commit');
  const endpoint = (entity: GraphEntity, slot: string, targets: GraphEntity[], field: string): string | null => {
    const uids = entity.properties[slot] as string[] | undefined;
    if (uids === undefined || uids.length === 0) return null;
    if (uids.length !== 1) throw new Error(`${manifest.file}:1: ${entity.key}: semantic role "${role}" requires at most one ${slot} endpoint`);
    const target = targets.find((target) => target.uid === uids[0]);
    if (target === undefined) throw new Error(`${manifest.file}:1: ${entity.key}: semantic role "${role}" ${slot} endpoint ${uids[0]} is not declared by its role`);
    const value = target.properties[field];
    if (typeof value !== 'string' && value !== null) throw new Error(`${manifest.file}:1: ${target.key}: semantic role "${slot}" requires ${field}`);
    return value;
  };
  return entities.map((entity) => ({ ...entity, properties: { ...entity.properties,
    repository: endpoint(entity, 'repository', repositories, 'name'),
    commit: endpoint(entity, 'commit', commits, 'hash'),
  } })) as SourceOpinion[];
}

/** Lookup uses only declared projections, never catalogue field-name guesses. */
export function graphDocument(documents: readonly DocumentOpinion[], repo: string | null, path: string): DocumentOpinion | undefined {
  return documents.find((entity) => entity.properties['path'] === path && entity.properties['repository'] === repo);
}

/** Every anchor carries its producer's exact range and excerpt; the wiki infers neither. */
export function documentSections(document: DocumentOpinion): readonly DocumentSection[] {
  const anchors = document.properties['anchors'];
  const { repository, path } = document.properties;
  const file = repository === null ? String(path) : `repos/${String(repository)}/${String(path)}`;
  const fail = (anchor: string): never => { throw new Error(`${file}:1: document ${document.key} anchor ${JSON.stringify(anchor)} requires title, start, end and markdown`); };
  if (anchors === null || typeof anchors !== 'object' || Array.isArray(anchors)) return fail('');
  return Object.entries(anchors).map(([anchor, value]) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail(anchor);
    const { title, start, end, markdown } = value as Record<string, unknown>;
    if (anchor === '' || typeof title !== 'string' || typeof markdown !== 'string' || typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return fail(anchor);
    return { anchor, title, start, end, markdown };
  });
}
