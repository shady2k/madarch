/** Validate a product's declarations once, then publish only metadata through the graph writer. */
import { isAbsolute, join, resolve } from 'node:path';
import { withSpan } from '../obs/trace.js';
import { readKindAssertions, readKindsAssertions, type AssertionRecord } from './records.js';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { SqlExecutor } from '../sql-driver.js';
import { graphContractVersion, type EdgeDraft, type EdgeRemovalDraft, type GraphContract, type VertexDraft, type VertexRemovalDraft } from '../graph/contract.js';
import { MANIFEST_CONTRACT, manifestDeclaration, MANIFEST_DEPENDS_ON, MANIFEST_RELATION_EDGE, withManifestContract } from '../graph/manifest-contract.js';
import { acquireGraphWriteLock, activateBoundIdentities, bindWriteCapability, bootstrapWriteIdentity, publishGraphDrafts, resolveEntityRef, writeAssertion, type WriteCapability } from '../graph/write.js';
import { newUid } from './uid.js';
import { installDisputeSelection, refreshDisputeSelection } from './disputes.js';
import { runningVersion } from '../product/version.js';
import { withAssertionContract } from './system-contract.js';
import { sha256Hex } from './digest.js';
import { byCodePoint } from '../model/order.js';
import { canonicalJson } from '../model/canonical.js';
import { headCommitOf } from '../product/fill-updates.js';
import { KINDS_FILE, readKindsFrom, declarationContent, type Finding, type KindsFileSource, type KindsManifest } from '../product/manifest/kinds.js';
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
  readonly snapshots: readonly VertexDraft[];
}
export type ManifestValidation = { readonly ok: true; readonly value: ValidatedManifests | undefined } | { readonly ok: false; readonly findings: readonly Finding[]; readonly templatePaths: readonly string[] };

/** Trusted core startup installs the engine as an actual plugin, never a parallel principal kind. */
export async function startupBinding(tx: SqlExecutor, declared: GraphContract, producer: string, permissions?: WriteCapability['permissions']): Promise<{ contract: GraphContract; binding: WriteCapability }> {
  const contract = withAssertionContract(declared);
  await acquireGraphWriteLock(tx);
  await tx.query('SELECT pg_advisory_xact_lock($1::bigint)', [739141]);
  const installedAt = (await tx.query<{ now: string | Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
  const identityCutoff = new Date(installedAt).toISOString();
  const products = await tx.query<{ uid: string }>("SELECT n.uid::text FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='system.product' ORDER BY n.uid");
  if (products.rows.length > 1) throw new Error(`${import.meta.path}:49: installation has more than one product identity`);
  const productUid = products.rows[0]?.uid ?? newUid();
  await bootstrapWriteIdentity(tx, 'system.product', productUid, productUid);
  const installation = JSON.stringify(['system-engine', producer]);
  const plugins = (await readKindAssertions(tx, 'vertex', 'plugin', ['installation', 'scope'], { validAt: identityCutoff, recordedAt: identityCutoff })).filter(record => record.values['installation'] === installation && record.values['scope'] === productUid);
  if (plugins.length > 1) throw new Error(`${import.meta.path}:56: ambiguous installed engine plugin ${producer}`);
  const sourceUid = plugins[0]?.uid ?? newUid();
  const operationUid = newUid();
  for (const [kind, uid] of [['plugin', sourceUid], ['system.operation', operationUid]] as const) await bootstrapWriteIdentity(tx, kind, uid, productUid);
  const hostPermissions = [...contract.vertex, ...contract.edge].map(kind => ({ kind: kind.name, properties: ['*'], assert: true, retractOwn: true }));
  const binding: WriteCapability = { productUid, sourceUid, principalUid: sourceUid, operationUid, context: 1, scope: productUid, contractVersion: graphContractVersion(contract), permissions: permissions ?? hostPermissions };
  bindWriteCapability(tx, { ...binding, permissions: hostPermissions });
  await activateBoundIdentities(tx, contract);
  for (const [kind, uid] of [['system.product', productUid], ['plugin', sourceUid], ['system.operation', operationUid]] as const) {
    const subject = (await tx.query<{ id: string }>('SELECT id::text FROM node WHERE uid=$1::uuid', [uid])).rows[0]!;
    await writeAssertion(tx, contract, { sort: 'vertex', kind, subjectId: subject.id, property: '$exists', operation: 'assert', value: true });
    if (kind === 'plugin') for (const [property, value] of Object.entries({ installation, scope: productUid, version: runningVersion(), label: producer })) {
      await writeAssertion(tx, contract, { sort: 'vertex', kind, subjectId: subject.id, property, operation: 'assert', value });
    }
  }
  bindWriteCapability(tx, binding);
  return { contract, binding };
}

/** Only trusted manifest/start code receives broad host permissions. */
export async function bindStartupWriter(tx: SqlExecutor, declared: GraphContract, producer: string): Promise<GraphContract> {
  return (await startupBinding(tx, declared, producer)).contract;
}

/** JSON stores maps explicitly; declarations have maps nested in catalogues and workflow stage locations. */
function encode(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Map) return { $map: [...value].map(([key, held]) => [key, encode(held)]) };
  if (Array.isArray(value)) return value.map(encode);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, held]) => held !== undefined).map(([key, held]) => [key, encode(held)]));
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
  const snapshots = new Map<string, VertexDraft>();
  const evidence = (path: string, line: number): import('./contract.js').EvidenceDraft[] => {
    const content = declarationContent(files, folder, path, line);
    const digest = sha256Hex(Buffer.from(content, 'utf8'));
    snapshots.set(digest, { kind: 'system.content-snapshot', key: { digest }, values: { content }, producer: 'manifest', producerVersion: '1' });
    return [{ target: { kind: 'system.content-snapshot', key: { digest } }, locator: { digest, lineStart: line, lineEnd: line } }];
  };
  const add = (category: Parameters<typeof manifestDeclaration>[0], name: string, declaration: unknown, path: string, line: number): void => {
    vertices.push({ kind: manifestDeclaration(category).name, key: { name }, values: { declaration: JSON.stringify(encode(declaration)) },
      evidence: evidence(path, line), producer: 'manifest', producerVersion: '1' });
  };
  const addEdge = (edgeKind: string, from: string, to: string, declaration: unknown, path: string, line: number, relation?: string): void => {
    edges.push({ kind: edgeKind, from: { kind: 'manifest.kind', key: { name: from } }, to: { kind: 'manifest.kind', key: { name: to } },
      ...(relation === undefined ? {} : { discriminator: relation }),
      values: { declaration: JSON.stringify(encode(declaration)), ...(relation === undefined ? {} : { relation }) },
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
  for (const [name, kind] of manifest.catalog?.kinds ?? []) if (!manifest.kinds.has(name)) add('kind', name, { catalog: kind, taken: false, plugins: [] }, manifest.kindFiles?.get(name) ?? KINDS_FILE, kind.line);
  for (const [name, edge] of manifest.edges ?? []) {
    add('relation', JSON.stringify(['edge', name]), edge, KINDS_FILE, edge.line);
    const declaration = JSON.stringify(encode(edge));
    const declaredEvidence = evidence(KINDS_FILE, edge.line);
    // A wildcard permits endpoints; it does not declare a relationship between every pair of kinds.
    // Its complete declaration remains a catalogue relation, without invented concrete links.
    for (const from of edge.from) for (const to of edge.to) {
      if (from !== 'any' && to !== 'any') {
        for (const endpoint of [from, to]) if (!vertices.some(vertex => vertex.kind === 'manifest.kind' && vertex.key['name'] === endpoint)) {
          const installed = withAssertionContract(withManifestContract(graphContractOf(manifest))).vertex.find(vertex => vertex.name === endpoint);
          if (installed === undefined) throw new Error(`${import.meta.path}:166: relation ${name} has undeclared endpoint ${endpoint}`);
          add('kind', endpoint, { contract: installed, protected: true, taken: false, plugins: [] }, KINDS_FILE, edge.line);
        }
        edges.push({ kind: MANIFEST_RELATION_EDGE, from: { kind: 'manifest.kind', key: { name: from } }, to: { kind: 'manifest.kind', key: { name: to } },
          discriminator: name, values: { declaration, relation: name },
          evidence: declaredEvidence, producer: 'manifest', producerVersion: '1' });
      }
    }
  }
  for (const [name, entry] of manifest.workflows?.workflows ?? []) {
    add('workflow', name, entry, WORKFLOWS_FILE, entry.line);
    const stageKind = manifestDeclaration('workflow-stage');
    for (const [position, stage] of entry.stages.entries()) vertices.push({
      kind: stageKind.name, key: { name: stage },
      keyEdges: { [stageKind.keyEdges![0]!.role]: { kind: manifestDeclaration('workflow').name, key: { name } } },
      values: { position, declaration: JSON.stringify(encode({ name: stage, position })) },
      evidence: evidence(WORKFLOWS_FILE, entry.stageLines.get(stage) ?? entry.line), producer: 'manifest', producerVersion: '1',
    });
    // Dependencies are the same derivation a fill plans, not an order guessed by the reader.
    const graph = workflowDependencies(entry.stages);
    for (const edge of graph) add('dependency', JSON.stringify(['workflow', name, edge.from, edge.to, edge.via]), { workflow: name, ...edge }, WORKFLOWS_FILE, entry.stageLines.get(edge.to) ?? entry.line);
  }
  vertices.sort((left, right) => byCodePoint(left.kind, right.kind) || byCodePoint(canonicalJson([left.keyEdges ?? {}, left.key]), canonicalJson([right.keyEdges ?? {}, right.key])));
  const projectedEdges = new Map<string, EdgeDraft[]>();
  for (const edge of edges) {
    const key = JSON.stringify([edge.kind, edge.from.key, edge.to.key, edge.discriminator ?? '']);
    const held = projectedEdges.get(key) ?? [];
    held.push(edge);
    projectedEdges.set(key, held);
  }
  const combinedEdges = [...projectedEdges.values()].map((held): EdgeDraft => held.length === 1 ? held[0]! : {
    ...held[0]!, values: { ...held[0]!.values, declaration: JSON.stringify({ relations: held.map((one) => JSON.parse(String(one.values!['declaration']))) }) },
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
    const evidenceAt = (line: number): import('./contract.js').EvidenceDraft[] => evidence(KINDS_FILE, line);
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
          keyEdges: { [entryRoles['set']!]: { kind: setKind.name, key: { [setRoles['name']!]: name } } },
          key: {
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
  return { ok: true, value: { folder, manifest, vertices, edges: combinedEdges, starterValues, templatePaths, snapshots: [...snapshots.values()] } };
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
  return await withSpan('manifest.publishDeclarations', {}, async () => await owner.transaction('write', async (tx) => {
    const contract = withAssertionContract(withManifestContract(authored ?? graphContractOf(validated.manifest)));
    await installDisputeSelection(tx, contract);
    const { contract: publicationContract, binding } = await startupBinding(tx, contract, 'manifest');
    const identity = (draft: Pick<VertexDraft, 'kind' | 'key' | 'keyEdges'>): string => canonicalJson([draft.kind, draft.key, draft.keyEdges ?? {}]);
    const readPhase = async (sort: 'vertex' | 'edge', kinds: readonly string[], drafts: readonly (VertexDraft | EdgeDraft)[]): Promise<Map<string, AssertionRecord[]>> => {
      const fields = new Map(kinds.map(kind => [kind, new Set<string>()]));
      for (const draft of drafts) {
        const held = fields.get(draft.kind) ?? new Set<string>();
        for (const field of Object.keys(draft.values ?? {})) held.add(field);
        fields.set(draft.kind, held);
      }
      const requests = [...fields].map(([kind, fields]) => ({ sort, kind, fields: [...fields] }));
      const records = await readKindsAssertions(tx, requests, { contract: publicationContract });
      return new Map(requests.map((request, index) => [request.kind, records[index]!]));
    };
    const snapshots = await readPhase('vertex', [...new Set(validated.snapshots.map(draft => draft.kind))], validated.snapshots);
    const missingSnapshots = validated.snapshots.filter(draft => {
      const row = snapshots.get(draft.kind)?.find(row => canonicalJson(row.key) === canonicalJson(draft.key));
      return row === undefined || !row.activeSources.includes(binding.sourceUid) ||
        Object.entries(draft.values ?? {}).some(([property, value]) => !row.selectedAssertions.some(assertion => assertion.property === property && assertion.source === binding.sourceUid && canonicalJson(assertion.value) === canonicalJson(value)));
    });
    await publishGraphDrafts(tx, publicationContract, { vertices: missingSnapshots, removals: [] });
    const vertexRecords = await readPhase('vertex', MANIFEST_CONTRACT.vertex.map(kind => kind.name), validated.vertices);
    const held = new Map<string, VertexRemovalDraft>();
    for (const kind of MANIFEST_CONTRACT.vertex) for (const row of vertexRecords.get(kind.name)!) {
      const keyEdges: Record<string, import('./contract.js').EntityRefDraft> = {};
      for (const role of kind.keyEdges ?? []) {
        const parent = await tx.query<{ kind: string; key: Record<string, import('./contract.js').KeyValueDraft> }>(`SELECT pk.name AS kind,p.key FROM edge e JOIN entity ek ON ek.id=e.entity_id JOIN node p ON p.id=e.to_node JOIN entity pk ON pk.id=p.entity_id WHERE e.from_node=$1 AND ek.name=$2`, [row.id, role.edge]);
        if (parent.rows.length !== 1) throw new Error(`${import.meta.path}:299: ${kind.name} ${row.uid} requires exactly one metadata parent`);
        keyEdges[role.role] = { kind: parent.rows[0]!.kind, key: parent.rows[0]!.key };
      }
      const draft = { kind: kind.name, key: row.key as Record<string, import('./contract.js').KeyValueDraft>, ...(kind.keyEdges?.length ? { keyEdges } : {}), uid: row.uid, producer: 'manifest' };
      held.set(identity(draft), draft);
    }
    const wanted = new Set(validated.vertices.map(identity));
    const removals = [...held].filter(([key]) => !wanted.has(key)).map(([, draft]) => draft)
      .sort((left, right) => Number(right.keyEdges !== undefined) - Number(left.keyEdges !== undefined) || byCodePoint(identity(left), identity(right)));
    const unchanged = async (draft: VertexDraft | EdgeDraft, rows: readonly AssertionRecord[]): Promise<boolean> => {
      if (rows.length === 0) return false;
      let record: import('./records.js').AssertionRecord | undefined;
      if ('key' in draft) {
        const prior = held.get(identity(draft));
        if (prior !== undefined) record = rows.find(row => row.uid === prior.uid);
        else if (draft.keyEdges !== undefined) {
          const resolved = await resolveEntityRef(tx, publicationContract, draft);
          record = rows.find(row => row.uid === resolved.uid);
        } else record = rows.find(row => canonicalJson(row.key) === canonicalJson(draft.key));
      }
      else {
        const from = await resolveEntityRef(tx, publicationContract, draft.from);
        const to = await resolveEntityRef(tx, publicationContract, draft.to);
        record = rows.find(row => String(row.from) === String(from.id) && String(row.to) === String(to.id) && (row.discriminator ?? '') === (draft.discriminator ?? ''));
      }
      if (record === undefined || !record.activeSources.includes(binding.sourceUid)) return false;
      const expectedEvidence: string[] = [];
      for (const [index, evidence] of (draft.evidence ?? []).entries()) {
        const target = await resolveEntityRef(tx, publicationContract, evidence.target);
        expectedEvidence.push(JSON.stringify([target.uid, { index, relation: evidence.relation ?? 'supports', locator: evidence.locator ?? {} }]));
      }
      for (const [property, value] of Object.entries({ '$exists': true, ...draft.values })) {
        const selected = record.selectedAssertions.find(assertion => assertion.property === property && assertion.source === binding.sourceUid);
        if (selected === undefined || JSON.stringify(selected.value) !== JSON.stringify(value)) return false;
        const evidence = await tx.query<{ uid: string; discriminator: string }>(`SELECT t.uid::text,e.discriminator FROM edge e JOIN node a ON a.id=e.from_node JOIN node t ON t.id=e.to_node JOIN entity k ON k.id=e.entity_id WHERE a.uid=$1::uuid AND k.name='system.assertion-evidence'`, [selected.id]);
        const actual = evidence.rows.map(row => JSON.stringify([row.uid, JSON.parse(row.discriminator)]));
        const canonical = (values: string[]) => values.map(value => JSON.stringify(JSON.parse(value), (_key, held) => held !== null && typeof held === 'object' && !Array.isArray(held) ? Object.fromEntries(Object.entries(held).sort(([a], [b]) => byCodePoint(a, b))) : held)).sort();
        if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expectedEvidence))) return false;
      }
      return true;
    };
    const vertices: VertexDraft[] = [];
    for (const draft of validated.vertices) if (!await unchanged(draft, vertexRecords.get(draft.kind)!)) vertices.push(draft);
    let written = await publishGraphDrafts(tx, publicationContract, { vertices, removals }, 1, { author: 'manifest' });
    const edgeRecords = await readPhase('edge', MANIFEST_CONTRACT.edge.map(kind => kind.name), validated.edges);
    const edges: EdgeDraft[] = [];
    for (const draft of validated.edges) if (!await unchanged(draft, edgeRecords.get(draft.kind)!)) edges.push(draft);
    const wantedEdges = new Set(validated.edges.map(e => JSON.stringify([e.kind,e.from.key,e.to.key,e.discriminator ?? ''])));
    const edgeRemovals: EdgeRemovalDraft[] = [];
    for (const kind of MANIFEST_CONTRACT.edge) {
      if (MANIFEST_CONTRACT.vertex.some(vertex => vertex.keyEdges?.some(role => role.edge === kind.name))) continue;
      const records = edgeRecords.get(kind.name)!;
      for (const record of records) {
        const ends = await tx.query<{ from_key: Record<string,string>; to_key: Record<string,string> }>('SELECT f.key AS from_key,t.key AS to_key FROM edge e JOIN node f ON f.id=e.from_node JOIN node t ON t.id=e.to_node WHERE e.id=$1',[record.id]);
        const one=ends.rows[0]!;
        if (!wantedEdges.has(JSON.stringify([kind.name,one.from_key,one.to_key,record.discriminator ?? '']))) edgeRemovals.push({kind:kind.name,from:{kind:'manifest.kind',key:one.from_key},to:{kind:'manifest.kind',key:one.to_key},discriminator:record.discriminator,producer:'manifest'});
      }
    }
    written += await publishGraphDrafts(tx, publicationContract, { vertices: [], edges, removals: [], edgeRemovals }, 1, { author: 'manifest' });
    const valueKinds = new Set(validated.starterValues.map((draft) => draft.kind));
    if (valueKinds.size > 0) {
      const records = await readPhase('vertex', [...valueKinds], validated.starterValues);
      const changed: VertexDraft[] = [];
      for (const draft of validated.starterValues) if (!await unchanged(draft, records.get(draft.kind)!)) changed.push(draft);
      written += await publishGraphDrafts(tx, publicationContract, { vertices: changed, edges: [], removals: [] }, 1, { author: 'manifest' });
    }
    await refreshDisputeSelection(tx, publicationContract);
    await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
    return written;
  }));
}


/** The complete validated metadata, never a read of the checkout or a fallback to it. */
export async function readPublishedManifest(tx: SqlExecutor): Promise<KindsManifest | undefined> {
  return await withSpan('manifest.readPublished', {}, async () => {
    const rows = await readKindAssertions(tx, 'vertex', 'manifest.catalogue', ['declaration']);
    const value = rows.find(row => row.key['name'] === 'product')?.values['declaration'];
    return value === undefined ? undefined : decode(JSON.parse(String(value))) as KindsManifest;
  });
}
