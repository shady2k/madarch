/** Validate a product's declarations once, then publish only metadata through the graph writer. */
import { isAbsolute, join, resolve } from 'node:path';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { SqlExecutor } from '../sql-driver.js';
import type { VertexDraft, VertexRemovalDraft } from '../graph/contract.js';
import { MANIFEST_CONTRACT } from '../graph/manifest-contract.js';
import { publishGraphDrafts } from '../graph/write.js';
import { byCodePoint } from '../model/order.js';
import { headCommitOf } from '../product/fill-updates.js';
import { KINDS_FILE, readKindsFrom, type Finding, type KindsManifest } from '../knowledge/kinds.js';
import { workingTreeFiles, type ProductFileRead } from '../knowledge/product-files.js';
import { readWorkflowsFrom, WORKFLOWS_FILE } from '../knowledge/workflows.js';
import { parsePluginLock, PLUGINS_LOCK_FILE } from '../plugin/lock.js';
import { parsePluginManifest, ClosureRefusal } from '../plugin/closure.js';

export interface ValidatedManifests {
  readonly folder: string;
  readonly manifest: KindsManifest;
  readonly vertices: readonly VertexDraft[];
}
export type ManifestValidation = { readonly ok: true; readonly value: ValidatedManifests } | { readonly ok: false; readonly findings: readonly Finding[] };

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
export function validateProductManifests(productFolder: string, files: ProductFileRead = workingTreeFiles(productFolder), commit?: string): ManifestValidation {
  const folder = resolve(productFolder);
  const read = readKindsFrom(files, folder);
  const workflow = readWorkflowsFrom(files, folder);
  const findings: Finding[] = read.present ? [...read.manifest.findings] : [];
  // Workflows are checked even when no kinds file was written.
  for (const finding of workflow.findings) if (!findings.some((one) => one.file === finding.file && one.line === finding.line && one.message === finding.message)) findings.push(finding);
  const lock = parsePluginLock(files.text(PLUGINS_LOCK_FILE), join(folder, PLUGINS_LOCK_FILE));
  if (!lock.ok && !findings.some((one) => one.message === lock.message)) findings.push(lock);
  for (const plugin of read.present ? read.manifest.plugins?.values() ?? [] : []) {
    if (plugin.path === undefined) continue;
    const path = `${plugin.path}/plugin.json`;
    const file = join(folder, path);
    const text = files.text(path);
    if (text === undefined) findings.push({ file, line: 1, message: 'the named plugin holds no readable plugin.json' });
    else try { parsePluginManifest(text, file); } catch (error) {
      if (!(error instanceof ClosureRefusal)) throw error;
      findings.push({ file: error.file, line: error.line, message: error.message });
    }
  }
  for (const finding of findings) finding.file = isAbsolute(finding.file) ? finding.file : join(folder, finding.file);
  findings.sort((left, right) => byCodePoint(left.file, right.file) || left.line - right.line || byCodePoint(left.message, right.message));
  if (findings.length > 0) return { ok: false, findings };
  if (!read.present) return { ok: false, findings: [{ file: read.file, line: 1, message: 'the product holds no kinds manifest' }] };
  const manifest = read.manifest;
  const vertices: VertexDraft[] = [];
  const head = commit === undefined ? headCommitOf(folder) : { commit };
  if (head === undefined) return { ok: false, findings: [{ file: join(folder, '.git', 'HEAD'), line: 1, message: 'the product repository holds no commit: manifest opinions require its checkout commit' }] };
  const evidence = (path: string, line: number) => [{ repository: folder, path, lineStart: line, lineEnd: line, commit: head.commit }];
  const add = (category: string, name: string, declaration: unknown, path: string, line: number): void => {
    vertices.push({ kind: `manifest.${category}`, key: { name }, values: { declaration: encode(declaration) },
      evidence: evidence(path, line), producer: 'manifest', producerVersion: '1' });
  };
  add('catalogue', 'product', manifest, KINDS_FILE, 1);
  for (const [name, kind] of manifest.kinds) {
    add('kind', name, { ...kind, ...(manifest.catalog?.kinds.get(name) === undefined ? {} : { catalog: manifest.catalog.kinds.get(name) }) }, KINDS_FILE, kind.line);
    for (const field of kind.fields ?? []) add('field', JSON.stringify([name, field.name]), { kind: name, ...field }, KINDS_FILE, field.line ?? kind.line);
    for (const [index, relation] of (kind.relations ?? []).entries()) add('relation', JSON.stringify([name, index]), { from: name, ...relation }, KINDS_FILE, relation.line);
    for (const dependency of kind.dependsOn ?? []) add('dependency', JSON.stringify(['kind', name, dependency]), { from: dependency, to: name, via: 'depends-on' }, KINDS_FILE, kind.line);
  }
  for (const [name, kind] of manifest.catalog?.kinds ?? []) if (!manifest.kinds.has(name)) add('kind', name, { catalog: kind }, KINDS_FILE, kind.line);
  for (const [name, edge] of manifest.edges ?? []) add('relation', JSON.stringify(['edge', name]), edge, KINDS_FILE, edge.line);
  for (const [name, entry] of manifest.workflows?.workflows ?? []) {
    add('workflow', name, entry, WORKFLOWS_FILE, entry.line);
    // Dependencies are the same derivation a fill plans, not an order guessed by the reader.
    const graph = workflowDependencies(entry.stages);
    for (const edge of graph) add('dependency', JSON.stringify(['workflow', name, edge.from, edge.to, edge.via]), { workflow: name, ...edge }, WORKFLOWS_FILE, entry.stageLines.get(edge.to) ?? entry.line);
  }
  vertices.sort((left, right) => byCodePoint(left.kind, right.kind) || byCodePoint(String(left.key.name), String(right.key.name)));
  return { ok: true, value: { folder, manifest, vertices } };
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
    const held = await tx.query<{ kind: string; name: string }>(`SELECT e.name AS kind, n.key->>'name' AS name FROM node n JOIN entity e ON e.id = n.entity_id WHERE e.name = ANY($1::text[]) AND NOT n.removed`, [`{${MANIFEST_CONTRACT.vertex.map((one) => one.name).join(',')}}`]);
    const wanted = new Set(validated.vertices.map((one) => JSON.stringify([one.kind, one.key.name])));
    const removals: VertexRemovalDraft[] = held.rows.filter((one) => !wanted.has(JSON.stringify([one.kind, one.name]))).map((one) => ({ kind: one.kind, key: { name: one.name }, producer: 'manifest' }));
    return await publishGraphDrafts(tx, MANIFEST_CONTRACT, { vertices: validated.vertices, edges: [], removals }, 1, { author: 'manifest' });
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
