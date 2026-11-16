/** Effective graph records from typed assertions (decision 0039, items 14, 25 and 30). */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { GraphContract } from './contract.js';
import { isDisputableProperty, withAssertionContract } from './system-contract.js';
import { listDisputeSlots } from './disputes.js';
import type { SqlExecutor } from '../sql-driver.js';
import { withSpan } from '../obs/trace.js';
import { checkRoleProperties, semanticRoleFields } from '../model/semantic-role-protocol.js';
import { loadAssertionsBatch, selectAssertionSlots, type StoredAssertion } from './assertion-read.js';

export interface AssertionRecord {
  id: number; uid: string; key: Record<string, unknown>; values: Record<string, unknown>;
  assertions: StoredAssertion[]; selectedAssertions: readonly StoredAssertion[]; activeSources: readonly string[]; from?: number; to?: number; discriminator?: string;
}

export interface AssertionRecordRequest {
  readonly sort: 'vertex' | 'edge';
  readonly kind: string;
  readonly fields: readonly string[];
  readonly subjectUids?: readonly string[];
  readonly subjectIds?: readonly number[];
}
export interface AssertionRecordSelector {
  readonly contract?: GraphContract;
  readonly validAt?: string;
  readonly recordedAt?: string;
  readonly contexts?: readonly number[];
  readonly contextRecordedThrough?: Readonly<Record<number, string | null>>;
}

/** One logical read shares its clock, typed storage walk and canonical dispute arbitration. */
export async function readKindsAssertions(tx: SqlExecutor, requests: readonly AssertionRecordRequest[], selector: AssertionRecordSelector = {}): Promise<AssertionRecord[][]> {
  return await withSpan('graph.records.batch', {}, async () => {
    const active = requests.map((request, index) => ({ ...request, index, disputable: ['$exists', ...request.fields].some(property => isDisputableProperty(request.sort, request.kind, property)) }));
    for (const request of active) if (request.disputable && selector.contract === undefined) throw new Error(`${import.meta.path}:35: product assertion reads require an explicit graph contract for dispute resolution`);
    const reads = active.filter(request => request.subjectUids?.length !== 0 && request.subjectIds?.length !== 0);
    if (reads.length === 0) return requests.map(() => []);
    const parameters: unknown[] = [];
    const queries = reads.map(request => {
      parameters.push(request.kind);
      const predicates = [`k.name=$${parameters.length}`];
      if (request.subjectUids !== undefined) { parameters.push(request.subjectUids); predicates.push(`n.uid=ANY($${parameters.length}::uuid[])`); }
      if (request.subjectIds !== undefined) { parameters.push(request.subjectIds); predicates.push(`n.id=ANY($${parameters.length}::bigint[])`); }
      return `SELECT ${request.index}::integer AS request_index,n.id,n.uid::text,${request.sort === 'vertex' ? 'n.key,NULL::bigint AS from_node,NULL::bigint AS to_node,NULL::text AS discriminator' : "'{}'::jsonb AS key,n.from_node,n.to_node,n.discriminator"},transaction_timestamp() AS read_at FROM ${request.sort === 'vertex' ? 'node' : 'edge'} n JOIN entity k ON k.id=n.entity_id WHERE ${predicates.join(' AND ')}`;
    });
    const identities = await tx.query<{ request_index: number; id: number; uid: string; key: Record<string, unknown>; from_node: number | null; to_node: number | null; discriminator: string | null; read_at: string | Date }>(queries.join(' UNION ALL '), parameters);
    const identityGroups = requests.map(() => [] as typeof identities.rows);
    for (const row of identities.rows) identityGroups[Number(row.request_index)]!.push(row);
    const loaded = await loadAssertionsBatch(tx, reads.map(request => ({ sort: request.sort, kind: request.kind, properties: [...new Set(['$exists', ...request.fields])], subjectIds: identityGroups[request.index]!.map(row => Number(row.id)) })));
    const readAt = identities.rows[0]?.read_at ?? (await tx.query<{ now: string | Date }>('SELECT transaction_timestamp() AS now')).rows[0]!.now;
    const now = new Date(readAt).toISOString();
    const temporal = { validAt: selector.validAt ?? now, recordedAt: selector.recordedAt ?? now, contexts: selector.contexts ?? [1], ...(selector.contextRecordedThrough === undefined ? {} : { contextRecordedThrough: selector.contextRecordedThrough }) };
    const disputes = reads.some(request => request.disputable) ? await listDisputeSlots(tx, withAssertionContract(selector.contract!), temporal) : [];
    const result: AssertionRecord[][] = requests.map(() => []);
    for (const [index, request] of reads.entries()) {
      const { sort, kind, disputable } = request;
      const assertions = loaded[index]!;
      const ownIdentities = identityGroups[request.index]!;
      const slots = new Map(selectAssertionSlots(assertions, temporal));
      const resolvedIds = new Set<string>();
      if (disputable) {
        const chosenIds = new Set(disputes.flatMap(slot => slot.sort === sort && slot.kind === kind && slot.dispute.selectedAssertionUid !== null ? [slot.dispute.selectedAssertionUid] : []));
        for (const id of chosenIds) resolvedIds.add(id);
        for (const [key, selection] of slots) {
          const chosen = selection.candidates.find(row => chosenIds.has(row.id));
          if (chosen !== undefined) slots.set(key, { ...selection, selected: chosen, contested: false });
        }
      }
      const selected = new Set([...slots.values()].flatMap(s => s.selected === null ? [] : [s.selected.id]));
      const bySubject = new Map<number, StoredAssertion[]>();
      for (const assertion of assertions) {
        const own = bySubject.get(assertion.subjectId) ?? [];
        own.push(assertion);
        bySubject.set(assertion.subjectId, own);
      }
      const assertionSubjects = new Map(assertions.map(assertion => [assertion.id, assertion.subjectId]));
      const subjectSlots = new Map<number, (typeof slots extends Map<string, infer S> ? S : never)[]>();
      for (const slot of slots.values()) {
        const subjectId = slot.candidates[0] === undefined ? undefined : assertionSubjects.get(slot.candidates[0].id);
        if (subjectId === undefined) continue;
        const own = subjectSlots.get(subjectId) ?? [];
        own.push(slot);
        subjectSlots.set(subjectId, own);
      }
      result[request.index] = ownIdentities.flatMap(row => {
        const own = bySubject.get(Number(row.id)) ?? [];
        const ownSlots = subjectSlots.get(Number(row.id)) ?? [];
        const values = Object.fromEntries(own.filter(a => selected.has(a.id)).map(a => [a.property,a.value]));
        const existence = ownSlots.filter(slot => slot.candidates.some(candidate => candidate.property === '$exists'));
        const decided = existence.flatMap(slot => slot.candidates.filter(candidate => resolvedIds.has(candidate.id)));
        const exists = decided.length > 0 ? decided.some(candidate => candidate.value === true) : existence.some(slot => slot.candidates.some(candidate => candidate.value === true));
        if (!exists) return [];
        values['$exists'] = true;
        const activeSources = [...new Set(existence.flatMap(slot => slot.candidates.filter(a => a.value === true).map(a => a.source)))];
        return [{id:Number(row.id),uid:row.uid,key:row.key,values,assertions:own,selectedAssertions:own.filter(a => selected.has(a.id)),activeSources,...(sort === 'vertex' ? {} : {from:Number(row.from_node),to:Number(row.to_node),discriminator:row.discriminator ?? undefined})}];
      });
    }
    return result;
  });
}

/** Internal numeric joins never become public identities. */
export async function readKindAssertions(tx: SqlExecutor, sort: 'vertex' | 'edge', kind: string, fields: readonly string[], selector: AssertionRecordSelector & Pick<AssertionRecordRequest, 'subjectUids' | 'subjectIds'> = {}): Promise<AssertionRecord[]> {
  return await withSpan('graph.records.kind', { 'graph.kind': kind }, async () => (await readKindsAssertions(tx, [{ sort, kind, fields, ...(selector.subjectUids === undefined ? {} : { subjectUids: selector.subjectUids }), ...(selector.subjectIds === undefined ? {} : { subjectIds: selector.subjectIds }) }], selector))[0]!);
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
function file(row:SemanticRecord):FileRecord { const v=row.values; return {path:String(v['path']),mode:text(v['mode']),blob:text(v['blob']),bytes:number(v['bytes']),form:v['form']==='text'||v['form']==='binary'?v['form']:null,lines:number(v['lines']),language:text(v['language']),candidates:Array.isArray(v['languages'])?v['languages'] as string[]:[]}; }

async function files(tx:SqlExecutor,name:string) { const [repositories=[]]=await semanticRecordBatch(tx,[{role:'repository',fields:repoFields}]);const repo=repositories.find(r=>r.values['name']===name);if(repo===undefined)return [];const [contains=[],allFiles=[]]=await semanticRecordBatch(tx,[{role:'repository',fields:[],edgeRole:'contains'},{role:'file',fields:fileFields}]);const ids=new Set(contains!.filter(e=>e.from===repo.id).map(e=>e.to));return allFiles!.filter(f=>ids.has(f.id)).sort((a,b)=>String(a.values['path'])<String(b.values['path'])?-1:1); }
export async function listFiles(owner:DatabaseOwner,input:{readonly repository:string;readonly prefix?:string;readonly language?:string;readonly after?:string;readonly limit:number;readonly projection?:'map'}):Promise<{readonly rows:readonly FileRecord[];readonly next:string|null}> {
 return await withSpan('records.listFiles',{},async()=>await owner.transaction('snapshot',async tx=>{const all=(await files(tx,input.repository)).map(file).filter(f=>(input.prefix===undefined||f.path.startsWith(input.prefix))&&(input.language===undefined||f.language===input.language)&&(input.after===undefined||f.path>input.after));const rows=all.slice(0,input.limit);return {rows,next:all.length>input.limit?rows.at(-1)!.path:null};}));
}
export async function productFileIndex(owner:DatabaseOwner,repository:string) { return (await listFiles(owner,{repository,limit:Number.MAX_SAFE_INTEGER})).rows; }
export async function storedFileTexts(owner:DatabaseOwner,repository:string,paths:readonly string[]):Promise<Map<string,string|null>> { return await withSpan('records.fileContents',{},async()=>await owner.transaction('snapshot',async tx=>new Map((await files(tx,repository)).filter(f=>paths.includes(String(f.values['path']))).map(f=>[String(f.values['path']),text(f.values['content'])])))); }
export async function listRepositories(owner:DatabaseOwner,_declared?:ReadonlySet<string>):Promise<readonly {name:string;url:string;defaultBranch:string|null;asIsCommit:string|null}[]> { return await withSpan('records.repositories',{},async()=>await owner.transaction('snapshot',async tx=>{ const [repos=[],edges=[],commits=[]]=await semanticRecordBatch(tx,[{role:'repository',fields:repoFields},{role:'repository',fields:[],edgeRole:'asIs'},{role:'commit',fields:['hash']}]);return repos.map(r=>({name:String(r.values['name']),url:text(r.values['url'])??'',defaultBranch:text(r.values['default_branch']),asIsCommit:text(scalar(commits.find(c=>c.id===edges.find(e=>e.from===r.id)?.to),'hash'))})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);})); }
export async function repositoryFacts(owner:DatabaseOwner,name:string,_declared?:ReadonlySet<string>):Promise<RepositoryFacts|null> { return await withSpan('records.repositoryFacts',{},async()=>await owner.transaction('snapshot',async tx=>{ const [repositories=[]]=await semanticRecordBatch(tx,[{role:'repository',fields:repoFields}]);const r=repositories.find(r=>r.values['name']===name);if(r===undefined)return null;const [contains=[],fs=[],dirs=[],history=[],asIsEdges=[],commits=[]]=await semanticRecordBatch(tx,[{role:'repository',fields:[],edgeRole:'contains'},{role:'file',fields:[]},{role:'directory',fields:[]},{role:'repository',fields:[],edgeRole:'history'},{role:'repository',fields:[],edgeRole:'asIs'},{role:'commit',fields:['hash']}]);const ids=new Set(contains.filter(e=>e.from===r.id).map(e=>e.to));const asIs=asIsEdges.find(e=>e.from===r.id);return {nodeId:String(r.id),name,url:text(r.values['url'])??'',defaultBranch:text(r.values['default_branch']),asIsCommit:text(scalar(commits.find(c=>c.id===asIs?.to),'hash')),hasTree:typeof r.values['tree_snapshot'] === 'string' && r.values['tree_snapshot'].length > 0,fileCount:fs.filter(f=>ids.has(f.id)).length,directoryCount:dirs.filter(d=>ids.has(d.id)).length,commitCount:history.filter(e=>e.from===r.id).length,historyShallow:typeof r.values['history_shallow']==='boolean'?r.values['history_shallow']:null};})); }
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
