/** Validate a product's declarations once, then publish only metadata through the graph writer. */
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { SqlExecutor } from '../sql-driver.js';
import type { VertexDraft, VertexRemovalDraft } from '../graph/contract.js';
import { MANIFEST_CONTRACT } from '../graph/manifest-contract.js';
import { evidenceList, publishGraphDrafts } from '../graph/write.js';
import { byCodePoint } from '../model/order.js';
import { headCommitOf } from '../product/fill-updates.js';
import { KINDS_FILE, readKindsFrom, type Finding, type KindsFileSource, type KindsManifest } from '../product/manifest/kinds.js';
import { workingTreeFiles } from '../plugin/product-files.js';
import { readWorkflowsFrom, WORKFLOWS_FILE } from '../product/manifest/workflows.js';
import { pluginDeclarationFindings } from '../plugin/manifest-source.js';
import { TEMPLATE_CONTRACT, interpretTemplateDeclarations } from '../plugin/template-declarations.js';
import { publishedManifestOf } from '../graphql/manifest.js';
import { graphqlSchemaOf } from '../graphql/schema.js';
import { SchemaRefusal } from '../graphql/names.js';

export interface ValidatedManifests {
  readonly folder: string;
  readonly manifest: KindsManifest;
  readonly vertices: readonly VertexDraft[];
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
  const templates = read.present ? interpretTemplateDeclarations(files, read.manifest) : { vertices: [], findings: [], paths: [] };
  findings.push(...templates.findings);
  for (const finding of findings) finding.file = isAbsolute(finding.file) ? finding.file : join(folder, finding.file);
  findings.sort((left, right) => byCodePoint(left.file, right.file) || left.line - right.line || byCodePoint(left.message, right.message));
  if (findings.length > 0) return { ok: false, findings, templatePaths: templates.paths };
  if (!read.present) return { ok: true, value: undefined };
  const manifest = read.manifest;
  const vertices: VertexDraft[] = [];
  const head = commit === undefined ? headCommitOf(folder) : { commit };
  if (head === undefined) return { ok: false, templatePaths: templates.paths, findings: [{ file: join(folder, '.git', 'HEAD'), line: 1, message: 'the product repository holds no commit: manifest opinions require its checkout commit' }] };
  const evidence = (path: string, line: number) => [{ repository: folder, path, lineStart: line, lineEnd: line, commit: head.commit }];
  const add = (category: string, name: string, declaration: unknown, path: string, line: number): void => {
    vertices.push({ kind: `manifest.${category}`, key: { name }, values: { declaration: encode(declaration) },
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
    for (const [index, relation] of (kind.relations ?? []).entries()) add('relation', JSON.stringify([name, index]), { from: name, ...relation }, path, relation.line);
    for (const dependency of kind.derivesFrom ?? []) add('dependency', JSON.stringify(['kind', name, dependency]), { from: dependency, to: name, via: 'derives-from' }, path, kind.line);
  }
  for (const [name, kind] of manifest.catalog?.kinds ?? []) if (!manifest.kinds.has(name)) add('kind', name, { catalog: kind, taken: false, plugins: [] }, manifest.kindFiles?.get(name) ?? KINDS_FILE, kind.line);
  for (const [name, edge] of manifest.edges ?? []) add('relation', JSON.stringify(['edge', name]), edge, KINDS_FILE, edge.line);
  for (const [name, entry] of manifest.workflows?.workflows ?? []) {
    add('workflow', name, entry, WORKFLOWS_FILE, entry.line);
    // Dependencies are the same derivation a fill plans, not an order guessed by the reader.
    const graph = workflowDependencies(entry.stages);
    for (const edge of graph) add('dependency', JSON.stringify(['workflow', name, edge.from, edge.to, edge.via]), { workflow: name, ...edge }, WORKFLOWS_FILE, entry.stageLines.get(edge.to) ?? entry.line);
  }
  for (const template of templates.vertices) vertices.push({ ...template, evidence: templates.paths.map((path) => evidence(path, 1)[0]!) });
  vertices.sort((left, right) => byCodePoint(left.kind, right.kind) || byCodePoint(JSON.stringify(left.key), JSON.stringify(right.key)));
  return { ok: true, value: { folder, manifest, vertices, templatePaths: templates.paths } };
}

import { deriveStageGraphOver } from '../fill/registry.js';
import { createEngineStageRegistry } from '../fill/stages/index.js';
function workflowDependencies(stages: readonly string[]): readonly { from: string; to: string; via: string }[] {
  const read = deriveStageGraphOver(createEngineStageRegistry(), stages);
  if (!read.ok) throw new Error('the validated workflow no longer derives');
  return read.graph.edges;
}

/** One transaction closes removed declarations and states the entire valid catalogue atomically. */
export async function publishValidatedManifests(owner: DatabaseOwner, validated: ValidatedManifests): Promise<number> {
  return await owner.transaction('write', async (tx) => {
    const identity = (kind: string, key: unknown): string => JSON.stringify([kind, key]);
    const held = await tx.query<{ kind: string; key: Record<string, string> }>(`SELECT e.name AS kind, n.key FROM node n JOIN entity e ON e.id = n.entity_id WHERE e.name = ANY($1::text[]) AND NOT n.removed`, [`{${MANIFEST_CONTRACT.vertex.map((one) => one.name).join(',')}}`]);
    const wanted = new Set(validated.vertices.map((one) => identity(one.kind, one.key)));
    const removals: VertexRemovalDraft[] = held.rows.filter((one) => !wanted.has(identity(one.kind, one.key))).map((one) => ({ kind: one.kind, key: one.key, producer: 'manifest' }));
    // Template declarations replace the retired content-fill producer through the same graph writer.
    for (const declaration of TEMPLATE_CONTRACT.vertex) {
      const retired = await tx.query<{ key: Record<string, string>; producer: string }>(`SELECT DISTINCT n.key, split_part(p.said_by, '@', 1) AS producer
        FROM "${declaration.table}" p JOIN node n ON n.id = p.node_id
        WHERE p.context_id = 1 AND p.state = 'open' AND split_part(p.said_by, '@', 1) <> 'manifest'`);
      for (const one of retired.rows) removals.push({ kind: declaration.name, key: one.key, producer: one.producer });
    }
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
    return await publishGraphDrafts(tx, MANIFEST_CONTRACT, { vertices, edges: [], removals }, 1, { author: 'manifest' });
  });
}


/** Explicit dependency opinions, already derived and validated at publication. */
export async function readPublishedDependencies(tx: SqlExecutor): Promise<readonly { from: string; to: string; via: string; workflow?: string }[]> {
  const table = MANIFEST_CONTRACT.vertex.find((one) => one.name === 'manifest.dependency')!.table;
  const rows = await tx.query<{ declaration: { from: string; to: string; via: string; workflow?: string } }>(`SELECT p.declaration FROM "${table}" p JOIN node n ON n.id = p.node_id WHERE NOT n.removed AND p.state = 'open' AND split_part(p.said_by, '@', 1) = 'manifest' ORDER BY n.key->>'name' COLLATE "C"`);
  return rows.rows.map((one) => one.declaration).sort((left, right) => byCodePoint(left.workflow ?? '', right.workflow ?? '') || byCodePoint(left.from, right.from) || byCodePoint(left.to, right.to) || byCodePoint(left.via, right.via));
}

/** The complete validated metadata, never a read of the checkout or a fallback to it. */
export async function readPublishedManifest(tx: SqlExecutor): Promise<KindsManifest | undefined> {
  const table = MANIFEST_CONTRACT.vertex.find((one) => one.name === 'manifest.catalogue')!.table;
  const rows = await tx.query<{ declaration: unknown }>(`SELECT p.declaration FROM "${table}" p JOIN node n ON n.id = p.node_id WHERE n.key->>'name' = 'product' AND NOT n.removed AND p.state = 'open' AND split_part(p.said_by, '@', 1) = 'manifest' ORDER BY p.id DESC LIMIT 1`);
  const value = rows.rows[0]?.declaration;
  return value === undefined ? undefined : decode(value) as KindsManifest;
}
