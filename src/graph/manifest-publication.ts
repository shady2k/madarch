/** Validate a product's declarations once, then publish only metadata through the graph writer. */
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { SqlExecutor } from '../sql-driver.js';
import type { EdgeDraft, EdgeRemovalDraft, GraphContract, VertexDraft, VertexRemovalDraft } from '../graph/contract.js';
import { MANIFEST_CONTRACT, MANIFEST_DEPENDS_ON, MANIFEST_RELATION_EDGE } from '../graph/manifest-contract.js';
import { evidenceList, publishGraphDrafts } from '../graph/write.js';
import { byCodePoint } from '../model/order.js';
import { headCommitOf } from '../product/fill-updates.js';
import { KINDS_FILE, readKindsFrom, type Finding, type KindsFileSource, type KindsManifest } from '../product/manifest/kinds.js';
import { workingTreeFiles } from '../plugin/product-files.js';
import { readWorkflowsFrom, WORKFLOWS_FILE } from '../product/manifest/workflows.js';
import { pluginDeclarationFindings } from '../plugin/manifest-source.js';
import { publishedManifestOf } from '../graphql/manifest.js';
import { graphContractOf } from '../fill/stages/plugin-contract.js';
import { graphqlSchemaOf } from '../graphql/schema.js';
import { SchemaRefusal } from '../graphql/names.js';
import { writeProductEntity } from './start-entity.js';
import { productEntityOf } from '../product/manifest.js';
import { homeKind } from '../product/manifest/kinds.js';

export interface ValidatedManifests {
  readonly folder: string;
  readonly manifest: KindsManifest;
  readonly vertices: readonly VertexDraft[];
  readonly edges: readonly EdgeDraft[];
  /** The starter value sets, written as their own entities beside the catalogue's declarations. */
  readonly starterValues: readonly VertexDraft[];
  readonly templatePaths: readonly string[];
}
export type ManifestValidation = { readonly ok: true; readonly value: ValidatedManifests | undefined } | { readonly ok: false; readonly findings: readonly Finding[]; readonly templatePaths: readonly string[] };

/** JSON stores maps explicitly; declarations have maps nested in catalogues and workflow stage locations. */
function encode(value: unknown): unknown {
  if (value instanceof Map) return { $map: [...value].map(([key, held]) => [key, encode(held)]) };
  if (Array.isArray(value)) return value.map(encode);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, held]) => [key, encode(held)]));
  return value;
}
function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value !== null && typeof value === 'object') {
    const held = value as Record<string, unknown>;
    if (Array.isArray(held.$map)) return new Map((held.$map as [string, unknown][]).map(([key, one]) => [key, decode(one)]));
    return Object.fromEntries(Object.entries(held).map(([key, one]) => [key, decode(one)]));
  }
  return value;
}

/** Uses the same kinds/workflows checks as a fill; every finding retains its full path and line. */
export function validateProductManifests(productFolder: string, files: KindsFileSource = workingTreeFiles(productFolder), commit?: string): ManifestValidation {
  const folder = resolve(productFolder);
  const read = readKindsFrom(files, folder);
  const workflow = readWorkflowsFrom(files, folder);
  const findings: Finding[] = read.present ? [...read.manifest.findings] : [];
  // The names the schema derives are the manifest check's too (decision 0036, section 1): a reserved name, or two
  // declarations that encode to one, refuse the manifest here and name both.
  if (read.present && read.manifest.findings.length === 0) {
    try {
      graphqlSchemaOf(publishedManifestOf(read.manifest));
    } catch (error) {
      if (!(error instanceof SchemaRefusal)) throw error;
      findings.push({ file: join(folder, KINDS_FILE), line: 1, message: error.message });
    }
  }
  // Workflows are checked even when no kinds file was written.
  for (const finding of workflow.findings) if (!findings.some((one) => one.file === finding.file && one.line === finding.line && one.message === finding.message)) findings.push(finding);
  for (const finding of pluginDeclarationFindings(files, folder, read.present ? read.manifest : undefined)) if (!findings.some((one) => one.message === finding.message)) findings.push(finding);
  // Templates are the product's `templates/` files, served as the bootstrap's PageTemplate list (section 6), not
  // declarations this publication interprets: the Liquid compiler and its `template` kind are deleted with the page layer.
  const templatePaths: string[] = [];
  for (const finding of findings) finding.file = isAbsolute(finding.file) ? finding.file : join(folder, finding.file);
  findings.sort((left, right) => byCodePoint(left.file, right.file) || left.line - right.line || byCodePoint(left.message, right.message));
  if (findings.length > 0) return { ok: false, findings, templatePaths };
  if (!read.present) return { ok: true, value: undefined };
  const manifest = read.manifest;
  const vertices: VertexDraft[] = [];
  const edges: EdgeDraft[] = [];
  const head = commit === undefined ? headCommitOf(folder) : { commit };
  if (head === undefined) return { ok: false, templatePaths, findings: [{ file: join(folder, '.git', 'HEAD'), line: 1, message: 'the product repository holds no commit: manifest opinions require its checkout commit' }] };
  const evidence = (path: string, line: number) => [{ repository: folder, path, lineStart: line, lineEnd: line, commit: head.commit }];
  const add = (category: string, name: string, declaration: unknown, path: string, line: number): void => {
    vertices.push({ kind: `manifest.${category}`, key: { name }, values: { declaration: encode(declaration) },
      evidence: evidence(path, line), producer: 'manifest', producerVersion: '1' });
  };
  const addEdge = (edgeKind: string, from: string, to: string, declaration: unknown, path: string, line: number, relation?: string): void => {
    edges.push({ kind: edgeKind, from: { kind: 'manifest.kind', key: { name: from } }, to: { kind: 'manifest.kind', key: { name: to } },
      ...(relation === undefined ? {} : { discriminator: relation }),
      values: { declaration: encode(declaration), ...(relation === undefined ? {} : { relation }) },
      evidence: evidence(path, line), producer: 'manifest', producerVersion: '1' });
  };
  add('catalogue', 'product', manifest, KINDS_FILE, 1);
  // The plugins whose contract declares a kind's vertices: the catalogue entity says what fills it.
  const pluginsOf = (name: string): string[] => [...(manifest.plugins?.values() ?? [])]
    .filter((plugin) => (plugin.contract?.vertices ?? []).some((vertex) => vertex.kind === name))
    .map((plugin) => plugin.id);
  for (const [name, kind] of manifest.kinds) {
    const path = manifest.kindFiles?.get(name) ?? KINDS_FILE;
    add('kind', name, { ...kind, ...(manifest.catalog?.kinds.get(name) === undefined ? {} : { catalog: manifest.catalog.kinds.get(name) }), taken: true, plugins: pluginsOf(name) }, path, kind.line);
    for (const field of kind.fields ?? []) add('field', JSON.stringify([name, field.name]), { kind: name, ...field }, path, field.line ?? kind.line);
    for (const [index, relation] of (kind.relations ?? []).entries()) {
      add('relation', JSON.stringify([name, index]), { from: name, ...relation }, path, relation.line);
      addEdge(MANIFEST_RELATION_EDGE, name, relation.to.split(':')[0]!, { from: name, ...relation }, path, relation.line, relation.type);
    }
    for (const dependency of kind.derivesFrom ?? []) addEdge(MANIFEST_DEPENDS_ON, name, dependency, { from: name, to: dependency, via: 'derives-from' }, path, kind.line);
  }
  for (const [name, kind] of manifest.catalog?.kinds ?? []) if (!manifest.kinds.has(name)) {
    const path = manifest.kindFiles?.get(name) ?? KINDS_FILE;
    add('kind', name, { catalog: kind, derivesFrom: kind.derivesFrom, taken: false, plugins: [] }, path, kind.line);
    for (const dependency of kind.derivesFrom ?? []) addEdge(MANIFEST_DEPENDS_ON, name, dependency, { from: name, to: dependency, via: 'derives-from' }, path, kind.line);
  }
  for (const [name, edge] of manifest.edges ?? []) {
    add('relation', JSON.stringify(['edge', name]), edge, KINDS_FILE, edge.line);
    // A wildcard permits endpoints; it does not declare a relationship between every pair of kinds.
    // Its complete declaration remains a catalogue relation, without invented concrete links.
    for (const from of edge.from) for (const to of edge.to) {
      if (from !== 'any' && to !== 'any') addEdge(MANIFEST_RELATION_EDGE, from, to, edge, KINDS_FILE, edge.line, name);
    }
  }
  for (const [name, entry] of manifest.workflows?.workflows ?? []) {
    add('workflow', name, entry, WORKFLOWS_FILE, entry.line);
    // Dependencies are the same derivation a fill plans, not an order guessed by the reader.
    const graph = workflowDependencies(entry.stages);
    for (const edge of graph) add('dependency', JSON.stringify(['workflow', name, edge.from, edge.to, edge.via]), { workflow: name, ...edge }, WORKFLOWS_FILE, entry.stageLines.get(edge.to) ?? entry.line);
  }
  vertices.sort((left, right) => byCodePoint(left.kind, right.kind) || byCodePoint(JSON.stringify(left.key), JSON.stringify(right.key)));
  const projectedEdges = new Map<string, EdgeDraft[]>();
  for (const edge of edges) {
    const key = JSON.stringify([edge.kind, edge.from.key, edge.to.key, edge.discriminator ?? '']);
    const held = projectedEdges.get(key) ?? [];
    held.push(edge);
    projectedEdges.set(key, held);
  }
  const combinedEdges = [...projectedEdges.values()].map((held): EdgeDraft => held.length === 1 ? held[0]! : {
    ...held[0]!, values: { ...held[0]!.values, declaration: { relations: held.map((one) => one.values!['declaration']) } },
    evidence: held.flatMap((one) => one.evidence ?? []),
  });
  const starterValues: VertexDraft[] = [];
  // The kinds that hold value sets are the manifest's own declaration, never a name this engine knows: a product may
  // rename them and keep publishing its sets.
  const setKind = [...manifest.kinds.values()].find((kind) => kind.referenceSet !== undefined);
  const entryKind = [...manifest.kinds.values()].find((kind) => kind.referenceSetEntry !== undefined);
  if (setKind?.referenceSet !== undefined && entryKind?.referenceSetEntry !== undefined) {
    const setRoles = setKind.referenceSet!;
    const entryRoles = entryKind.referenceSetEntry!;
    const roleValue = (roles: Readonly<Record<string, string>>, role: string, value: string | number | undefined): Record<string, string | number> => value === undefined || roles[role] === undefined ? {} : { [roles[role]!]: value };
    const evidenceAt = (line: number): { repository: string; path: string; lineStart: number; lineEnd: number; commit: string }[] => [{ repository: folder, path: KINDS_FILE, lineStart: line, lineEnd: line, commit: head.commit }];
    for (const [name, set] of manifest.values ?? []) {
      starterValues.push({
        kind: setKind.name,
        key: { [setRoles['name']!]: name },
        values: {
          ...roleValue(setRoles, 'label-en', set.labels['en']),
          ...roleValue(setRoles, 'label-ru', set.labels['ru']),
          ...roleValue(setRoles, 'description', set.description),
          ...roleValue(setRoles, 'order', set.order),
        },
        evidence: evidenceAt(set.line), producer: 'manifest', producerVersion: '1',
      });
      for (const entry of set.entries) {
        starterValues.push({
          kind: entryKind.name,
          key: {
            [entryRoles['set']!]: { kind: setKind.name, key: { [setRoles['name']!]: name } },
            [entryRoles['value']!]: entry.value,
          },
          values: {
            ...roleValue(entryRoles, 'label-en', entry.labels['en']),
            ...roleValue(entryRoles, 'label-ru', entry.labels['ru']),
            ...roleValue(entryRoles, 'description', entry.description),
            ...roleValue(entryRoles, 'order', entry.order),
          },
          evidence: evidenceAt(entry.line), producer: 'manifest', producerVersion: '1',
        });
      }
    }
  }
  return { ok: true, value: { folder, manifest, vertices, edges: combinedEdges, starterValues, templatePaths } };
}

import { deriveStageGraphOver } from '../fill/registry.js';
import { createEngineStageRegistry } from '../fill/stages/index.js';
function workflowDependencies(stages: readonly string[]): readonly { from: string; to: string; via: string }[] {
  const read = deriveStageGraphOver(createEngineStageRegistry(), stages);
  if (!read.ok) throw new Error('the validated workflow no longer derives');
  return read.graph.edges;
}

/**
 * One transaction closes removed declarations and states the entire valid catalogue atomically; the product's own page
 * is stated beside it, when the product's files name one and the graph holds none (the home page opens on the product).
 */
export async function publishValidatedManifests(owner: DatabaseOwner, validated: ValidatedManifests, authored?: GraphContract): Promise<number> {
  const written = await publishDeclarations(owner, validated, authored);
  const home = homeKind(validated.manifest);
  await writeProductEntity(owner, home === undefined ? undefined : productEntityOf(validated.folder, { home }, headCommitOf(validated.folder)?.commit));
  return written;
}

/** The declarations alone: the manifest's kinds, fields, relations, dependencies and workflows, in one transaction. */
async function publishDeclarations(owner: DatabaseOwner, validated: ValidatedManifests, authored?: GraphContract): Promise<number> {
  return await owner.transaction('write', async (tx) => {
    const identity = (kind: string, key: unknown): string => JSON.stringify([kind, key]);
    const held = await tx.query<{ kind: string; key: Record<string, string> }>(`SELECT e.name AS kind, n.key FROM node n JOIN entity e ON e.id = n.entity_id WHERE e.name = ANY($1::text[]) AND NOT n.removed`, [`{${MANIFEST_CONTRACT.vertex.map((one) => one.name).join(',')}}`]);
    const wanted = new Set(validated.vertices.map((one) => identity(one.kind, one.key)));
    const removals: VertexRemovalDraft[] = held.rows.filter((one) => !wanted.has(identity(one.kind, one.key))).map((one) => ({ kind: one.kind, key: one.key, producer: 'manifest' }));
    // Compare every value and its grounds, so identical refreshes publish no new opinions.
    const published = await tx.query<{ kind: string; key: Record<string, string>; values: unknown; evidence: unknown }>(MANIFEST_CONTRACT.vertex.map((kind) => {
      const columns = kind.fields.filter((field) => !kind.key.includes(field.name));
      const values = `jsonb_build_object(${columns.map((field) => `'${field.name}', p."${field.name}"`).join(', ')})`;
      return `SELECT '${kind.name}' AS kind, n.key, ${values} AS values, p.evidence
        FROM (SELECT DISTINCT ON (p.node_id) p.* FROM "${kind.table}" p
          WHERE p.context_id = 1 AND p.lang IS NULL AND p.state = 'open' AND split_part(p.said_by, '@', 1) = 'manifest'
          ORDER BY p.node_id, p.id DESC) p
        JOIN node n ON n.id = p.node_id AND n.context_id = 1 AND NOT n.removed`;
    }).join(' UNION ALL '));
    const current = new Map(published.rows.map((one) => [identity(one.kind, one.key), one]));
    const vertices = validated.vertices.filter((one) => {
      const held = current.get(identity(one.kind, one.key));
      const fields = MANIFEST_CONTRACT.vertex.find((kind) => kind.name === one.kind)!;
      const values = Object.fromEntries(Object.entries(one.values ?? {}).filter(([name]) => !fields.key.includes(name)));
      return held === undefined || !isDeepStrictEqual(held.values, values) || !isDeepStrictEqual(held.evidence, evidenceList(one));
    });
    const edgeIdentity = (one: Pick<EdgeDraft, 'kind' | 'from' | 'to' | 'discriminator'>): string =>
      JSON.stringify([one.kind, one.from.key, one.to.key, one.discriminator ?? '']);
    const publishedEdges = await tx.query<{ kind: string; from_key: Record<string, string>; to_key: Record<string, string>; discriminator: string; values: unknown; evidence: unknown }>(MANIFEST_CONTRACT.edge.map((kind) => {
      const values = `jsonb_build_object(${kind.fields.map((field) => `'${field.name}', p."${field.name}"`).join(', ')})`;
      return `SELECT '${kind.name}' AS kind, fn.key AS from_key, tn.key AS to_key, e.discriminator, ${values} AS values, p.evidence
        FROM (SELECT DISTINCT ON (p.edge_id) p.* FROM "${kind.table}" p
          WHERE p.context_id = 1 AND p.lang IS NULL AND p.state = 'open' AND split_part(p.said_by, '@', 1) = 'manifest'
          ORDER BY p.edge_id, p.id DESC) p
        JOIN edge e ON e.id = p.edge_id AND e.context_id = 1
        JOIN node fn ON fn.id = e.from_node JOIN node tn ON tn.id = e.to_node`;
    }).join(' UNION ALL '));
    const edgeDrafts = new Map(validated.edges.map((one) => [edgeIdentity(one), one]));
    const currentEdges = new Map(publishedEdges.rows.map((one) => {
      const draft = { kind: one.kind, from: { kind: 'manifest.kind', key: one.from_key }, to: { kind: 'manifest.kind', key: one.to_key }, discriminator: one.discriminator };
      return [edgeIdentity(draft), { ...one, draft }];
    }));
    const edgeRemovals: EdgeRemovalDraft[] = [...currentEdges].filter(([key]) => !edgeDrafts.has(key))
      .map(([, one]) => ({ ...one.draft, producer: 'manifest' }));
    const edges = [...edgeDrafts].filter(([key, one]) => {
      const held = currentEdges.get(key);
      return held === undefined || !isDeepStrictEqual(held.values, one.values) || !isDeepStrictEqual(held.evidence, evidenceList(one));
    }).map(([, one]) => one);
    let written = await publishGraphDrafts(tx, MANIFEST_CONTRACT, { vertices, edges, removals, edgeRemovals }, 1, { author: 'manifest' });
    const valueContract = authored ?? graphContractOf(validated.manifest);
    const valueKinds = new Set(validated.starterValues.map((draft) => draft.kind));
    if (valueKinds.size > 0 && [...valueKinds].every((kind) => valueContract.vertex.some((vertex) => vertex.name === kind))) {
      written += await publishGraphDrafts(tx, valueContract, { vertices: validated.starterValues, edges: [], removals: [] }, 1, { author: 'manifest' });
    }
    return written;
  });
}


/** The complete validated metadata, never a read of the checkout or a fallback to it. */
export async function readPublishedManifest(tx: SqlExecutor): Promise<KindsManifest | undefined> {
  const table = MANIFEST_CONTRACT.vertex.find((one) => one.name === 'manifest.catalogue')!.table;
  const rows = await tx.query<{ declaration: unknown }>(`SELECT p.declaration FROM "${table}" p JOIN node n ON n.id = p.node_id WHERE n.key->>'name' = 'product' AND NOT n.removed AND p.state = 'open' AND split_part(p.said_by, '@', 1) = 'manifest' ORDER BY p.id DESC LIMIT 1`);
  const value = rows.rows[0]?.declaration;
  return value === undefined ? undefined : decode(value) as KindsManifest;
}
