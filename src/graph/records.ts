/** Effective graph records from typed assertions (decision 0039, items 14, 25 and 30). */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { GraphContract } from './contract.js';
import { isDisputableProperty, withAssertionContract } from './system-contract.js';
import { listDisputeSlots } from './disputes.js';
import type { SqlExecutor } from '../sql-driver.js';
import { withSpan } from '../obs/trace.js';
import { checkRoleProperties, semanticRoleFields } from '../model/semantic-role-protocol.js';
import { loadAssertions, selectAssertionSlots, type StoredAssertion } from './assertion-read.js';

export interface AssertionRecord {
  id: number; uid: string; key: Record<string, unknown>; values: Record<string, unknown>;
  assertions: StoredAssertion[]; selectedAssertions: readonly StoredAssertion[]; activeSources: readonly string[]; from?: number; to?: number; discriminator?: string;
}

/** Internal numeric joins never become public identities. */
export async function readKindAssertions(tx: SqlExecutor, sort: 'vertex' | 'edge', kind: string, fields: readonly string[], selector: { readonly contract?: GraphContract; readonly validAt?: string; readonly recordedAt?: string; readonly contexts?: readonly number[]; readonly contextRecordedThrough?: Readonly<Record<number, string | null>>; readonly subjectUids?: readonly string[]; readonly subjectIds?: readonly number[] } = {}): Promise<AssertionRecord[]> {
  return await withSpan('graph.records.kind', { 'graph.kind': kind }, async () => {
    const disputable = ['$exists', ...fields].some(property => isDisputableProperty(sort, kind, property));
    if (disputable && selector.contract === undefined) throw new Error(`${import.meta.path}:24: product assertion reads require an explicit graph contract for dispute resolution`);
    if (selector.subjectUids?.length === 0 || selector.subjectIds?.length === 0) return [];
    const parameters: unknown[] = [kind];
    const predicates = ['k.name=$1'];
    if (selector.subjectUids !== undefined) { parameters.push(selector.subjectUids); predicates.push(sort === 'vertex' ? `n.id IN (SELECT graph_merge_target(requested.id,${Number(selector.contexts?.[0] ?? 1)},${selector.validAt === undefined ? 'transaction_timestamp()' : "'" + new Date(selector.validAt).toISOString() + "'::timestamptz"},${selector.recordedAt === undefined ? 'transaction_timestamp()' : "'" + new Date(selector.recordedAt).toISOString() + "'::timestamptz"}) FROM node requested WHERE requested.uid=ANY($${parameters.length}::uuid[]))` : `n.uid=ANY($${parameters.length}::uuid[])`); }
    if (selector.subjectIds !== undefined) { parameters.push(selector.subjectIds); predicates.push(sort === 'vertex' ? `n.id IN (SELECT graph_merge_target(requested.id,${Number(selector.contexts?.[0] ?? 1)},${selector.validAt === undefined ? 'transaction_timestamp()' : "'" + new Date(selector.validAt).toISOString() + "'::timestamptz"},${selector.recordedAt === undefined ? 'transaction_timestamp()' : "'" + new Date(selector.recordedAt).toISOString() + "'::timestamptz"}) FROM unnest($${parameters.length}::bigint[]) requested(id))` : `n.id=ANY($${parameters.length}::bigint[])`); }
    const identities = await tx.query<{ id: number; uid: string; key: Record<string, unknown>; from_node?: number; to_node?: number; discriminator?: string; read_at: string | Date }>((sort === 'vertex'
      ? 'SELECT n.id,n.uid::text,n.key,transaction_timestamp() AS read_at FROM node n JOIN entity k ON k.id=n.entity_id WHERE '
      : `SELECT n.id,n.uid::text,'{}'::jsonb AS key,n.from_node,n.to_node,n.discriminator,transaction_timestamp() AS read_at FROM graph_effective_edges(${Number(selector.contexts?.[0] ?? 1)},${selector.validAt === undefined ? 'transaction_timestamp()' : "'" + new Date(selector.validAt).toISOString() + "'::timestamptz"},${selector.recordedAt === undefined ? 'transaction_timestamp()' : "'" + new Date(selector.recordedAt).toISOString() + "'::timestamptz"}) n JOIN entity k ON k.id=n.entity_id WHERE `) + predicates.join(' AND '), parameters);
    // Empty identity sets still resolve disputes, so malformed schemas are refused.
    const readAt = identities.rows[0]?.read_at ?? (await tx.query<{ now: string | Date }>('SELECT transaction_timestamp() AS now')).rows[0]!.now;
    const now = new Date(readAt).toISOString();
    const temporal = { validAt: selector.validAt ?? now, recordedAt: selector.recordedAt ?? now, contexts: selector.contexts ?? [1], ...(selector.contextRecordedThrough === undefined ? {} : { contextRecordedThrough: selector.contextRecordedThrough }) };
    const mapped=sort==='vertex'&&!kind.startsWith('system.')&&!kind.startsWith('manifest.')&&(await tx.query<{present:boolean}>(`SELECT EXISTS(SELECT 1 FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='system.merge') AS present`)).rows[0]!.present;
    const assertions = await loadAssertions(tx, sort, kind, [...new Set(['$exists', ...fields])], identities.rows.map(row => Number(row.id)),mapped?{context:temporal.contexts[0]!,validAt:temporal.validAt,recordedAt:temporal.recordedAt}:undefined);
    const canonicalIds=mapped?new Set((await tx.query<{id:number}>(`SELECT id FROM node WHERE id=ANY($1::bigint[]) AND graph_merge_target(id,$2::bigint,$3::timestamptz,$4::timestamptz)=id`,[identities.rows.map(row=>row.id),temporal.contexts[0],temporal.validAt,temporal.recordedAt])).rows.map(row=>Number(row.id))):null;
    const keyFields=selector.contract?.vertex.find(vertex=>vertex.name===kind)?.key??[];
    const visibleAssertions=assertions.filter(row=>sort!=='vertex'||!keyFields.includes(row.property)||row.originalSubjectId===row.subjectId);
    const slots = new Map(selectAssertionSlots(visibleAssertions, temporal));
    const resolvedIds = new Set<string>();
    if (disputable) {
      const disputes = await listDisputeSlots(tx, withAssertionContract(selector.contract!), temporal);
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
    return identities.rows.flatMap(row => {
      if(canonicalIds!==null&&!canonicalIds.has(Number(row.id)))return [];
      const own = bySubject.get(Number(row.id)) ?? [];
      const ownSlots = subjectSlots.get(Number(row.id)) ?? [];
      const values = Object.fromEntries(own.filter(a => selected.has(a.id)).map(a => [a.property,a.value]));
      const existence = ownSlots.filter(slot => slot.candidates.some(candidate => candidate.property === '$exists'));
      const decided = existence.flatMap(slot => slot.candidates.filter(candidate => resolvedIds.has(candidate.id)));
      const exists = decided.length > 0 ? decided.some(candidate => candidate.value === true) : existence.some(slot => slot.candidates.some(candidate => candidate.value === true));
      if (!exists) return [];
      values['$exists'] = true;
      const activeSources = [...new Set(existence.flatMap(slot => slot.candidates.filter(a => a.value === true).map(a => a.source)))];
      return [{id:Number(row.id),uid:row.uid,key:row.key,values,assertions:own,selectedAssertions:own.filter(a => selected.has(a.id)),activeSources,...(row.from_node === undefined ? {} : {from:Number(row.from_node),to:Number(row.to_node),discriminator:row.discriminator})}];
    });
  });
}
/** Convenience views load their slot list from the installed graph contract. */
async function declaredRecords(tx: SqlExecutor, sort: 'vertex' | 'edge', kind: string, fields: readonly string[]): Promise<AssertionRecord[]> {
  const { readPublishedManifest } = await import('./manifest-publication.js');
  const { graphContractOf } = await import('../fill/stages/plugin-contract.js');
  const manifest = await readPublishedManifest(tx);
  if (manifest === undefined) throw new Error(`${import.meta.path}:44: repository reads require the published graph contract`);
  const contract = graphContractOf(manifest);
  const declaration = contract[sort].find(candidate => candidate.name === kind);
  if (declaration === undefined) return [];
  return await readKindAssertions(tx, sort, kind, fields.filter(field => declaration.fields.some(candidate => candidate.name === field)), { contract });
}

type SemanticRecord = Omit<AssertionRecord, 'key'>;

async function semanticRecords(tx: SqlExecutor, role: string, fields: readonly string[], edgeRole?: string): Promise<SemanticRecord[]> {
  const { readPublishedManifest } = await import('./manifest-publication.js');
  const { graphContractOf } = await import('../fill/stages/plugin-contract.js');
  const manifest = await readPublishedManifest(tx);
  if (manifest === undefined) throw new Error(`${import.meta.path}:57: semantic graph reads require the published manifest`);
  const binding = manifest.semanticBindings?.get(role);
  if (binding === undefined) throw new Error(`${manifest.file}:1: semantic-bindings.${role} is required by this read`);
  const edge = edgeRole === undefined ? undefined : binding.edges?.[edgeRole];
  if (edgeRole !== undefined && edge === undefined) throw new Error(`${manifest.file}:${binding.line}: semantic-bindings.${role}.edges.${edgeRole} is required by this read`);
  const kind = edge?.kind ?? binding.kind;
  const sort = edgeRole === undefined ? 'vertex' : 'edge';
  const mappings: Readonly<Record<string,string>> = edge === undefined ? binding.fields : edge.fields ?? {};
  const contract = graphContractOf(manifest);
  const declaration = contract[sort].find(candidate => candidate.name === kind);
  if (declaration === undefined) throw new Error(`${manifest.file}:${binding.line}: semantic role ${role} names undeclared ${sort} ${kind}`);
  for (const field of fields) if (mappings[field] === undefined) throw new Error(`${manifest.file}:${binding.line}: semantic role ${role}${edgeRole === undefined ? '' : '.' + edgeRole} requires field binding ${field}`);
  const actualFields = [...new Set(fields.map(field => mappings[field]!))];
  for (const field of actualFields) if (!declaration.fields.some(candidate => candidate.name === field)) throw new Error(`${manifest.file}:${binding.line}: semantic role ${role} names undeclared field ${kind}.${field}`);
  const rows = await readKindAssertions(tx, sort, kind, actualFields, { contract });
  return rows.map(row => {
    const values: Record<string,unknown> = {};
    for (const [semantic, actual] of Object.entries(mappings)) {
      let value = row.values[actual];
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
  });
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
async function repository(tx:SqlExecutor,name:string) { return (await semanticRecords(tx,'repository',repoFields)).find(r=>r.values['name']===name); }
async function files(tx:SqlExecutor,name:string) { const repo=await repository(tx,name); if(repo===undefined)return []; const contains=await semanticRecords(tx,'repository',[],'contains'); const ids=new Set(contains.filter(e=>e.from===repo.id).map(e=>e.to)); return (await semanticRecords(tx,'file',fileFields)).filter(f=>ids.has(f.id)).sort((a,b)=>String(a.values['path'])<String(b.values['path'])?-1:1); }
export async function listFiles(owner:DatabaseOwner,input:{readonly repository:string;readonly prefix?:string;readonly language?:string;readonly after?:string;readonly limit:number;readonly projection?:'map'}):Promise<{readonly rows:readonly FileRecord[];readonly next:string|null}> {
 return await withSpan('records.listFiles',{},async()=>await owner.transaction('snapshot',async tx=>{const all=(await files(tx,input.repository)).map(file).filter(f=>(input.prefix===undefined||f.path.startsWith(input.prefix))&&(input.language===undefined||f.language===input.language)&&(input.after===undefined||f.path>input.after));const rows=all.slice(0,input.limit);return {rows,next:all.length>input.limit?rows.at(-1)!.path:null};}));
}
export async function productFileIndex(owner:DatabaseOwner,repository:string) { return (await listFiles(owner,{repository,limit:Number.MAX_SAFE_INTEGER})).rows; }
export async function listRepositories(owner:DatabaseOwner,_declared?:ReadonlySet<string>):Promise<readonly {name:string;url:string;defaultBranch:string|null;asIsCommit:string|null}[]> { return await withSpan('records.repositories',{},async()=>await owner.transaction('snapshot',async tx=>{ const repos=await semanticRecords(tx,'repository',repoFields);const edges=await semanticRecords(tx,'repository',[],'asIs');const commits=await semanticRecords(tx,'commit',['hash']);return repos.map(r=>({name:String(r.values['name']),url:text(r.values['url'])??'',defaultBranch:text(r.values['default_branch']),asIsCommit:text(scalar(commits.find(c=>c.id===edges.find(e=>e.from===r.id)?.to),'hash'))})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);})); }
export async function repositoryFacts(owner:DatabaseOwner,name:string,_declared?:ReadonlySet<string>):Promise<RepositoryFacts|null> { return await withSpan('records.repositoryFacts',{},async()=>await owner.transaction('snapshot',async tx=>{ const r=await repository(tx,name);if(r===undefined)return null;const contains=await semanticRecords(tx,'repository',[],'contains');const ids=new Set(contains.filter(e=>e.from===r.id).map(e=>e.to));const fs=await semanticRecords(tx,'file',[]);const dirs=await semanticRecords(tx,'directory',[]);const history=await semanticRecords(tx,'repository',[],'history');const asIs=(await semanticRecords(tx,'repository',[],'asIs')).find(e=>e.from===r.id);const commits=await semanticRecords(tx,'commit',['hash']);return {nodeId:String(r.id),name,url:text(r.values['url'])??'',defaultBranch:text(r.values['default_branch']),asIsCommit:text(scalar(commits.find(c=>c.id===asIs?.to),'hash')),hasTree:typeof r.values['tree_snapshot'] === 'string' && r.values['tree_snapshot'].length > 0,fileCount:fs.filter(f=>ids.has(f.id)).length,directoryCount:dirs.filter(d=>ids.has(d.id)).length,commitCount:history.filter(e=>e.from===r.id).length,historyShallow:typeof r.values['history_shallow']==='boolean'?r.values['history_shallow']:null};})); }
function gitClock(value:unknown,offset:number):string { if(value==null)return '';const local=new Date(new Date(String(value)).getTime()+offset*60000).toISOString().slice(0,19);return `${local}${offset<0?'-':'+'}${String(Math.floor(Math.abs(offset)/60)).padStart(2,'0')}:${String(Math.abs(offset)%60).padStart(2,'0')}`; }
async function commit(tx:SqlExecutor,hash:string):Promise<CommitRecord|null> {const c=(await semanticRecords(tx,'commit',commitFields)).find(c=>c.values['hash']===hash);if(c===undefined)return null;const parentEdges=(await semanticRecords(tx,'commit',semanticRoleFields('commit.parent'),'parent')).filter(e=>e.from===c.id).sort((a,b)=>Number(a.values['position'])-Number(b.values['position']));const commits=await semanticRecords(tx,'commit',['hash']);const authored=(await semanticRecords(tx,'author',[],'authored')).find(e=>e.to===c.id);const author=(await semanticRecords(tx,'author',semanticRoleFields('author'))).find(a=>a.id===authored?.from);const ao=Number(c.values['author_offset_min']??0),co=Number(c.values['commit_offset_min']??0);return {hash,parents:parentEdges.map(e=>String(scalar(commits.find(c=>c.id===e.to),'hash'))),author:{name:String(scalar(author,'name')??''),email:String(scalar(author,'email')??'')},subject:String(c.values['subject']??''),authorDate:gitClock(c.values['author_date'],ao),authorOffsetMin:ao,commitDate:gitClock(c.values['commit_date'],co),commitOffsetMin:co}; }
export async function commitFacts(owner:DatabaseOwner,_repository:string,hash:string):Promise<CommitRecord|null> {return await withSpan('records.commitFacts',{},async()=>await owner.transaction('snapshot',tx=>commit(tx,hash)));}
export async function fileFacts(owner:DatabaseOwner,repositoryName:string,path:string,options:{readonly history?:boolean}={}):Promise<(FileRecord&{readonly created:FileDate|null;readonly modified:FileDate|null;readonly commitCount:number;readonly authors:readonly string[]})|null>{return await withSpan('records.fileFacts',{},async()=>await owner.transaction('snapshot',async tx=>{const f=(await files(tx,repositoryName)).find(f=>f.values['path']===path);if(f===undefined)return null;const history: {walk:number;fact:FileDate}[]=[];if(options.history!==false){const repo=await repository(tx,repositoryName);const renamed=await semanticRecords(tx,'file',[],'renamedFrom');const ids=new Set([f.id]);let changed=true;while(changed){changed=false;for(const e of renamed)if(ids.has(e.from!)&&!ids.has(e.to!)){ids.add(e.to!);changed=true;}}const touched=await semanticRecords(tx,'commit',[],'touched');const walks=await semanticRecords(tx,'repository',semanticRoleFields('repository.history'),'history');const commits=await semanticRecords(tx,'commit',['hash']);for(const e of touched.filter(e=>ids.has(e.to!))){const walk=walks.find(w=>w.from===repo?.id&&w.to===e.from);if(walk===undefined)continue;const c=commits.find(c=>c.id===e.from);if(c===undefined)continue;const facts=await commit(tx,String(c.values['hash']));if(facts!==null)history.push({walk:Number(walk.values['walk']),fact:{date:facts.commitDate,offsetMin:facts.commitOffsetMin,commit:facts.hash,author:facts.author.name}});}}history.sort((a,b)=>a.walk-b.walk);return {...file(f),created:history.at(-1)?.fact??null,modified:history[0]?.fact??null,commitCount:new Set(history.map(h=>h.fact.commit)).size,authors:[...new Set(history.map(h=>h.fact.author))].sort()};}));}
export async function graphKindCounts(owner:DatabaseOwner):Promise<readonly {kind:string;count:number}[]> {return await withSpan('records.kindCounts',{},async()=>await owner.transaction('snapshot',async tx=>{const kinds=await tx.query<{name:string}>(`SELECT name FROM entity WHERE sort='node' ORDER BY name COLLATE "C"`);const rows=[];for(const k of kinds.rows)rows.push({kind:k.name,count:(await declaredRecords(tx,'vertex',k.name,[])).length});return rows;}));}

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
        const slots = selectAssertionSlots(record.assertions, selector);
        const ids = new Set([...slots.values()].flatMap(slot => slot.candidates).filter(assertion => active.has(assertion.source)).map(assertion => assertion.id));
        const assertions = record.assertions.filter(assertion => ids.has(assertion.id) && assertion.evidence.length > 0);
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
