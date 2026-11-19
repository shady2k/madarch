/** Effective graph records from typed assertions (decision 0039, items 14, 25 and 30). */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { GraphContract } from './contract.js';
import type { SqlExecutor } from '../sql-driver.js';
import { withSpan } from '../obs/trace.js';
import { checkRoleProperties, semanticRoleFields } from '../model/semantic-role-protocol.js';
import { loadAssertionsBatch, type StoredAssertion } from './assertion-read.js';
import { listDisputeSlots } from './dispute-read.js';
import { withAssertionContract, isDisputableProperty } from './system-contract.js';

export interface AssertionRecord {
  id: number; uid: string; key: Record<string, unknown>; values: Record<string, unknown>;
  assertions: StoredAssertion[]; selectedAssertions: readonly StoredAssertion[]; activeSources: readonly string[]; from?: number; to?: number; discriminator?: string;
}

export interface AssertionRecordRequest {
  readonly sort: 'vertex' | 'edge';
  readonly kind: string;
  readonly fields: readonly string[];
  readonly repositoryKinds?: readonly string[];
  readonly subjectUids?: readonly string[];
  readonly subjectIds?: readonly number[];
  readonly identities?: readonly { id: number; uid: string; key: Record<string, unknown> }[];
}
export interface AssertionRecordSelector {
  readonly contract?: GraphContract;
  readonly validAt?: string;
  readonly recordedAt?: string;
  readonly contexts?: readonly number[];
  readonly contextRecordedThrough?: Readonly<Record<number, string | null>>;
}

/** A batch reads identities once, then applies item 25 entirely in SQL. */
export async function readKindsAssertions(tx: SqlExecutor, requests: readonly AssertionRecordRequest[], selector: AssertionRecordSelector = {}): Promise<AssertionRecord[][]> {
  return await withSpan('graph.records.batch', {}, async () => {
    const suppliedIdentities = requests.every(request => request.identities !== undefined);
    const hasMerges = suppliedIdentities || (await tx.query<{ present: boolean }>(`SELECT EXISTS(SELECT 1 FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='system.merge') AS present`)).rows[0]!.present;
    const context = Number(selector.contexts?.[0] ?? 1);
    const instant = (value: string | undefined): string => value === undefined ? 'transaction_timestamp()' : "'" + new Date(value).toISOString() + "'::timestamptz";
    const valid = instant(selector.validAt);
    const recorded = instant(selector.recordedAt);
    const canonical = (id: string): string => hasMerges ? `graph_merge_target(${id},${context},${valid},${recorded})` : id;
    type Identity = { id: number; uid: string; key: Record<string, unknown>; from_node?: number; to_node?: number; discriminator?: string };
    const identities: Identity[][] = requests.map(request => [...request.identities ?? []]);
    const parameters: unknown[] = [];
    const statements = requests.flatMap((request,index) => {
      if (request.identities !== undefined || request.subjectIds?.length === 0 || request.subjectUids?.length === 0) return [];
      parameters.push(request.kind);
      const where = [`k.name=$${parameters.length}`];
      if (request.subjectIds !== undefined) { parameters.push(request.subjectIds); where.push(request.sort === 'vertex' && hasMerges ? `n.id IN (SELECT ${canonical('requested.id')} FROM unnest($${parameters.length}::bigint[]) requested(id))` : `n.id=ANY($${parameters.length}::bigint[])`); }
      if (request.subjectUids !== undefined) { parameters.push(request.subjectUids); where.push(request.sort === 'vertex' && hasMerges ? `n.id IN (SELECT ${canonical('requested.id')} FROM node requested WHERE requested.uid=ANY($${parameters.length}::uuid[]))` : `n.uid=ANY($${parameters.length}::uuid[])`); }
      if (request.sort === 'vertex' && hasMerges) where.push(`${canonical('n.id')}=n.id`);
      return [`SELECT ${index}::integer AS request_index,n.id,n.uid::text,${request.sort === 'vertex' ? 'n.key,NULL::bigint AS from_node,NULL::bigint AS to_node,NULL::text AS discriminator' : "'{}'::jsonb AS key,n.from_node,n.to_node,n.discriminator"} FROM ${request.sort === 'vertex' ? 'node' : hasMerges ? `graph_effective_edges(${context},${valid},${recorded})` : 'edge'} n JOIN entity k ON k.id=n.entity_id WHERE ${where.join(' AND ')}`];
    });
    if (statements.length > 0) for (const row of (await tx.query<Identity & { request_index: number }>(statements.join(' UNION ALL '),parameters)).rows) identities[Number(row.request_index)]!.push(row);
    const disputable = requests.some(request => ['$exists', ...request.fields].some(property => isDisputableProperty(request.sort, request.kind, property)));
    if (disputable && selector.contract === undefined) throw new Error(`${import.meta.path}:72: product assertion reads require an explicit graph contract for dispute resolution`);
    let snapshot: { now: string | Date; anchored: boolean } | undefined;
    // A page already supplied its identities. Probe for persisted questions in its
    // assertion statement; only an anchored dispute needs the full lineage read.
    const pageExecutor: SqlExecutor = { query: async <Row extends object>(sql: string, parameters?: readonly unknown[]) => {
      const result = await tx.query<Row & { now: string | Date; anchored: boolean; id: string | null }>(`
        WITH page_snapshot AS MATERIALIZED (
          SELECT transaction_timestamp() AS now,
            EXISTS(SELECT 1 FROM edge e JOIN entity k ON k.id=e.entity_id WHERE k.name='system.dispute-anchor') AS anchored
        ) SELECT assertions.*,page_snapshot.now,page_snapshot.anchored
          FROM page_snapshot LEFT JOIN LATERAL (${sql}) assertions ON TRUE`, parameters);
      snapshot = result.rows[0];
      return { rows: result.rows.filter(row => row.id !== null) };
    } };
    const load = async (resolvedAssertionIds: readonly string[], executor: SqlExecutor = tx) => await loadAssertionsBatch(executor, requests.map((request,index) => ({ sort: request.sort, kind: request.kind, properties: [...new Set(['$exists', ...request.fields])], ...(request.repositoryKinds === undefined ? {} : { repositoryKinds: request.repositoryKinds }), subjectIds: identities[index]!.map(row => Number(row.id)), unprojectedProperties: selector.contract?.vertex.find(kind => kind.name === request.kind)?.key ?? [] })), { ...selector, projectMergedSubjects: hasMerges, resolvedAssertionIds });
    let loaded: StoredAssertion[][] | undefined;
    if (suppliedIdentities) loaded = await load([], pageExecutor);
    const now = disputable && (!suppliedIdentities || snapshot?.anchored) ? new Date(snapshot?.now ?? (await tx.query<{ now: string | Date }>('SELECT transaction_timestamp() AS now')).rows[0]!.now).toISOString() : undefined;
    const disputes = disputable && (!suppliedIdentities || snapshot?.anchored) ? await listDisputeSlots(tx, withAssertionContract(selector.contract!), { validAt: selector.validAt ?? now!, recordedAt: selector.recordedAt ?? now!, contexts: selector.contexts ?? [1], ...(selector.contextRecordedThrough === undefined ? {} : { contextRecordedThrough: selector.contextRecordedThrough }) }) : [];
    const resolvedAssertionIds = disputes.flatMap(slot => slot.dispute.selectedAssertionUid === null ? [] : [slot.dispute.selectedAssertionUid]);
    if (loaded === undefined || resolvedAssertionIds.length > 0) loaded = await load(resolvedAssertionIds);
    const bySubject = loaded.map(assertions => {
      const grouped = new Map<number, StoredAssertion[]>();
      for (const assertion of assertions) {
        const own = grouped.get(assertion.subjectId);
        if (own === undefined) grouped.set(assertion.subjectId, [assertion]);
        else own.push(assertion);
      }
      return grouped;
    });
    return requests.map((request,index) => identities[index]!.flatMap(row => {
      const own = bySubject[index]!.get(Number(row.id)) ?? [];
      const chosen = own.filter(assertion => assertion.selected);
      const existence = chosen.filter(assertion => assertion.property === '$exists');
      if (!existence.some(assertion => assertion.value === true)) return [];
      const values = Object.fromEntries(chosen.map(assertion => [assertion.property, assertion.value]));
      values['$exists'] = true;
      return [{ id: Number(row.id), uid: row.uid, key: row.key, values, assertions: own, selectedAssertions: chosen,
        activeSources: [...new Set(own.filter(assertion => assertion.active && assertion.property === '$exists' && assertion.value === true).map(assertion => assertion.source))],
        ...(request.sort === 'vertex' ? {} : { from: Number(row.from_node), to: Number(row.to_node), discriminator: row.discriminator! }) }];
    }));
  });
}

/** Internal numeric joins never become public identities. */
export async function readKindAssertions(tx: SqlExecutor, sort: 'vertex' | 'edge', kind: string, fields: readonly string[], selector: AssertionRecordSelector & Pick<AssertionRecordRequest, 'subjectUids' | 'subjectIds' | 'identities' | 'repositoryKinds'> = {}): Promise<AssertionRecord[]> {
  return await withSpan('graph.records.kind', { 'graph.kind': kind }, async () => (await readKindsAssertions(tx, [{ sort, kind, fields, ...(selector.repositoryKinds === undefined ? {} : { repositoryKinds: selector.repositoryKinds }), ...(selector.identities === undefined ? {} : { identities: selector.identities }), ...(selector.subjectUids === undefined ? {} : { subjectUids: selector.subjectUids }), ...(selector.subjectIds === undefined ? {} : { subjectIds: selector.subjectIds }) }], selector))[0]!);
}
type SemanticRecord = Omit<AssertionRecord, 'key'>;

interface SemanticRequest { readonly role: string; readonly fields: readonly string[]; readonly edgeRole?: string }
async function semanticRecordBatch(tx: SqlExecutor, requests: readonly SemanticRequest[]): Promise<SemanticRecord[][]> {
  const { readPublishedManifest } = await import('./manifest-publication.js');
  const { graphContractOf } = await import('../fill/stages/plugin-contract.js');
  const manifest = await readPublishedManifest(tx);
  if (manifest === undefined) throw new Error(`${import.meta.path}:113: semantic graph reads require the published manifest`);
  const contract = graphContractOf(manifest);
  const plans = requests.map(({ role, fields, edgeRole }) => {
    const binding = manifest.semanticBindings?.get(role);
    if (binding === undefined) throw new Error(`${manifest.file}:1: semantic-bindings.${role} is required by this read`);
    const edge = edgeRole === undefined ? undefined : binding.edges?.[edgeRole];
    if (edgeRole !== undefined && edge === undefined) throw new Error(`${manifest.file}:${binding.line}: semantic-bindings.${role}.edges.${edgeRole} is required by this read`);
    const kind = edge?.kind ?? binding.kind;
    const sort = edgeRole === undefined ? 'vertex' : 'edge';
    const mappings: Readonly<Record<string,string>> = edge === undefined ? binding.fields : edge.fields ?? {};
    const declaration = contract[sort].find(candidate => candidate.name === kind);
    if (declaration === undefined) throw new Error(`${manifest.file}:${binding.line}: semantic role ${role} names undeclared ${sort} ${kind}`);
    for (const field of fields) if (mappings[field] === undefined) throw new Error(`${manifest.file}:${binding.line}: semantic role ${role}${edgeRole === undefined ? '' : '.' + edgeRole} requires field binding ${field}`);
    const actualFields = [...new Set(fields.map(field => mappings[field]!))];
    for (const field of actualFields) if (!declaration.fields.some(candidate => candidate.name === field)) throw new Error(`${manifest.file}:${binding.line}: semantic role ${role} names undeclared field ${kind}.${field}`);
    const keys = 'key' in declaration ? declaration.key : [];
    return { role, edgeRole, binding, edge, mappings, keys, request: { sort, kind, fields: actualFields.filter(field => !keys.includes(field)) } satisfies AssertionRecordRequest };
  });
  const batches = await readKindsAssertions(tx, plans.map(plan => plan.request), { contract });
  return plans.map(({ role, edgeRole, binding, edge, mappings, keys }, index) => batches[index]!.map(row => {
    const values: Record<string,unknown> = {};
    for (const [semantic, actual] of Object.entries(mappings)) {
      // Declared identity fields are immutable keys, not asserted property fallbacks.
      let value = keys.includes(actual) ? row.key[actual] : row.values[actual];
      const vocabulary = edge === undefined ? binding.values?.[semantic] : undefined;
      if (vocabulary !== undefined && value != null) {
        const match = Object.entries(vocabulary).find(([, actualValue]) => actualValue === value);
        if (match === undefined) throw new Error(`${manifest.file}:${binding.line}: semantic role ${role}.${semantic} has no declared value for ${JSON.stringify(value)}`);
        value = match[0];
      }
      values[semantic] = value;
    }
    checkRoleProperties(edgeRole === undefined ? role : `${role}.${edgeRole}`, values, `${manifest.file}:${binding.line}`);
    return { ...row, values, ...(edge === undefined || edge.direction === 'from' ? {} : { from: row.to, to: row.from }) };
  }));
}


const fileFields = semanticRoleFields('file');
const repoFields = semanticRoleFields('repository');
const commitFields = semanticRoleFields('commit');
export interface FileRecord { readonly path:string; readonly mode:string|null; readonly blob:string|null; readonly bytes:number|null; readonly form:'text'|'binary'|null; readonly lines:number|null; readonly language:string|null; readonly candidates:readonly string[] }
export interface FileDate { readonly date:string; readonly offsetMin:number; readonly commit:string; readonly author:string }
export interface CommitRecord { readonly hash:string; readonly parents:readonly string[]; readonly author:{readonly name:string;readonly email:string}; readonly authorDate:string; readonly authorOffsetMin:number; readonly commitDate:string; readonly commitOffsetMin:number; readonly subject:string }
export interface RepositoryFacts { readonly nodeId:string; readonly name:string; readonly url:string; readonly defaultBranch:string|null; readonly asIsCommit:string|null; readonly hasTree:boolean; readonly fileCount:number; readonly commitCount:number; readonly directoryCount:number; readonly historyShallow:boolean|null }
function scalar(row: SemanticRecord | undefined, field: string): unknown { return row?.values[field]; }
function text(v:unknown):string|null { return v == null ? null : String(v); }
function number(v:unknown):number|null { return v == null ? null : Number(v); }
/** 0039 item 1: a reader traverses relations, so a repository's files are its whole contains tree, not its direct children. */
function contained(root: number, edges: readonly SemanticRecord[]): Set<number> {
  const children = new Map<number, number[]>();
  for (const edge of edges) {
    if (edge.from === undefined || edge.to === undefined) continue;
    const from = Number(edge.from), held = children.get(from) ?? [];
    held.push(Number(edge.to));
    children.set(from, held);
  }
  const reached = new Set<number>();
  const queue = [Number(root)];
  while (queue.length > 0) {
    for (const child of children.get(queue.pop()!) ?? []) if (!reached.has(child)) { reached.add(child); queue.push(child); }
  }
  return reached;
}
function file(row:SemanticRecord):FileRecord { const v=row.values; return {path:String(v['path']),mode:text(v['mode']),blob:text(v['blob']),bytes:number(v['bytes']),form:v['form']==='text'||v['form']==='binary'?v['form']:null,lines:number(v['lines']),language:text(v['language']),candidates:Array.isArray(v['languages'])?v['languages'] as string[]:[]}; }

async function files(tx:SqlExecutor,name:string) { const [repositories=[]]=await semanticRecordBatch(tx,[{role:'repository',fields:repoFields}]);const repo=repositories.find(r=>r.values['name']===name);if(repo===undefined)return [];const [contains=[],allFiles=[]]=await semanticRecordBatch(tx,[{role:'repository',fields:[],edgeRole:'contains'},{role:'file',fields:fileFields}]);const ids=contained(Number(repo.id),contains!);return allFiles!.filter(f=>ids.has(Number(f.id))).sort((a,b)=>String(a.values['path'])<String(b.values['path'])?-1:1); }
export async function listFiles(owner:DatabaseOwner,input:{readonly repository:string;readonly prefix?:string;readonly language?:string;readonly after?:string;readonly limit:number;readonly projection?:'map'}):Promise<{readonly rows:readonly FileRecord[];readonly next:string|null}> {
 return await withSpan('records.listFiles',{},async()=>await owner.transaction('snapshot',async tx=>{const all=(await files(tx,input.repository)).map(file).filter(f=>(input.prefix===undefined||f.path.startsWith(input.prefix))&&(input.language===undefined||f.language===input.language)&&(input.after===undefined||f.path>input.after));const rows=all.slice(0,input.limit);return {rows,next:all.length>input.limit?rows.at(-1)!.path:null};}));
}
export async function productFileIndex(owner:DatabaseOwner,repository:string) { return (await listFiles(owner,{repository,limit:Number.MAX_SAFE_INTEGER})).rows; }
export async function listRepositories(owner:DatabaseOwner,_declared?:ReadonlySet<string>):Promise<readonly {name:string;url:string;defaultBranch:string|null;asIsCommit:string|null}[]> { return await withSpan('records.repositories',{},async()=>await owner.transaction('snapshot',async tx=>{ const [repos=[],edges=[],commits=[]]=await semanticRecordBatch(tx,[{role:'repository',fields:repoFields},{role:'repository',fields:[],edgeRole:'asIs'},{role:'commit',fields:['hash']}]);return repos.map(r=>({name:String(r.values['name']),url:text(r.values['url'])??'',defaultBranch:text(r.values['default_branch']),asIsCommit:text(scalar(commits.find(c=>c.id===edges.find(e=>e.from===r.id)?.to),'hash'))})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);})); }
export async function repositoryFacts(owner:DatabaseOwner,name:string,_declared?:ReadonlySet<string>):Promise<RepositoryFacts|null> { return await withSpan('records.repositoryFacts',{},async()=>await owner.transaction('snapshot',async tx=>{ const [repositories=[]]=await semanticRecordBatch(tx,[{role:'repository',fields:repoFields}]);const r=repositories.find(r=>r.values['name']===name);if(r===undefined)return null;const [contains=[],fs=[],dirs=[],history=[],asIsEdges=[],commits=[]]=await semanticRecordBatch(tx,[{role:'repository',fields:[],edgeRole:'contains'},{role:'file',fields:[]},{role:'directory',fields:[]},{role:'repository',fields:[],edgeRole:'history'},{role:'repository',fields:[],edgeRole:'asIs'},{role:'commit',fields:['hash']}]);const ids=contained(Number(r.id),contains);const asIs=asIsEdges.find(e=>e.from===r.id);return {nodeId:String(r.id),name,url:text(r.values['url'])??'',defaultBranch:text(r.values['default_branch']),asIsCommit:text(scalar(commits.find(c=>c.id===asIs?.to),'hash')),hasTree:typeof r.values['tree_snapshot'] === 'string' && r.values['tree_snapshot'].length > 0,fileCount:fs.filter(f=>ids.has(f.id)).length,directoryCount:dirs.filter(d=>ids.has(d.id)).length,commitCount:history.filter(e=>e.from===r.id).length,historyShallow:typeof r.values['history_shallow']==='boolean'?r.values['history_shallow']:null};})); }
function gitClock(value:unknown,offset:number):string { if(value==null)return '';const local=new Date(new Date(String(value)).getTime()+offset*60000).toISOString().slice(0,19);return `${local}${offset<0?'-':'+'}${String(Math.floor(Math.abs(offset)/60)).padStart(2,'0')}:${String(Math.abs(offset)%60).padStart(2,'0')}`; }
function commitRecord(hash:string,commits:readonly SemanticRecord[],parents:readonly SemanticRecord[],authoredEdges:readonly SemanticRecord[],authors:readonly SemanticRecord[]):CommitRecord|null {
 const c=commits.find(c=>c.values['hash']===hash);if(c===undefined)return null;
 const parentEdges=parents.filter(e=>e.from===c.id).sort((a,b)=>Number(a.values['position'])-Number(b.values['position']));
 const authored=authoredEdges.find(e=>e.to===c.id);const author=authors.find(a=>a.id===authored?.from);
 const ao=Number(c.values['author_offset_min']??0),co=Number(c.values['commit_offset_min']??0);
 return {hash,parents:parentEdges.map(e=>String(scalar(commits.find(c=>c.id===e.to),'hash'))),author:{name:String(scalar(author,'name')??''),email:String(scalar(author,'email')??'')},subject:String(c.values['subject']??''),authorDate:gitClock(c.values['author_date'],ao),authorOffsetMin:ao,commitDate:gitClock(c.values['commit_date'],co),commitOffsetMin:co};
}
async function commit(tx:SqlExecutor,hash:string):Promise<CommitRecord|null> {
 const [commits=[]]=await semanticRecordBatch(tx,[{role:'commit',fields:commitFields}]);
 if(!commits.some(c=>c.values['hash']===hash))return null;
 const [parents=[],authored=[],authors=[]]=await semanticRecordBatch(tx,[{role:'commit',fields:semanticRoleFields('commit.parent'),edgeRole:'parent'},{role:'author',fields:[],edgeRole:'authored'},{role:'author',fields:semanticRoleFields('author')}]);
 return commitRecord(hash,commits,parents,authored,authors);
}
export async function commitFacts(owner:DatabaseOwner,_repository:string,hash:string):Promise<CommitRecord|null> {return await withSpan('records.commitFacts',{},async()=>await owner.transaction('snapshot',tx=>commit(tx,hash)));}
export async function fileFacts(owner:DatabaseOwner,repositoryName:string,path:string,options:{readonly history?:boolean}={}):Promise<(FileRecord&{readonly created:FileDate|null;readonly modified:FileDate|null;readonly commitCount:number;readonly authors:readonly string[]})|null>{return await withSpan('records.fileFacts',{},async()=>await owner.transaction('snapshot',async tx=>{const f=(await files(tx,repositoryName)).find(f=>f.values['path']===path);if(f===undefined)return null;const history: {walk:number;fact:FileDate}[]=[];if(options.history!==false){const [repositories=[],renamed=[],touched=[],walks=[],commits=[],parents=[],authored=[],authors=[]]=await semanticRecordBatch(tx,[{role:'repository',fields:repoFields},{role:'file',fields:[],edgeRole:'renamedFrom'},{role:'commit',fields:[],edgeRole:'touched'},{role:'repository',fields:semanticRoleFields('repository.history'),edgeRole:'history'},{role:'commit',fields:commitFields},{role:'commit',fields:semanticRoleFields('commit.parent'),edgeRole:'parent'},{role:'author',fields:[],edgeRole:'authored'},{role:'author',fields:semanticRoleFields('author')}]);const repo=repositories.find(r=>r.values['name']===repositoryName);const ids=new Set([f.id]);let changed=true;while(changed){changed=false;for(const e of renamed)if(ids.has(e.from!)&&!ids.has(e.to!)){ids.add(e.to!);changed=true;}}for(const e of touched.filter(e=>ids.has(e.to!))){const walk=walks.find(w=>w.from===repo?.id&&w.to===e.from);if(walk===undefined)continue;const c=commits.find(c=>c.id===e.from);if(c===undefined)continue;const facts=commitRecord(String(c.values['hash']),commits,parents,authored,authors);if(facts!==null)history.push({walk:Number(walk.values['walk']),fact:{date:facts.commitDate,offsetMin:facts.commitOffsetMin,commit:facts.hash,author:facts.author.name}});}}history.sort((a,b)=>a.walk-b.walk);return {...file(f),created:history.at(-1)?.fact??null,modified:history[0]?.fact??null,commitCount:new Set(history.map(h=>h.fact.commit)).size,authors:[...new Set(history.map(h=>h.fact.author))].sort()};}));}
export async function graphKindCounts(owner:DatabaseOwner):Promise<readonly {kind:string;count:number}[]> {
 return await withSpan('records.kindCounts',{},async()=>await owner.transaction('snapshot',async tx=>{
  const { readPublishedManifest } = await import('./manifest-publication.js');
  const { graphContractOf } = await import('../fill/stages/plugin-contract.js');
  const manifest=await readPublishedManifest(tx);
  if(manifest===undefined)throw new Error(`${import.meta.path}:190: repository reads require the published graph contract`);
  const contract=graphContractOf(manifest);
  const kinds=await tx.query<{name:string}>(`SELECT name FROM entity WHERE sort='node' ORDER BY name COLLATE "C"`);
  const declared=kinds.rows.filter(kind=>contract.vertex.some(declaration=>declaration.name===kind.name));
  const records=await readKindsAssertions(tx,declared.map(kind=>({sort:'vertex',kind:kind.name,fields:[]})),{contract});
  const counts=new Map(declared.map((kind,index)=>[kind.name,records[index]!.length]));
  return kinds.rows.map(kind=>({kind:kind.name,count:counts.get(kind.name)??0}));
 }));
}

/** One currently supported assertion whose retained evidence is stale or unavailable. */
export interface StaleEvidence {
  readonly kind: string;
  readonly key: Readonly<Record<string, unknown>>;
  readonly opinion: string;
  readonly producer: string;
  readonly evidence: import('./contract.js').EvidenceEntry;
  readonly reason: string;
  readonly applicability: 'stale' | 'unavailable';
  readonly state: import('./evidence-read.js').EvidenceState;
}

/** Evaluate current assertion support without rewriting its independent historical validity. */
export async function vanishedCurrentEvidence(owner: DatabaseOwner, contract: GraphContract, query: import('./consistency.js').ConsistencyQuery = {}): Promise<import('./consistency.js').ConsistencyPage<StaleEvidence>> {
  const limit = query.limit ?? 200;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error(`${import.meta.path}:181: evidence page limit must be an integer from 1 to 1000`);
  return await withSpan('graph.vanishedCurrentEvidence', {}, async () => await owner.transaction('snapshot', async tx => {
    const { readPublishedManifest } = await import('./manifest-publication.js');
    const { evidenceSupportRoles } = await import('./evidence-support.js');
    const { readEvidenceStates } = await import('./evidence-read.js');
    const manifest = await readPublishedManifest(tx);
    const support = evidenceSupportRoles(manifest?.semanticBindings);
    const now = new Date((await tx.query<{ now: string | Date }>('SELECT transaction_timestamp() AS now')).rows[0]!.now).toISOString();
    const selector = { validAt: now, recordedAt: now, contexts: [1] };
    const candidates: { kind: string; key: Record<string, unknown>; assertion: StoredAssertion; target: string; targetKind: string; targetKey: Record<string, import('./contract.js').KeyValueDraft>; locator: Record<string, unknown>; relation: string; cursor: string }[] = [];
    for (const sort of ['vertex', 'edge'] as const) for (const kind of contract[sort]) {
      const fields = kind.fields.filter(field => sort === 'edge' || !('key' in kind && kind.key.includes(field.name))).map(field => field.name);
      const records = await readKindAssertions(tx, sort, kind.name, fields, { contract, ...selector });
      for (const record of records) {
        const active = new Set(record.activeSources);
        const assertions = record.assertions.filter(assertion => assertion.active && active.has(assertion.source) && assertion.evidence.length > 0);
        if (assertions.length === 0) continue;
        const links = await tx.query<{ assertion: string; target: string; target_kind: string; target_key: Record<string, import('./contract.js').KeyValueDraft>; discriminator: string; uid: string }>(
          `SELECT origin.uid::text AS assertion,target.uid::text AS target,k.name AS target_kind,target.key AS target_key,e.discriminator,e.uid::text AS uid
           FROM edge e JOIN entity ek ON ek.id=e.entity_id JOIN node origin ON origin.id=e.from_node
           JOIN node target ON target.id=e.to_node JOIN entity k ON k.id=target.entity_id
           WHERE ek.name='system.assertion-evidence' AND origin.uid=ANY($1::uuid[])`, [assertions.map(assertion => assertion.id)]);
        for (const link of links.rows) {
          const cursor = `${link.assertion}:${link.uid}`;
          if (query.after !== undefined && cursor <= query.after) continue;
          const attachment = JSON.parse(link.discriminator) as { locator: Record<string, unknown>; relation: string };
          candidates.push({ kind: kind.name, key: sort === 'vertex' ? record.key : { from: record.from, to: record.to, discriminator: record.discriminator }, assertion: assertions.find(assertion => assertion.id === link.assertion)!, target: link.target, targetKind: link.target_kind, targetKey: link.target_key, ...attachment, cursor });
        }
      }
    }
    candidates.sort((a, b) => a.cursor < b.cursor ? -1 : a.cursor > b.cursor ? 1 : 0);
    const page = candidates.slice(0, limit);
    const states = await readEvidenceStates(tx, contract, page.map(candidate => ({ targetUid: candidate.target, locator: candidate.locator, assertion: candidate.assertion })), selector, support);
    const rows: StaleEvidence[] = [];
    for (const [index, candidate] of page.entries()) {
      const state = states[index]!;
      const applicability = state.currentApplicability === 'stale' ? 'stale' : state.availability === 'unavailable' || state.currentApplicability === 'unknown' ? 'unavailable' : undefined;
      if (applicability === undefined) continue;
      rows.push({ kind: candidate.kind, key: candidate.key, opinion: candidate.assertion.id, producer: candidate.assertion.source,
        evidence: { target: { kind: candidate.targetKind, uid: candidate.target, key: candidate.targetKey }, locator: candidate.locator, relation: candidate.relation },
        reason: applicability === 'stale' ? 'the immutable evidence no longer supports the current source' : state.issues.join('; ') || 'current evidence support is unavailable', applicability, state });
    }
    return { rows, ...(candidates.length > limit ? { next: page.at(-1)!.cursor } : {}) };
  }));
}
