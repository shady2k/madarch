/** Exhaustive graph-truth audit. The same runner reads either pinned engine.
 * Every raw and published row is retained, including duplicates and diagnostics.
 * Missing source spans are counted, never hidden by provenance classifications.
 */
import {mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, readlinkSync} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import {evidenceError as validateEvidence, originEvidence,importReadingEvidence} from './extract-truth-evidence.js';
import {safeAuditOutput} from './extract-truth-safety.js';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {byCodePoint} from '../src/model/order.js';
import type {Extraction, TreeReader} from '../src/extract/records.js';
const argument = (name: string, fallback?: string): string => {
 const at = process.argv.indexOf(`--${name}`);
 const value = at < 0 ? fallback : process.argv[at + 1];
 if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`${resolve(import.meta.path)}:13: --${name} requires an explicit value`);
 return value;
};
const engine = resolve(argument('engine', '.'));
const repository = resolve(argument('repository'));
const outputRoot = safeAuditOutput(resolve(argument('out', '/tmp/madarch-extract-audit')),[engine,repository]);
// These are the executing implementation, independent of the selected baseline/candidate engine.
const runtimePaths=[import.meta.path,resolve(import.meta.dir,'extract-truth-evidence.ts'),resolve(import.meta.dir,'extract-truth-safety.ts'),resolve(import.meta.dir,'../src/model/order.ts')].sort(byCodePoint);
const runtimeInventory=()=>runtimePaths.map((path)=>({path:resolve(path),sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}));
const runtimeFiles=runtimeInventory();
const runtimeDigest=createHash('sha256').update(JSON.stringify(runtimeFiles)).digest('hex');
mkdirSync(outputRoot, {recursive: true});
const out = mkdtempSync(join(outputRoot, 'run-'));
const runId = randomUUID();
const save = (name: string, value: unknown): void => writeFileSync(join(out, `${name}.json`), JSON.stringify(value, null, 2)+'\n');
const identity = {runId, engine, repository, started: new Date().toISOString(), runtimeFiles, runtimeDigest, engineFiles: [] as {path: string; sha256: string}[], fixtureFiles: [] as {path: string; sha256: string}[]};
save('identity', identity);
console.log(`AUDIT_RUN ${runId} ${out}`);
let phase = 'identity';
let repositoryHead: string | undefined;
try {
 const inventory = (root: string): {path: string; sha256: string}[] => {
  const files: {path: string; sha256: string}[] = [];
  const visit = (directory: string): void => {
   for (const item of readdirSync(join(root, directory), {withFileTypes: true}).sort((a, b) => byCodePoint(a.name, b.name))) {
    if (['.git', 'node_modules', '.cache', 'dist'].includes(item.name)) continue;
    const path = directory === '' ? item.name : `${directory}/${item.name}`;
    if (item.isDirectory()) visit(path);
    else if (item.isFile()) files.push({path, sha256: createHash('sha256').update(readFileSync(join(root, path))).digest('hex')});
    else if (item.isSymbolicLink()) files.push({path, sha256: createHash('sha256').update(`symlink:${readlinkSync(join(root, path))}`).digest('hex')});
   }
  };
  visit(''); return files.sort((a, b) => byCodePoint(a.path, b.path));
 };
 identity.engineFiles = inventory(engine); identity.fixtureFiles = inventory(repository); save('identity', identity);
 const engineDigest = createHash('sha256').update(JSON.stringify(identity.engineFiles)).digest('hex');
 const fixtureDigest = createHash('sha256').update(JSON.stringify(identity.fixtureFiles)).digest('hex');
 save('input-digests', {runId, engineDigest, fixtureDigest, runtimeDigest});
 phase = 'imports';
 const load = async (path: string) => await import(pathToFileURL(join(engine, path)).href);
const {commitTree, walkDefaultBranch} = await load('src/extract/driver/git.ts') as typeof import('../src/extract/driver/git.js');
const {TREE_EXTRACTORS, OWNERS, HISTORY_EXTRACTOR} = await load('src/extract/driver/extractors.ts') as typeof import('../src/extract/driver/extractors.js');
phase = 'tree';
const walk = walkDefaultBranch(repository, 'HEAD'); const head = walk.at(-1);
if (head === undefined) throw new Error(`${repository}:1: audited default branch has no commits`);
repositoryHead = head.hash; save('repository-head', {hash: head.hash});
const tree: TreeReader = commitTree(repository, head.hash);
const fixtureTreeFiles = [...tree.paths].sort(byCodePoint).map((path) => ({path, sha256: createHash('sha256').update(tree.read(path)).digest('hex')}));
const fixtureTreeDigest = createHash('sha256').update(JSON.stringify(fixtureTreeFiles)).digest('hex');
save('audited-tree-identity', {runId, head: head.hash, fixtureTreeDigest, files: fixtureTreeFiles});
const extractions: Extraction[] = [];
phase = 'raw-extraction';
for (const [index, extractor] of TREE_EXTRACTORS.entries()) {
 phase = `raw-extractor-${index}`;
 extractions.push(await extractor(tree, extractions.find((entry) => entry.producer === 'code.extract.code')));
 save('raw-extractions-partial', {complete: false, extractions});
}
phase = 'history-extraction';
extractions.push(await HISTORY_EXTRACTOR({path: repository, snapshots: {}}));
interface AuditNode {
 key: string; identity?: string; version?: string; kind: string; label: string;
 evidence: unknown; producer: string; recordKey?: string | null; properties: Record<string, unknown>;
 [field: string]: unknown;
}
interface AuditEdge {
 type: string; from: string; to: string; discriminator: string; producer: string;
 sourceProducer?: string | null; evidence: unknown; properties: Record<string, unknown>;
 position?: {start: number; end: number} | null; [field: string]: unknown;
}
const evidenceError = (value: unknown): string | null => validateEvidence(tree, value);
function duplicates<T>(rows: readonly T[], identity: (row: T) => string): {identity: string; rows: T[]}[] {
 const groups = new Map<string, T[]>();
 for (const row of rows) {const key = identity(row); const held = groups.get(key) ?? []; held.push(row); groups.set(key, held);}
 return [...groups].filter(([, held]) => held.length > 1).sort(([a], [b]) => byCodePoint(a, b)).map(([key, held]) => ({identity: key, rows: held}));
}
function edgeIdentity(edge: AuditEdge): string {
 const span = edge.evidence as {byteStart?: number; byteEnd?: number} | null;
 const position = edge.position ?? (edge.type === 'code.occurrence' && span !== null ? {start: span.byteStart, end: span.byteEnd} : null);
 return JSON.stringify([edge.producer, edge.type, edge.from, edge.to, edge.discriminator, edge.type === 'code.occurrence' ? position : null]);
}
function audit(nodes: readonly AuditNode[], edges: readonly AuditEdge[]): Record<string, unknown> {
 const connected = new Set(edges.flatMap((edge) => [edge.from, edge.to])); const keys = new Set(nodes.map((node) => node.identity ?? node.key));
 const kinds = [...new Set(nodes.map((node) => node.kind))].sort(byCodePoint);
 const perKind = kinds.map((kind) => {const members = nodes.filter((node) => node.kind === kind); return {kind, total: members.length, noEdge: members.filter((node) => !connected.has(node.identity ?? node.key)).map((node) => node.key).sort(byCodePoint), noEvidence: members.filter((node) => evidenceError(node.evidence) !== null).map((node) => node.key).sort(byCodePoint)};});
 const origins = edges.flatMap((edge)=>originEvidence(tree,edge.properties).map((origin)=>({edge, ...origin})));
 const importReadings=edges.flatMap((edge)=>importReadingEvidence(tree,edge.properties).map((reading)=>({edge,...reading})));
 const perRelation = [...new Set(edges.map((edge) => edge.type))].sort(byCodePoint).map((type) => ({type, total: edges.filter((edge) => edge.type === type).length}));
 return {nodes: nodes.length, edges: edges.length, occurrences: edges.filter((edge) => edge.type === 'code.occurrence').length, perKind, perRelation,
  originEvidence: {total:origins.length, invalid:origins.filter((origin)=>origin.error!==null), rows:origins},
  importReadings:{total:importReadings.length,invalid:importReadings.filter((reading)=>reading.error!==null),rows:importReadings},
  missingEndpoints: edges.filter((edge) => !keys.has(edge.from) || !keys.has(edge.to)),
  duplicateNodes: duplicates(nodes, (node) => JSON.stringify([node.producer, node.identity ?? node.key])),
  sharedDeclarations: duplicates(nodes, (node) => node.key),
  duplicateEdges: duplicates(edges, edgeIdentity),
  unkeyedNodes: nodes.filter((node) => node.recordKey === null),
  invalidEvidence: nodes.flatMap((node) => {const reason = evidenceError(node.evidence); return reason === null ? [] : [{key: node.key, producer: node.producer, reason, evidence: node.evidence}];}),
  edgeEvidence: {positioned: edges.filter((edge) => edge.evidence !== null).length,
   withOrigins: edges.filter((edge)=>Array.isArray(edge.properties['origins'])).length,
   compatibilitySpanAbsentWithOrigins: edges.filter((edge)=>edge.evidence===null&&Array.isArray(edge.properties['origins'])),
   invalid: edges.filter((edge) => Array.isArray(edge.properties['origins'])
    ? originEvidence(tree,edge.properties).some((origin)=>origin.error!==null)
    : (edge.evidence !== null || edge.type === 'code.occurrence') && evidenceError(edge.evidence) !== null)},
  provenanceRequiringSeparateAssessment: nodes.filter((node) => evidenceError(node.evidence) !== null).map((node) => ({key: node.key, kind: node.kind, producer: node.producer, properties: node.properties, evidence: node.evidence})),
 };
}
const rawNodes: AuditNode[] = extractions.flatMap((extraction) => extraction.nodes.map((node, index) => ({...node, index, producer: extraction.producer, evidence: node.span ?? null})));
const rawEdges: AuditEdge[] = extractions.flatMap((extraction) => extraction.edges.map((edge, index) => ({...edge, index, producer: extraction.producer, evidence: edge.span ?? null})));
save('raw-extractions', extractions); save('raw-nodes', rawNodes); save('raw-edges', rawEdges);
const raw = audit(rawNodes, rawEdges); save('raw-summary', raw);
const {createPGliteDatabaseOwner} = await load('src/adapters/database-owner.ts') as typeof import('../src/adapters/database-owner.js');
const {createGraphStore} = await load('src/graph/index.ts') as typeof import('../src/graph/index.js');
const {fillGraph} = await load('src/extract/driver/index.ts') as typeof import('../src/extract/driver/index.js');
phase = 'store-start';
const owner = createPGliteDatabaseOwner({btreeGist: true}); const store = createGraphStore(owner);
try {
 phase = 'fill';
 await owner.ready; await store.createSchema();
 const report = await fillGraph({owner, store, repository, extractors: TREE_EXTRACTORS, owners: OWNERS, history: HISTORY_EXTRACTOR});
 save('fill-report', report);
 const nodes = (await owner.run((tx) => tx.query<AuditNode>(`SELECT coalesce(v.properties->>'recordKey', '[unkeyed:' || v.node_id::text || ']') AS key, v.node_id::text AS identity, v.id::text AS version, v.properties->>'recordKey' AS "recordKey", coalesce(k.key, '[missing-kind]') AS kind, v.label, v.producer, v.properties, v.properties->'span' AS evidence, v.valid_from::text AS "validFrom", v.valid_to::text AS "validTo", v.recorded_from::text AS "recordedFrom", v.states::text AS states FROM node_version v LEFT JOIN node_kind k ON k.id=v.kind_id WHERE v.scope_id=$2::bigint AND v.recorded_to='infinity' AND v.valid_from <= $1::timestamptz AND v.valid_to > $1::timestamptz ORDER BY k.key COLLATE "C", v.node_id, v.id`, [head.effectiveTime, report.repositoryNode]))).rows;
 const edges = (await owner.run((tx) => tx.query<AuditEdge>(`SELECT coalesce(r.key, '[missing-relation]') AS type, e.edge_id::text AS identity, e.id::text AS version, e.src_id::text AS "from", e.dst_id::text AS "to", e.discriminator, e.producer, e.properties, e.properties->>'sourceProducer' AS "sourceProducer", e.properties->'span' AS evidence, CASE WHEN e.byte_start IS NULL THEN NULL ELSE jsonb_build_object('start', e.byte_start, 'end', e.byte_end) END AS position, e.valid_from::text AS "validFrom", e.valid_to::text AS "validTo", e.recorded_from::text AS "recordedFrom", e.states::text AS states FROM edge_version e LEFT JOIN relation_type r ON r.id=e.relation_type_id WHERE e.scope_id=$2::bigint AND e.recorded_to='infinity' AND e.valid_from <= $1::timestamptz AND e.valid_to > $1::timestamptz ORDER BY r.key COLLATE "C", e.src_id, e.dst_id, e.discriminator COLLATE "C", e.byte_start, e.id`, [head.effectiveTime, report.repositoryNode]))).rows;
 save('nodes', nodes); save('edges-stored', edges);
 save('import-readings',edges.flatMap((edge)=>importReadingEvidence(tree,edge.properties).map((reading)=>({edgeVersion:edge['version'],edgeIdentity:edge['identity'],...reading}))));
 save('origins', edges.flatMap((edge)=>originEvidence(tree,edge.properties).map((origin)=>({edgeVersion:edge['version'],edgeIdentity:edge['identity'],...origin}))));
 // Occurrence positions live in byte_start/end, not properties.span. Resolve the
 // reading path from the source declaration only when exactly one path exists.
 // Retain the stored row separately; ambiguous/missing paths remain diagnostics.
 save('occurrences-stored', edges.filter((edge) => edge.type === 'code.occurrence'));
 const occurrences = edges.filter((edge) => edge.type === 'code.occurrence').map((edge): AuditEdge => {
  const sources = nodes.filter((node) => node.identity === edge.from);
  const paths = [...new Set(sources.flatMap((node) => {
   const span = node.evidence as {path?: unknown} | null;
   const path = span?.path ?? node.properties['path'] ?? (node.key.startsWith('code.file:') ? node.key.slice('code.file:'.length) : null);
   return typeof path === 'string' ? [path] : [];
  }))].sort(byCodePoint);
  const path = paths.length === 1 ? paths[0]! : null;
  const bytes = path !== null && tree.paths.includes(path) ? tree.read(path) : null;
  const position = edge.position;
  const linesThrough = (end: number): number => {let line = 1; for (const byte of bytes!.subarray(0, end)) if (byte === 10) line++; return line;};
  const evidence = path !== null && position != null && bytes !== null ? {path, byteStart: position.start, byteEnd: position.end, lineStart: linesThrough(position.start), lineEnd: linesThrough(Math.max(position.start, position.end - 1))} : null;
  return {...edge, storedEvidence: edge.evidence, evidence, evidenceResolution: {source: 'stored byte position and source node declaration', sourceNodes: sources.map((node) => ({key: node.key, identity: node.identity, version: node.version})), paths, error: evidence === null ? 'occurrence source path or position is unresolved' : evidenceError(evidence)}};
 });
 const occurrenceByVersion = new Map(occurrences.map((edge) => [edge['version'], edge]));
 const evidencedEdges = edges.map((edge) => occurrenceByVersion.get(edge['version']) ?? edge);
 save('occurrences', occurrences); save('edges', evidencedEdges);
 const summary = {runId, engine, repository, runtimeDigest, repositoryHead: head.hash, engineDigest, fixtureDigest, fixtureTreeDigest, identityDigest: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
  evidenceRules: {lines: 'start is the byte-start line; end is either the exclusive-end position line (syntax/whole-file convention) or the last covered character line (positioned-site convention); both must be computed from exact bytes', nodes: 'every row is counted; Git/history provenance requires a separate assessment, never a hidden row', edges: 'structural edges may lack a reading site; every occurrence retains its stored byte position and source-resolution result', expectations: 'no observed diagnostic is automatically approved or suppressed'},
  raw, published: audit(nodes, evidencedEdges), gaps: report.gaps};
 save('summary', summary);
 for (const [phase, result] of [['raw', summary.raw], ['published', summary.published]] as const) for (const row of result['perKind'] as {kind: string; total: number; noEdge: string[]; noEvidence: string[]}[]) console.log(`${phase}\t${row.kind}\t${row.total}\tno-edge=${row.noEdge.length}\tno-evidence=${row.noEvidence.length}`);
 console.log(`AUDIT ${out}`);
} finally {await owner.close();}
phase = 'input-immutability';
if(JSON.stringify(runtimeFiles)!==JSON.stringify(runtimeInventory()))throw new Error(`${resolve(import.meta.path)}: executing runner or static runtime helper changed during audit`);
if (JSON.stringify(identity.engineFiles) !== JSON.stringify(inventory(engine)) || JSON.stringify(identity.fixtureFiles) !== JSON.stringify(inventory(repository))) throw new Error(`${resolve(import.meta.path)}: inputs changed during the audit; no complete report is accepted`);
save('completion', {runId, complete: true, finished: new Date().toISOString()});
} catch (error) {
 let runtimeUnchanged=false;try {runtimeUnchanged=JSON.stringify(runtimeFiles)===JSON.stringify(runtimeInventory());}catch {}
 save('failure', {runtimeUnchanged,runId, complete: false, phase, engine, repository, repositoryHead, identity, error: error instanceof Error ? {message: error.message, stack: error.stack} : String(error)}); throw error;}

