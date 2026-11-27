/** Validate a product's declarations once, then publish only metadata through the graph writer. */
import { extname, isAbsolute, join, resolve } from 'node:path';
import { reconcileDisputes } from './disputes.js';
import { withSpan } from '../obs/trace.js';
import { readKindAssertions, readKindsAssertions, type AssertionRecord } from './records.js';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { SqlExecutor } from '../sql-driver.js';
import { graphContractVersion, type EdgeDraft, type EdgeRemovalDraft, type GraphContract, type VertexDraft, type VertexRemovalDraft } from '../graph/contract.js';
import { MANIFEST_CONTRACT, manifestDeclaration, MANIFEST_DEPENDS_ON, MANIFEST_RELATION_EDGE, withManifestContract } from '../graph/manifest-contract.js';
import { acquireGraphWriteLock, bindWriteCapability, bootstrapWriteIdentity, preparePublicationContract, publishGraphDrafts, resolveEntityRefs, writeAssertion, writeAssertions, type WriteCapability } from '../graph/write.js';
import { newUid } from './uid.js';
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
import { readPublicationFingerprint } from './startup-read.js';
import { storeMemoryIn } from './store-identity.js';
import { productPageTemplate } from '../knowledge/page-template-kind.js';
import { homeKind } from '../product/manifest/kinds.js';
import { publicationContractOf, publicationReadSelector } from './publication-contract.js';

// Raise this whenever publication logic changes, even when its input and contract stay the same.
const PUBLICATION_REVISION = 6;

export interface ValidatedManifests {
  readonly folder: string;
  readonly manifest: KindsManifest;
  readonly vertices: readonly VertexDraft[];
  readonly edges: readonly EdgeDraft[];
  /** The starter value sets, written as their own entities beside the catalogue's declarations. */
  readonly starterValues: readonly VertexDraft[];
  readonly templates: readonly VertexDraft[];
  readonly templatePaths: readonly string[];
  readonly snapshots: readonly VertexDraft[];
}
export type ManifestValidation = { readonly ok: true; readonly value: ValidatedManifests | undefined } | { readonly ok: false; readonly findings: readonly Finding[]; readonly templatePaths: readonly string[] };

/** What the installation of one producer resolved to in one store, while that store stands. */
interface InstalledBinding { readonly productId: number; readonly productUid: string; readonly sourceId: number; readonly sourceUid: string }
/**
 * The installation a producer wrote once: its product and plugin identities were discovered from
 * the graph and its metadata asserted, and neither moves afterwards — a plugin's identity is its
 * producer and scope, and a producer publishes one plugin (madarch-64o5.176). Remembered per
 * producer, contract revision and granted permissions, so a process binds its writer from what it
 * already installed instead of rebuilding the rights from the graph on every transaction; the
 * store's own token (store-identity.ts) empties it when the schema is replaced. What a remembered
 * installation may not skip is whether it still stands as it wrote it: the product and the plugin's
 * own metadata are read as one batch under the graph write lock, and a store that lost them — a
 * start over, or a store this process has not seen — is discovered again.
 */
const installedBindings = new WeakMap<DatabaseOwner, { readonly token: string; readonly value: Map<string, InstalledBinding> }>();
const pendingBindings = new WeakMap<SqlExecutor, Promise<void>>();

export async function startupBinding(tx: SqlExecutor, declared: GraphContract, producer: string, permissions?: WriteCapability['permissions'], operationUid?: string): Promise<{ contract: GraphContract; binding: WriteCapability }> {
  // Advisory locks serialize PostgreSQL transactions. Calls sharing one executor hold the same lock
  // and must also take turns discovering identities and binding the transaction's write capability.
  const previous = pendingBindings.get(tx) ?? Promise.resolve();
  const pending = previous.then(() => installStartupBinding(tx, declared, producer, permissions, operationUid));
  const tail = pending.then(() => undefined, () => undefined);
  pendingBindings.set(tx, tail);
  try {
    return await pending;
  } finally {
    if (pendingBindings.get(tx) === tail) pendingBindings.delete(tx);
  }
}

async function installStartupBinding(tx: SqlExecutor, declared: GraphContract, producer: string, permissions?: WriteCapability['permissions'], operationUid?: string): Promise<{ contract: GraphContract; binding: WriteCapability }> {
  return await withSpan('graph.manifest-publication.startupBinding', { 'db.system': 'postgres' }, async () => {
    const prepared = preparePublicationContract(declared);
    const { contract } = prepared;
    await acquireGraphWriteLock(tx);
    const hostPermissions: WriteCapability['permissions'] = [...contract.vertex, ...contract.edge].map(kind => ({ kind: kind.name, properties: ['*'], assert: true, retractOwn: true }));
    const remembered = await storeMemoryIn(tx, installedBindings, () => new Map<string, InstalledBinding>());
    const key = JSON.stringify([producer, prepared.version, permissions ?? null]);
    const installed = remembered?.get(key);
    const metadata = { installation: JSON.stringify(['system-engine', producer]), version: runningVersion(), label: producer };
    if (installed !== undefined) {
      // What is remembered is what this process installed; what it may not skip is whether that installation
      // still stands as it wrote it — the product, the plugin and the plugin's own metadata, read as one batch.
      const [product, plugin] = (await readKindsAssertions(tx, [
        { sort: 'vertex', kind: 'system.product', fields: [], identities: [{ id: installed.productId, uid: installed.productUid, key: {} }] },
        { sort: 'vertex', kind: 'plugin', fields: ['installation', 'scope', 'version', 'label'], identities: [{ id: installed.sourceId, uid: installed.sourceUid, key: {} }] },
      ], await publicationReadSelector(tx, contract))).map(records => records[0]);
      const stands = product !== undefined && product.activeSources.length > 0 && plugin !== undefined && plugin.activeSources.includes(installed.sourceUid)
        && Object.entries({ ...metadata, scope: installed.productUid }).every(([property, value]) => plugin.selectedAssertions.some(assertion => assertion.property === property && assertion.source === installed.sourceUid && assertion.value === value));
      if (stands) {
        const binding: WriteCapability = { productUid: installed.productUid, sourceUid: installed.sourceUid, principalUid: installed.sourceUid, operationUid: operationUid ?? newUid(), context: 1, scope: installed.productUid, contractVersion: prepared.version, permissions: permissions ?? hostPermissions };
        if (operationUid === undefined) {
          // The operation is the engine's own lineage: it is written under the host's rights, never a caller's narrower grant.
          bindWriteCapability(tx, { ...binding, permissions: hostPermissions });
          await publishOperation(tx, contract, binding, installed.sourceUid);
        }
        bindWriteCapability(tx, binding);
        return { contract, binding };
      }
      remembered!.delete(key);
    }
    await tx.query('SELECT pg_advisory_xact_lock($1::bigint)', [739141]);
    const identities = (await tx.query<{ id: string; uid: string; key: Record<string, unknown>; kind: string }>(
      "SELECT n.id::text,n.uid::text,n.key,k.name AS kind FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name IN ('system.product','plugin') ORDER BY n.uid")).rows;
    const products = identities.filter(row => row.kind === 'system.product');
    if (products.length > 1) throw new Error(`${import.meta.path}:54: installation has more than one product identity`);
    const productUid = products[0]?.uid ?? newUid();
    const installation = metadata.installation;
    const records = await readKindsAssertions(tx, [
      { sort: 'vertex', kind: 'system.product', fields: [], identities: products.map(row => ({ ...row, id: Number(row.id) })) },
      { sort: 'vertex', kind: 'plugin', fields: ['installation', 'scope', 'version', 'label'], identities: identities.filter(row => row.kind === 'plugin').map(row => ({ ...row, id: Number(row.id) })) },
    ], await publicationReadSelector(tx, contract));
    const plugins = records[1]!.filter(record => record.values['installation'] === installation && record.values['scope'] === productUid);
    if (plugins.length > 1) throw new Error(`${import.meta.path}:62: ambiguous installed engine plugin ${producer}`);
    const plugin = plugins[0];
    const sourceUid = plugin?.uid ?? newUid();
    const ownsOperation = operationUid === undefined;
    operationUid ??= newUid();
    const missing = [
      ...(products.length === 0 ? [['system.product', productUid] as const] : []),
      ...(plugin === undefined ? [['plugin', sourceUid] as const] : []),
      ...(ownsOperation ? [['system.operation', operationUid] as const] : []),
    ];
    for (const [kind, uid] of missing) await bootstrapWriteIdentity(tx, kind, uid, productUid);
    const made = missing.length === 0 ? [] : (await tx.query<{ id: string; uid: string }>('SELECT id::text,uid::text FROM node WHERE uid=ANY($1::uuid[])', [missing.map(([, uid]) => uid)])).rows;
    const ids = new Map([...identities, ...made].map(row => [row.uid, row.id]));
    const binding: WriteCapability = { productUid, sourceUid, principalUid: sourceUid, operationUid, context: 1, scope: productUid, contractVersion: prepared.version, permissions: permissions ?? hostPermissions };
    bindWriteCapability(tx, { ...binding, permissions: hostPermissions });
    const assert = async (kind: string, uid: string, property: string, value: unknown): Promise<void> => {
      await writeAssertion(tx, contract, { sort: 'vertex', kind, subjectId: ids.get(uid)!, property, operation: 'assert', value });
    };
    if ((records[0]![0]?.activeSources.length ?? 0) === 0) await assert('system.product', productUid, '$exists', true);
    if (!plugin?.activeSources.includes(sourceUid)) await assert('plugin', sourceUid, '$exists', true);
    if (ownsOperation) await publishOperation(tx, contract, binding, sourceUid);
    const changedMetadata = Object.entries({ installation, scope: productUid, version: metadata.version, label: producer })
      .filter(([property, value]) => !plugin?.selectedAssertions.some(assertion => assertion.property === property && assertion.source === sourceUid && assertion.value === value));
    if (changedMetadata.length) await writeAssertions(tx, contract, changedMetadata.map(([property, value]) => ({sort:'vertex',kind:'plugin',subjectId:ids.get(sourceUid)!,property,operation:'assert',value})));
    bindWriteCapability(tx, binding);
    const productId = ids.get(productUid), sourceId = ids.get(sourceUid);
    if (productId !== undefined && sourceId !== undefined) remembered?.set(key, { productId: Number(productId), productUid, sourceId: Number(sourceId), sourceUid });
    return { contract, binding };
  });
}

/** The operation one write transaction runs under: the lineage every assertion it writes is attributed to. */
async function publishOperation(tx: SqlExecutor, contract: GraphContract, binding: WriteCapability, sourceUid: string): Promise<void> {
  await publishGraphDrafts(tx, contract, { vertices: [{kind:'system.operation',uid:binding.operationUid,key:{},values:{},producer:sourceUid,producerVersion:binding.contractVersion ?? 'system'}], removals: [], edges: [{
    kind: 'system.operation-author', from: { kind: 'system.operation', uid: binding.operationUid, key: {} }, to: { kind: 'plugin', uid: sourceUid, key: {} },
    producer: sourceUid, producerVersion: binding.contractVersion ?? 'system',
  }] });
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
  if (read.present && findings.length === 0) {
    const installed = new Set(withAssertionContract(withManifestContract(graphContractOf(read.manifest))).vertex.map(kind => kind.name));
    for (const [name, kind] of read.manifest.kinds) for (const relation of kind.relations ?? []) {
      const target = relation.to.split(':')[0]!;
      if (!read.manifest.kinds.has(target) && !read.manifest.catalog?.kinds.has(target) && !installed.has(target)) {
        findings.push({ file: read.manifest.kindFiles?.get(name) ?? KINDS_FILE, line: relation.line,
          message: `relation ${relation.type} from ${name} names undeclared kind ${target}` });
      }
    }
  }
  // Workflows are checked even when no kinds file was written.
  for (const finding of workflow.findings) if (!findings.some((one) => one.file === finding.file && one.line === finding.line && one.message === finding.message)) findings.push(finding);
  for (const finding of pluginDeclarationFindings(files, folder, read.present ? read.manifest : undefined)) if (!findings.some((one) => one.message === finding.message)) findings.push(finding);
  const templateSources = files.filesBelow('templates').filter(path => ['.yaml', '.yml'].includes(extname(path))).map(path => ({
    name: path.slice('templates/'.length, -extname(path).length), body: declarationContent(files, folder, path, 1), path,
  })).sort((left, right) => byCodePoint(left.name, right.name));
  const templatePaths = templateSources.map(template => template.path);
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
  const templateKind = productPageTemplate(manifest);
  const { nameField: nameRole, bodyField: bodyRole, pathField: pathRole } = templateKind;
  const templates: VertexDraft[] = templateSources.map(template => ({
    kind: templateKind.name, key: { [nameRole]: template.name },
    values: { [bodyRole]: template.body, ...(pathRole === undefined ? {} : { [pathRole]: template.path }) },
    evidence: evidence(template.path, 1), producer: 'manifest', producerVersion: '1',
  }));
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
  // A declared prerequisite may name a protected engine kind the product does not declare (decision 0039 item 9): the
  // manifest gives it the same kind vertex a relation's protected endpoint gets, taken from the installed contract.
  const installedKind = (name: string): import('./contract.js').VertexContract | undefined =>
    withAssertionContract(withManifestContract(graphContractOf(manifest))).vertex.find((vertex) => vertex.name === name);
  const ensureKindVertex = (name: string, path: string, line: number): void => {
    if (manifest.kinds.has(name) || (manifest.catalog?.kinds.has(name) ?? false)) return;
    if (vertices.some((vertex) => vertex.kind === 'manifest.kind' && vertex.key['name'] === name)) return;
    const installed = installedKind(name);
    if (installed === undefined) throw new Error(`${import.meta.path}:${line}: depends-on names undeclared kind ${name}`);
    add('kind', name, { contract: installed, protected: true, taken: false, plugins: [] }, path, line);
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
      ensureKindVertex(relation.to.split(':')[0]!, path, relation.line);
      addEdge(MANIFEST_RELATION_EDGE, name, relation.to.split(':')[0]!, { from: name, ...relation }, path, relation.line, relation.type);
    }
    for (const dependency of kind.derivesFrom ?? []) { ensureKindVertex(dependency, path, kind.line); addEdge(MANIFEST_DEPENDS_ON, name, dependency, { from: name, to: dependency, via: 'derives-from' }, path, kind.line); }
  }
  for (const [name, kind] of manifest.catalog?.kinds ?? []) if (!manifest.kinds.has(name)) {
    const path = manifest.kindFiles?.get(name) ?? KINDS_FILE;
    add('kind', name, { catalog: kind, derivesFrom: kind.derivesFrom, taken: false, plugins: [] }, path, kind.line);
    for (const dependency of kind.derivesFrom ?? []) { ensureKindVertex(dependency, path, kind.line); addEdge(MANIFEST_DEPENDS_ON, name, dependency, { from: name, to: dependency, via: 'derives-from' }, path, kind.line); }
  }
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
  return { ok: true, value: { folder, manifest, vertices, edges: combinedEdges, starterValues, templates, templatePaths, snapshots: [...snapshots.values()] } };
}

import { deriveStageGraphOver } from '../fill/registry.js';
import { createEngineStageRegistry } from '../fill/stages/index.js';
function workflowDependencies(stages: readonly string[]): readonly { from: string; to: string; via: string }[] {
  const read = deriveStageGraphOver(createEngineStageRegistry(), stages);
  if (!read.ok) throw new Error('the validated workflow no longer derives');
  return read.graph.edges;
}

/** A borrowed view whose transactions share one cancellation lifetime; it never owns the pool. */
export function publicationDatabaseOwner(owner: DatabaseOwner, signal: AbortSignal): DatabaseOwner {
  return {
    location: owner.location,
    ready: owner.ready,
    allowConcurrentSnapshots: owner.allowConcurrentSnapshots,
    hasVector: owner.hasVector,
    transaction: (kind, work, options) => owner.transaction(kind, work, { signal: options?.signal === undefined ? signal : AbortSignal.any([signal, options.signal]) }),
    run: owner.run.bind(owner),
    exec: owner.exec.bind(owner),
    onClose: owner.onClose.bind(owner),
    close: owner.close.bind(owner),
  };
}

/**
 * One transaction closes removed declarations and states the entire valid catalogue atomically; the product's own page
 * is stated beside it, when the product's files name one and the graph holds none (the home page opens on the product).
 */
/** All semantic inputs to publication; evidence for the page comes from catalogue snapshots, not entity.evidence. */
export function publicationFingerprint(validated: ValidatedManifests, contract: GraphContract,
  entity: Pick<import('../product/manifest.js').ProductEntity, 'kind' | 'key' | 'values'> | null,
  revision = PUBLICATION_REVISION, version = runningVersion()): string {
  // Arrays retain declared order: evidence indices and workflow positions carry meaning.
  return sha256Hex(new TextEncoder().encode(canonicalJson(encode({
    snapshots: validated.snapshots, vertices: validated.vertices, edges: validated.edges,
    starterValues: validated.starterValues, templates: validated.templates, contract: graphContractVersion(contract), revision, version,
    entity: entity === null ? null : { kind: entity.kind, key: entity.key, values: entity.values },
  }))));
}

export async function publishValidatedManifests(owner: DatabaseOwner, validated: ValidatedManifests, authored?: GraphContract, signal?: AbortSignal): Promise<number> {
  signal?.throwIfAborted();
  const publishing = signal === undefined ? owner : publicationDatabaseOwner(owner, signal);
  const contract = publicationContractOf(validated.manifest, authored);
  const home = homeKind(validated.manifest);
  const entity = home === undefined ? undefined : productEntityOf(validated.folder, { home }, undefined);
  const fingerprint = publicationFingerprint(validated, contract, entity ?? null);
  const written = await publishing.transaction('write', async tx => {
    await acquireGraphWriteLock(tx);
    if (await readPublicationFingerprint(tx) === fingerprint) return 0;
    const declarations = await publishDeclarations(tx, validated, contract, signal);
    signal?.throwIfAborted();
    await writeProductEntity(tx, entity);
    signal?.throwIfAborted();
    const { contract: publicationContract } = await startupBinding(tx, contract, 'manifest');
    const catalogue = validated.vertices.find(draft => draft.kind === 'manifest.catalogue' && draft.key['name'] === 'product');
    if (catalogue === undefined) throw new Error(`${import.meta.path}:327: publication requires the product catalogue`);
    await publishGraphDrafts(tx, publicationContract, { vertices: [{ ...catalogue,
      values: { publication_fingerprint: fingerprint }, selectedFields: ['publication_fingerprint'],
    }], removals: [] }, 1, { author: 'manifest' });
    await withSpan('graph.manifest.constraints',{},async()=>await tx.query('SET CONSTRAINTS ALL IMMEDIATE'));
    signal?.throwIfAborted();
    return declarations + 1;
  });
  signal?.throwIfAborted();
  return written;
}

/** The declarations phase of the caller's publication transaction. */
async function publishDeclarations(tx: SqlExecutor, validated: ValidatedManifests, authored?: GraphContract, signal?: AbortSignal): Promise<number> {
  return await withSpan('manifest.publishDeclarations', {}, async () => {
    const contract = publicationContractOf(validated.manifest, authored);
    const { contract: publicationContract, binding } = await startupBinding(tx, contract, 'manifest');
    const identity = (draft: Pick<VertexDraft, 'kind' | 'key' | 'keyEdges'>): string => canonicalJson([draft.kind, draft.key, draft.keyEdges ?? {}]);
    // Only valid between writer calls: a publication can create, retract or revive these endpoints.
    const resolvedRefs = new Map<string, { id: string; uid: string }>();
    const prefetchRefs = async (refs: readonly import('./contract.js').EntityRefDraft[]): Promise<void> => {
      const missing = new Map(refs.filter(ref => !resolvedRefs.has(canonicalJson(ref))).map(ref => [canonicalJson(ref), ref]));
      const keys = [...missing.keys()];
      const resolved = await resolveEntityRefs(tx, publicationContract, [...missing.values()]);
      keys.forEach((key, index) => resolvedRefs.set(key, resolved[index]!));
    };
    const resolveRef = (ref: import('./contract.js').EntityRefDraft): { id: string; uid: string } => {
      const resolved = resolvedRefs.get(canonicalJson(ref));
      if (resolved === undefined) throw new Error(`${import.meta.path}: missing prefetched publication reference`);
      return resolved;
    };
    const publish: typeof publishGraphDrafts = async (...args) => {
      try { return await publishGraphDrafts(...args); } finally { resolvedRefs.clear(); }
    };
    const evidenceRefs = (drafts: readonly (VertexDraft | EdgeDraft)[]) => drafts.flatMap(draft => (draft.evidence ?? []).map(evidence => evidence.target));
    const readPhase = async (sort: 'vertex' | 'edge', kinds: readonly string[], drafts: readonly (VertexDraft | EdgeDraft)[]): Promise<Map<string, AssertionRecord[]>> => {
      const fields = new Map(kinds.map(kind => [kind, new Set<string>()]));
      for (const draft of drafts) {
        const held = fields.get(draft.kind) ?? new Set<string>();
        for (const field of Object.keys(draft.values ?? {})) held.add(field);
        fields.set(draft.kind, held);
      }
      const requests = [...fields].map(([kind, fields]) => ({ sort, kind, fields: [...fields] }));
      const records = await readKindsAssertions(tx, requests, await publicationReadSelector(tx, publicationContract));
      return new Map(requests.map((request, index) => [request.kind, records[index]!]));
    };
    const snapshots = await readPhase('vertex', [...new Set(validated.snapshots.map(draft => draft.kind))], validated.snapshots);
    const missingSnapshots = validated.snapshots.filter(draft => {
      const row = snapshots.get(draft.kind)?.find(row => canonicalJson(row.key) === canonicalJson(draft.key));
      return row === undefined || !row.activeSources.includes(binding.sourceUid) ||
        Object.entries(draft.values ?? {}).some(([property, value]) => !row.selectedAssertions.some(assertion => assertion.property === property && assertion.source === binding.sourceUid && canonicalJson(assertion.value) === canonicalJson(value)));
    });
    await publish(tx, publicationContract, { vertices: missingSnapshots, removals: [] });
    const vertexRecords = await readPhase('vertex', MANIFEST_CONTRACT.vertex.map(kind => kind.name), validated.vertices);
    const held = new Map<string, VertexRemovalDraft>();
    const holdRecords = async (kinds: readonly import('./contract.js').VertexContract[], records: Map<string, AssertionRecord[]>): Promise<void> => {
      for (const kind of kinds) for (const row of records.get(kind.name) ?? []) {
        const keyEdges: Record<string, import('./contract.js').EntityRefDraft> = {};
        for (const role of kind.keyEdges ?? []) {
          const [subject, parent] = role.direction === 'from' ? ['from_node', 'to_node'] : ['to_node', 'from_node'];
          const parents = await tx.query<{ kind: string; key: Record<string, import('./contract.js').KeyValueDraft> }>(`SELECT pk.name AS kind,p.key FROM edge e JOIN entity ek ON ek.id=e.entity_id JOIN node p ON p.id=e.${parent} JOIN entity pk ON pk.id=p.entity_id WHERE e.${subject}=$1 AND ek.name=$2`, [row.id, role.edge]);
          if (parents.rows.length !== 1) throw new Error(`${import.meta.path}:405: ${kind.name} ${row.uid} requires exactly one parent for ${role.role}`);
          keyEdges[role.role] = { kind: parents.rows[0]!.kind, key: parents.rows[0]!.key };
        }
        const draft = { kind: kind.name, key: row.key as Record<string, import('./contract.js').KeyValueDraft>, ...(kind.keyEdges?.length ? { keyEdges } : {}), uid: row.uid, producer: 'manifest' };
        held.set(identity(draft), draft);
      }
    };
    await holdRecords(MANIFEST_CONTRACT.vertex, vertexRecords);
    const wanted = new Set(validated.vertices.map(identity));
    const removals = [...held].filter(([key]) => !wanted.has(key)).map(([, draft]) => draft)
      .sort((left, right) => Number(right.keyEdges !== undefined) - Number(left.keyEdges !== undefined) || byCodePoint(identity(left), identity(right)));
    const matchingRecord = (draft: VertexDraft | EdgeDraft, rows: readonly AssertionRecord[]): AssertionRecord | undefined => {
      if (rows.length === 0) return undefined;
      let record: import('./records.js').AssertionRecord | undefined;
      if ('key' in draft) {
        const prior = held.get(identity(draft));
        if (prior !== undefined) record = rows.find(row => row.uid === prior.uid);
        // Every key-edge kind in this phase is indexed by its existing key and parent identity.
        // A missing draft is new, not an endpoint that can already be resolved.
        else if (draft.keyEdges === undefined) record = rows.find(row => canonicalJson(row.key) === canonicalJson(draft.key));
      }
      else {
        const from = resolveRef(draft.from);
        const to = resolveRef(draft.to);
        record = rows.find(row => String(row.from) === String(from.id) && String(row.to) === String(to.id) && (row.discriminator ?? '') === (draft.discriminator ?? ''));
      }
      return record;
    };
    const prefetchEvidence = async (drafts: readonly (VertexDraft | EdgeDraft)[], records: Map<string, AssertionRecord[]>): Promise<void> => {
      await prefetchRefs(evidenceRefs(drafts.filter(draft => matchingRecord(draft, records.get(draft.kind)!)?.activeSources.includes(binding.sourceUid))));
    };
    const unchanged = async (draft: VertexDraft | EdgeDraft, rows: readonly AssertionRecord[]): Promise<boolean> => {
      signal?.throwIfAborted();
      const record = matchingRecord(draft, rows);
      if (record === undefined || !record.activeSources.includes(binding.sourceUid)) return false;
      const expectedEvidence: string[] = [];
      for (const [index, evidence] of (draft.evidence ?? []).entries()) {
        const target = resolveRef(evidence.target);
        expectedEvidence.push(JSON.stringify([target.uid, { index, relation: evidence.relation ?? 'supports', locator: evidence.locator ?? {} }]));
      }
      for (const [property, value] of Object.entries({ '$exists': true, ...draft.values })) {
        const selected = record.selectedAssertions.find(assertion => assertion.property === property && assertion.source === binding.sourceUid);
        if (selected === undefined || JSON.stringify(selected.value) !== JSON.stringify(value)) return false;
        // Reused assertions retain historical evidence; this pass only requires its own attachments.
        const attached = new Set(selected.evidenceAttachments.map(evidence => canonicalJson([evidence.targetUid, JSON.parse(evidence.locator)])));
        if (expectedEvidence.some(value => !attached.has(canonicalJson(JSON.parse(value))))) return false;
      }
      return true;
    };
    await prefetchEvidence(validated.vertices, vertexRecords);
    const vertices: VertexDraft[] = [];
    for (const draft of validated.vertices) if (!await unchanged(draft, vertexRecords.get(draft.kind)!)) vertices.push(draft);
    let written = await publish(tx, publicationContract, { vertices, removals }, 1, { author: 'manifest' });
    const edgeRecords = await readPhase('edge', MANIFEST_CONTRACT.edge.map(kind => kind.name), validated.edges);
    await prefetchRefs(validated.edges.filter(draft => edgeRecords.get(draft.kind)!.length > 0).flatMap(draft => [draft.from, draft.to]));
    await prefetchEvidence(validated.edges, edgeRecords);
    const edges: EdgeDraft[] = [];
    for (const draft of validated.edges) if (!await unchanged(draft, edgeRecords.get(draft.kind)!)) edges.push(draft);
    const wantedEdges = new Set(validated.edges.map(e => JSON.stringify([e.kind,e.from.key,e.to.key,e.discriminator ?? ''])));
    const edgeRemovals: EdgeRemovalDraft[] = [];
    const removableKinds = MANIFEST_CONTRACT.edge.filter(kind => !MANIFEST_CONTRACT.vertex.some(vertex => vertex.keyEdges?.some(role => role.edge === kind.name)));
    const edgeIds = removableKinds.flatMap(kind => edgeRecords.get(kind.name)!.map(record => record.id));
    const edgeEnds = edgeIds.length === 0 ? [] : (await tx.query<{ id: string; from_key: Record<string,string>; to_key: Record<string,string> }>(
      'SELECT e.id::text AS id,f.key AS from_key,t.key AS to_key FROM edge e JOIN node f ON f.id=e.from_node JOIN node t ON t.id=e.to_node WHERE e.id=ANY($1::bigint[])', [edgeIds])).rows;
    const endsById = new Map(edgeEnds.map(row => [row.id, row]));
    for (const kind of removableKinds) {
      const records = edgeRecords.get(kind.name)!;
      for (const record of records) {
        const one=endsById.get(String(record.id))!;
        if (!wantedEdges.has(JSON.stringify([kind.name,one.from_key,one.to_key,record.discriminator ?? '']))) edgeRemovals.push({kind:kind.name,from:{kind:'manifest.kind',key:one.from_key},to:{kind:'manifest.kind',key:one.to_key},discriminator:record.discriminator,producer:'manifest'});
      }
    }
    written += await publish(tx, publicationContract, { vertices: [], edges, removals: [], edgeRemovals }, 1, { author: 'manifest' });
    const valueKinds = new Set(validated.starterValues.map((draft) => draft.kind));
    if (valueKinds.size > 0) {
      const records = await readPhase('vertex', [...valueKinds], validated.starterValues);
      await holdRecords(publicationContract.vertex.filter(kind => valueKinds.has(kind.name)), records);
      await prefetchEvidence(validated.starterValues, records);
      const changed: VertexDraft[] = [];
      for (const draft of validated.starterValues) if (!await unchanged(draft, records.get(draft.kind)!)) changed.push(draft);
      written += await publish(tx, publicationContract, { vertices: changed, edges: [], removals: [] }, 1, { author: 'manifest' });
    }
    const { name: kindName, nameField: nameRole } = productPageTemplate(validated.manifest);
    const currentTemplates = await readKindAssertions(tx, 'vertex', kindName, [], await publicationReadSelector(tx, publicationContract));
    const wantedTemplates = new Set(validated.templates.map(draft => String(draft.key[nameRole])));
    const removedTemplates: VertexRemovalDraft[] = currentTemplates.filter(row => !wantedTemplates.has(String(row.key[nameRole]))).map(row => ({
      kind: kindName, key: row.key as VertexRemovalDraft['key'], producer: 'manifest',
    }));
    written += await publish(tx, publicationContract, { vertices: validated.templates, removals: removedTemplates }, 1, { author: 'manifest' });
    await reconcileDisputes(tx, publicationContract, 'all');
    return written;
  });
}


/** The complete validated metadata, never a read of the checkout or a fallback to it. */
export async function readPublishedManifest(tx: SqlExecutor, selector: import('./records.js').AssertionRecordSelector = {}): Promise<KindsManifest | undefined> {
  return await withSpan('manifest.readPublished', {}, async () => {
    const rows = await readKindAssertions(tx, 'vertex', 'manifest.catalogue', ['declaration'], selector);
    const value = rows.find(row => row.key['name'] === 'product')?.values['declaration'];
    return value === undefined ? undefined : decode(JSON.parse(String(value))) as KindsManifest;
  });
}
