/** The sole graph writer: immutable, typed assertions (0039 items 14,25,26,28). */
import {createHash} from 'node:crypto';
import {CommittedLookups,TransactionLookups} from './immutable-lookups.js';
import type { SqlExecutor } from '../sql-driver.js';
import { withSpan } from '../obs/trace.js';
import { endpointKindNames, assertionValueTableName, graphContractVersion, type GraphContract, type EntityRefDraft, type VertexDraft, type VertexRemovalDraft, type EdgeDraft, type EdgeRemovalDraft, type EvidenceDraft, type FieldContract } from './contract.js';
import { withAssertionContract } from './system-contract.js';
import { keyUid, newUid } from './uid.js';
import {validateEvidenceLocator} from './evidence-locator.js';
import { validateFieldValue,validateValueContracts } from './value-validation.js';
import { scanMentions } from './mentions.js';
import { canonicalAssertionValue } from './assertion-selection.js';
export type {EdgeDraft,EdgeRemovalDraft} from './contract.js';

const WHERE=import.meta.path;

interface ImmutableVertex extends Record<string,unknown> {
 id:string;uid:string;kind:string;key:Record<string,unknown>;scope:string;
 parents:{kind:string;uid:string;edge:string;direction:string}[];
}
interface ImmutableLookups {
 kinds:TransactionLookups<string>;
 vertices:TransactionLookups<ImmutableVertex>;
 values:TransactionLookups<unknown>;
}
// Retain at most eight installations. Content is bounded by both bytes and slots.
const databaseLookups=new Map<string,{kinds:CommittedLookups<string>;vertices:CommittedLookups<ImmutableVertex>;values:CommittedLookups<unknown>}>();
const transactionLookups=new WeakMap<SqlExecutor,Promise<ImmutableLookups>>();
async function immutableLookups(executor:SqlExecutor):Promise<ImmutableLookups>{
 let pending=transactionLookups.get(executor);
 if(pending===undefined){
  pending=withSpan('graph.immutable-lookups',{},async()=>{
   await acquireGraphWriteLock(executor);
   const {identity}=(await executor.query<{identity:string}>(`SELECT jsonb_build_array(
    (SELECT system_identifier::text FROM pg_control_system()),
    (SELECT oid::text FROM pg_database WHERE datname=current_database()),
    'entity'::regclass::oid::text,
    (SELECT jsonb_agg(jsonb_build_array(name,stamp,created_at::text,xmin::text) ORDER BY name COLLATE "C") FROM madarch_meta.schema_stamp WHERE name IN ('one-graph','one-graph-revision','graph-reset'))
   )::text AS identity`)).rows[0]!;
   const shared=databaseLookups.get(identity)??{
    kinds:new CommittedLookups<string>(4096,1024*1024),
    vertices:new CommittedLookups<ImmutableVertex>(100000,32*1024*1024),
    values:new CommittedLookups<unknown>(4096,8*1024*1024)
   };
   databaseLookups.delete(identity);databaseLookups.set(identity,shared);
   if(databaseLookups.size>8)databaseLookups.delete(databaseLookups.keys().next().value!);
   const local={kinds:new TransactionLookups(shared.kinds),vertices:new TransactionLookups(shared.vertices),values:new TransactionLookups(shared.values)};
   executor.afterCommit?.(()=>{local.kinds.publish();local.vertices.publish();local.values.publish();});
   return local;
  });
  transactionLookups.set(executor,pending);
 }
 return pending;
}
async function immutableCatalogue(executor:SqlExecutor,contract:GraphContract):Promise<{entities:Map<string,string>;instant:number}>{
 const cache=await immutableLookups(executor);
 const complete=[...contract.vertex.map(kind=>'node:'+kind.name),...contract.edge.map(kind=>'edge:'+kind.name)].every(name=>cache.kinds.has(name));
 const rows=(await executor.query<{id:string;name:string;sort:string;instant:string}>(complete?'SELECT transaction_timestamp()::text AS instant':'SELECT id::text,name,sort,transaction_timestamp()::text AS instant FROM entity')).rows;
 for(const row of rows)if(row.id!==undefined)cache.kinds.set(row.sort+':'+row.name,row.id);
 const entities=new Map<string,string>();
 for(const name of [...contract.vertex.map(kind=>'node:'+kind.name),...contract.edge.map(kind=>'edge:'+kind.name)]){const id=cache.kinds.get(name);if(id!==undefined)entities.set(name,id);}
 return {entities,instant:Date.parse(rows[0]!.instant)};
}

/** Serialize graph operations before any identity or queue locks. */
export async function acquireGraphWriteLock(executor:SqlExecutor):Promise<void>{await executor.query('SELECT pg_advisory_xact_lock($1::bigint)',[739251902]);}
export interface WriteCapability {
  readonly sourceUid:string; readonly principalUid:string; readonly operationUid:string;
  readonly unitUid?:string; readonly productUid:string; readonly context:number; readonly contractVersion:string; readonly scope:string;
  readonly permissions:readonly {readonly kind:string;readonly properties:readonly string[];readonly assert:boolean;readonly retractOwn:boolean}[];
}
const bindings=new WeakMap<object,WriteCapability>();
/** Only the authenticated host binds this capability after operation fencing. */
export function bindWriteCapability(executor:SqlExecutor,binding:WriteCapability):void {
 if(!Number.isSafeInteger(binding.context)||binding.context<1||!binding.scope||!binding.contractVersion)throw new Error(`${WHERE}:22: SOURCE_FORBIDDEN incomplete authenticated capability`);
 bindings.set(executor,Object.freeze({...binding,permissions:binding.permissions.map(permission=>Object.freeze({...permission,properties:Object.freeze([...permission.properties])}))}));
}
export function requireWriteCapability(executor:SqlExecutor):WriteCapability {
  const binding=bindings.get(executor);if(binding===undefined) throw new Error(`${WHERE}:24: AUTH_REQUIRED: host-authenticated source capability required`);return binding;
}
function checkBinding(binding:WriteCapability,contract:GraphContract,context:number):string{
 validateValueContracts(contract);
 const version=graphContractVersion(contract);checkBindingRevision(binding,version,context);return version;
}
function checkBindingRevision(binding:WriteCapability,version:string,context:number):void{
 if(binding.context!==context)throw new Error(`${WHERE}:30: SOURCE_FORBIDDEN context differs from capability`);
 if(binding.contractVersion!==version)throw new Error(`${WHERE}:31: CONTRACT_CONFLICT authenticated contract revision is stale`);
}
interface PreparedContract {readonly contract:GraphContract;readonly version:string}
function preparePublicationContract(declared:GraphContract):PreparedContract {
 const contract=structuredClone(withAssertionContract(declared));
 const freeze=(value:unknown):void=>{if(value!==null&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}};
 freeze(contract);
 validateValueContracts(contract);
 return {contract,version:graphContractVersion(contract)};
}
export function canonicalJson(value:unknown):string{return canonicalAssertionValue(value);}
export function sameValue(a:unknown,b:unknown):boolean{return canonicalJson(a)===canonicalJson(b);}
function permitted(binding:WriteCapability,kind:string,property:string,retract=false):void {
  if(!binding.permissions.some(p=>p.kind===kind&&(p.properties.includes(property)||p.properties.includes('*'))&&(retract?p.retractOwn:p.assert)))
    throw new Error(`${WHERE}:30: FORBIDDEN_SOURCE: ${kind}.${property}; create an evidenced question instead of changing another source`);
}
async function entityId(executor:SqlExecutor,kind:string,sort:'node'|'edge'):Promise<string>{
 const cache=await immutableLookups(executor),key=sort+':'+kind;
 const known=cache.kinds.get(key);if(known!==undefined)return known;
 const row=(await executor.query<{id:string}>(`SELECT id::text AS id FROM entity WHERE name=$1 AND sort=$2`,[kind,sort])).rows[0];
 if(!row)throw new Error(`${WHERE}:35: UNKNOWN_KIND ${kind}`);cache.kinds.set(key,row.id);return row.id;
}
async function identity(executor:SqlExecutor,kind:string,uid:string,key:Readonly<Record<string,unknown>>,scope:string,context:number):Promise<{nodeId:string;uid:string;created:boolean;revived:boolean}>{
 const cache=await immutableLookups(executor),known=cache.vertices.get(uid);
 if(known!==undefined){
  if(known.kind!==kind||!sameValue(known.key,key)||known.scope!==scope)throw new Error(`${WHERE}:42: UID_IDENTITY_CONFLICT ${uid}`);
  const rows=(await executor.query<{id:string;uid:string}>('SELECT id::text,uid::text FROM node WHERE id=$1::bigint FOR UPDATE',[known.id])).rows;
  if(rows.length!==1||rows[0]!.id!==known.id||rows[0]!.uid!==uid)throw new Error(`${WHERE}:111: UID_IDENTITY_CONFLICT cached identity ${uid}`);
  return {nodeId:known.id,uid,created:false,revived:false};
 }
 const kindId=await entityId(executor,kind,'node');
 const made=await executor.query<{id:string;kind:string;key:unknown;scope:string}>(`INSERT INTO node(entity_id,uid,key,identity_scope,context_id) VALUES($1::bigint,$2::uuid,$3::jsonb,$4::uuid,$5) ON CONFLICT DO NOTHING RETURNING id::text AS id,$6::text AS kind,key,identity_scope::text AS scope`,[kindId,uid,JSON.stringify(key),scope,context,kind]);
 const row=made.rows[0]??(await executor.query<{id:string;kind:string;key:unknown;scope:string}>(`SELECT n.id::text AS id,k.name AS kind,n.key,n.identity_scope::text AS scope FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.uid=$1::uuid FOR UPDATE OF n`,[uid])).rows[0];
 if(!row||row.kind!==kind||!sameValue(row.key,key)||row.scope!==scope)throw new Error(`${WHERE}:42: UID_IDENTITY_CONFLICT ${uid}`);
 await executor.query('SELECT id FROM node WHERE id=$1::bigint FOR UPDATE',[row.id]);
 if(!cache.vertices.has(uid))cache.vertices.set(uid,{...row,uid,key:row.key as Record<string,unknown>,parents:[]});
 return {nodeId:row.id,uid,created:made.rows.length>0,revived:false};
}
/** Installation declares principal/source/operation identities through this same writer. */
export async function bootstrapWriteIdentity(executor:SqlExecutor,kind:string,uid:string,productUid:string,context=1):Promise<void>{
 await withSpan('graph.identity.bootstrap',{'graph.kind':kind},async()=>{await identity(executor,kind,uid,{},productUid,context);});
}
function validate(field:FieldContract,value:unknown):unknown {
 const valid=value===null ? field.nullable===true : field.type==='text'?typeof value==='string':field.type==='boolean'?typeof value==='boolean':field.type==='integer'?typeof value==='number'&&Number.isInteger(value)&&value>=-2147483648&&value<=2147483647:field.type==='bigint'?(typeof value==='number'&&Number.isSafeInteger(value))||(typeof value==='string'&&(()=>{try{return String(BigInt(value))===value;}catch{return false;}})()):field.type==='timestamp'?typeof value==='string'&&Number.isFinite(Date.parse(value)):field.type==='json'?value!==undefined:false;
 if(!valid)throw new Error(`${WHERE}:52: TYPE_MISMATCH field ${field.name}, expected ${field.type}, value ${JSON.stringify(value)}`);
 if(field.type==='json') canonicalJson(value);
 return value;
}
async function refUid(executor:SqlExecutor,contract:GraphContract,ref:EntityRefDraft,context:number,stack:readonly string[]=[]):Promise<string>{
 const kind=contract.vertex.find(k=>k.name===ref.kind);if(!kind)throw new Error(`${WHERE}:58: UNKNOWN_KIND ${ref.kind}`);
 if(stack.includes(kind.name))throw new Error(`${WHERE}:59: KEY_EDGE_CYCLE ${kind.name}`);
 const binding=requireWriteCapability(executor);const pairs:string[]=[];
 for(const name of Object.keys(ref.key))if(!kind.key.includes(name))throw new Error(`${WHERE}:62: UNKNOWN_KEY ${kind.name}.${name}`);
 for(const role of Object.keys(ref.keyEdges??{}))if(!kind.keyEdges?.some(edge=>edge.role===role))throw new Error(`${WHERE}:62: UNKNOWN_KEY_EDGE_ROLE ${kind.name}.${role}`);
 for(const role of kind.keyEdges??[]){const parent=ref.keyEdges?.[role.role];if(!parent)throw new Error(`${WHERE}:61: REQUIRED_PARENT ${kind.name}.${role.role}`);pairs.push(role.role,await refUid(executor,contract,parent,context,[...stack,kind.name]));}
 const values=kind.key.map(name=>{const field=kind.fields.find(f=>f.name===name);if(!field)throw new Error(`${WHERE}:63: INVALID_KEY ${kind.name}.${name}`);validateFieldValue(contract,field,ref.key[name]);validate(field,ref.key[name]);validateFieldValue(contract,field,ref.key[name]);return canonicalJson(ref.key[name]);});
 const scope=kind.identity?.namespace??(pairs.length===2?pairs[1]!:pairs.length?keyUid('madarch.parent-scope',pairs):binding.productUid);
 if(kind.identity&&(pairs.length>0||!sameValue(kind.identity.origin,kind.key)))throw new Error(`${WHERE}:67: INVALID_IDENTITY_SCOPE: shared origin must be exactly the declared root key`);
 const expected=kind.key.length||pairs.length?keyUid(kind.contractUid??keyUid('madarch.catalogue.kind',[kind.name]),[scope,...pairs,...values]):ref.uid??newUid();
 if(binding.scope!==binding.productUid&&binding.scope!==expected&&!pairs.includes(binding.scope))throw new Error(`${WHERE}:80: SOURCE_FORBIDDEN identity outside authenticated scope`);
 if(ref.uid!==undefined&&ref.uid!==expected)throw new Error(`${WHERE}:66: UID_IDENTITY_CONFLICT ${ref.uid}`);
 return expected;
}
async function storedReference(executor:SqlExecutor,contract:GraphContract,ref:EntityRefDraft,visited:readonly string[]=[]):Promise<EntityRefDraft>{
 if(ref.uid===undefined||Object.keys(ref.key).length>0||ref.keyEdges!==undefined)return ref;
 const kind=contract.vertex.find(vertex=>vertex.name===ref.kind);if(!kind)throw new Error(`${WHERE}:74: UNKNOWN_KIND ${ref.kind}`);
 if(visited.includes(ref.uid))throw new Error(`${WHERE}:74: KEY_EDGE_CYCLE ${ref.kind}`);
 const held=(await executor.query<{id:string;kind:string;key:EntityRefDraft['key']}>(`SELECT n.id::text,k.name AS kind,n.key FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.uid=$1::uuid`,[ref.uid])).rows[0];
 if(!held||held.kind!==ref.kind)throw new Error(`${WHERE}:74: MISSING_ENDPOINT ${ref.kind} ${ref.uid}`);
 const keyEdges:Record<string,EntityRefDraft>={};
 for(const role of kind.keyEdges??[]){
  const from=role.direction==='from'?'from_node':'to_node';const to=role.direction==='from'?'to_node':'from_node';
  const parents=(await executor.query<{uid:string;kind:string}>(`SELECT parent.uid::text,pk.name AS kind FROM edge e JOIN entity ek ON ek.id=e.entity_id JOIN node parent ON parent.id=e.${to} JOIN entity pk ON pk.id=parent.entity_id WHERE e.${from}=$1::bigint AND ek.name=$2`,[held.id,role.edge])).rows;
  if(parents.length!==1)throw new Error(`${WHERE}:74: REQUIRED_PARENT ${ref.kind}.${role.role}`);
  keyEdges[role.role]=await storedReference(executor,contract,{kind:parents[0]!.kind,key:{},uid:parents[0]!.uid},[...visited,ref.uid]);
 }
 return {...ref,key:held.key,...(Object.keys(keyEdges).length?{keyEdges}:{} )};
}
async function endpoint(executor:SqlExecutor,contract:GraphContract,ref:EntityRefDraft,context:number):Promise<{id:string;uid:string}>{
 const resolved=await storedReference(executor,contract,ref);
 const uid=await refUid(executor,contract,resolved,context);
 const row=(await executor.query<{id:string;kind:string;context:string}>(`SELECT n.id::text AS id,k.name AS kind,n.context_id::text AS context FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.uid=$1::uuid FOR UPDATE OF n`,[uid])).rows[0];
 if(!row||row.kind!==ref.kind)throw new Error(`${WHERE}:73: MISSING_ENDPOINT ${ref.kind} ${uid}`);
 if(!(await executor.query<{active:boolean}>(`SELECT graph_vertex_active($1::bigint,$2,$3::bigint) AS active`,[row.id,ref.kind,context])).rows[0]?.active)throw new Error(`${WHERE}:73: MISSING_ENDPOINT ${ref.kind} ${uid}`);
 return {id:row.id,uid};
}
/** Resolves a declared identity without creating it. */
export async function resolveEntityRef(executor:SqlExecutor,contract:GraphContract,ref:EntityRefDraft,context=1):Promise<{id:string;uid:string}>{
 return await withSpan('graph.identity.resolve',{'graph.kind':ref.kind},()=>endpoint(executor,withAssertionContract(contract),ref,context));
}
export async function ensureVertex(executor:SqlExecutor,declared:GraphContract,draft:Pick<VertexDraft,'kind'|'key'|'keyEdges'|'uid'>,context=1):Promise<{nodeId:string;uid:string;created:boolean;revived:boolean}>{
 const contract=withAssertionContract(declared);const version=checkBinding(requireWriteCapability(executor),contract,context);
 return await ensureCheckedVertex(executor,{contract,version},draft,context);
}
async function ensureCheckedVertex(executor:SqlExecutor,prepared:PreparedContract,draft:Pick<VertexDraft,'kind'|'key'|'keyEdges'|'uid'>,context:number):Promise<{nodeId:string;uid:string;created:boolean;revived:boolean}>{
 return await withSpan('graph.vertex.ensure',{'graph.kind':draft.kind},async()=>{
 const {contract,version}=prepared;const binding=requireWriteCapability(executor);checkBindingRevision(binding,version,context);const kind=contract.vertex.find(k=>k.name===draft.kind);if(!kind)throw new Error(`${WHERE}:79: UNKNOWN_KIND ${draft.kind}`);
 permitted(binding,kind.name,'$exists');
 const uid=await refUid(executor,contract,draft,context);const key:Record<string,unknown>={};
 for(const name of kind.key){const field=kind.fields.find(f=>f.name===name)!;key[name]=validate(field,draft.key[name]);validateFieldValue(contract,field,key[name]);}
 const keyEdges=await Promise.all((kind.keyEdges??[]).map(async role=>({role,parent:await endpoint(executor,contract,draft.keyEdges![role.role]!,context)})));
 const made=await identity(executor,kind.name,uid,key,kind.identity?.namespace??(keyEdges.length===1?keyEdges[0]!.parent.uid:keyEdges.length?keyUid('madarch.parent-scope',keyEdges.flatMap(edge=>[edge.role.role,edge.parent.uid])):binding.productUid),context);
 for(const {role,parent} of keyEdges){const edge=contract.edge.find(e=>e.name===role.edge);if(!edge)throw new Error(`${WHERE}:85: UNKNOWN_KEY_EDGE ${role.edge}`);const from=role.direction==='from'?made.nodeId:parent.id;const to=role.direction==='from'?parent.id:made.nodeId;await putEdge(executor,edge.name,from,to,'',context);}
 const cache=await immutableLookups(executor),node=cache.vertices.get(uid)!;
 cache.vertices.set(uid,{...node,parents:keyEdges.map(({role,parent})=>({kind:draft.keyEdges![role.role]!.kind,uid:parent.uid,edge:role.edge,direction:role.direction}))});
 return made;
 });
}
/** A trusted host births its lineage trio only after all three identities can be named. */
export async function activateBoundIdentities(executor:SqlExecutor,declared:GraphContract):Promise<void>{
 const binding=requireWriteCapability(executor);const contract=withAssertionContract(declared);checkBinding(binding,contract,binding.context);
 for(const uid of [binding.sourceUid,binding.principalUid,binding.operationUid]){
  const held=(await executor.query<{id:string;kind:string;active:boolean}>(`SELECT n.id::text,k.name AS kind,graph_vertex_active(n.id,k.name,$2::bigint) AS active FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.uid=$1::uuid`,[uid,binding.context])).rows[0];
  if(!held)throw new Error(`${WHERE}:57: TARGET_MISSING authenticated lineage ${uid}`);
  if(!held.active)await writeAssertion(executor,contract,{sort:'vertex',kind:held.kind,subjectId:held.id,property:'$exists',operation:'assert',value:true},binding.context);
 }
}
function edgeUid(kind:string,fromUid:string,toUid:string,discriminator:string):string{return keyUid(keyUid('madarch.catalogue.kind',[kind]),[fromUid,toUid,discriminator]);}
async function putEdge(executor:SqlExecutor,kind:string,from:string,to:string,discriminator:string,context:number):Promise<string>{
 const kindId=await entityId(executor,kind,'edge');
 const nodes=new Map<string,string>();
 const missing=[...new Set([from,to])].filter(id=>!nodes.has(id));
 if(missing.length)for(const row of (await executor.query<{id:string;uid:string}>(`SELECT id::text AS id,uid::text AS uid FROM node WHERE id=ANY($1::bigint[]) ORDER BY uid`,[missing])).rows)nodes.set(row.id,row.uid);
 const uid=edgeUid(kind,nodes.get(from)!,nodes.get(to)!,discriminator);
 const made=await executor.query<{id:string}>(`INSERT INTO edge(uid,entity_id,from_node,to_node,discriminator,context_id) VALUES($1::uuid,$2::bigint,$3::bigint,$4::bigint,$5,$6) ON CONFLICT DO NOTHING RETURNING id::text AS id`,[uid,kindId,from,to,discriminator,context]);
 return made.rows[0]?.id??(await executor.query<{id:string}>(`SELECT id::text AS id FROM edge WHERE uid=$1::uuid`,[uid])).rows[0]!.id;
}
export interface AssertionInput {
 readonly sort:'vertex'|'edge'; readonly kind:string; readonly subjectId:string; readonly property:string;
 readonly operation:'assert'|'retract'; readonly value?:unknown; readonly language?:string|null;
 readonly validFrom?:string; readonly validTo?:string|null; readonly evidence?:readonly EvidenceDraft[];
}
/** One assertion and all lineage enter in the caller's atomic operation. */
/** Check the authenticated subject scope before internal metadata writes can broaden their storage scope. */
export async function requireAssertionScope(executor:SqlExecutor,contract:GraphContract,binding:WriteCapability,subject:{readonly sort:'vertex'|'edge';readonly subjectId:string},context:number):Promise<void>{
 return await withSpan('graph.assertion.scope',{},async()=>{
 if(binding.context!==undefined&&binding.context!==context)throw new Error(`${WHERE}:114: SOURCE_FORBIDDEN capability context`);
 if(binding.scope!==binding.productUid){
  const scopeNode=(await executor.query<{id:string}>(`SELECT id::text AS id FROM node WHERE uid=$1::uuid`,[binding.scope])).rows[0];
  const subjectNodes=subject.sort==='vertex'?[subject.subjectId]:(await executor.query<{from_node:string;to_node:string}>(`SELECT from_node::text,to_node::text FROM edge WHERE id=$1::bigint`,[subject.subjectId])).rows.flatMap(row=>[row.from_node,row.to_node]);
  const keyNames=contract.vertex.flatMap(vertex=>(vertex.keyEdges??[]).map(role=>({name:role.edge,direction:role.direction})));
  const scoped=scopeNode===undefined?false:(await executor.query<{allowed:boolean}>(`WITH RECURSIVE members(id) AS (SELECT $1::bigint UNION SELECT CASE WHEN role.direction='from' THEN e.from_node ELSE e.to_node END FROM members m JOIN edge e ON true JOIN entity k ON k.id=e.entity_id JOIN jsonb_to_recordset($2::jsonb) role(name text,direction text) ON role.name=k.name WHERE CASE WHEN role.direction='from' THEN e.to_node ELSE e.from_node END=m.id AND graph_edge_active(e.id,k.name,$4::bigint)) SELECT bool_and(id IN(SELECT id FROM members)) AS allowed FROM unnest($3::bigint[]) subject(id)`,[scopeNode.id,JSON.stringify(keyNames),subjectNodes,context])).rows[0]?.allowed===true;
  if(!scoped)throw new Error(`${WHERE}:128: SOURCE_FORBIDDEN assertion outside authenticated scope`);
 }
 });
}
export async function writeAssertion(executor:SqlExecutor,declared:GraphContract,input:AssertionInput,context=1):Promise<string>{
 return (await admitAssertionInputs(executor,declared,[input],context))[0]!;
}
async function admitAssertionInputs(executor:SqlExecutor,declared:GraphContract,inputs:AssertionInput[],context:number):Promise<string[]>{
 const contract=withAssertionContract(declared),binding=requireWriteCapability(executor);const version=checkBinding(binding,contract,context);
 await acquireGraphWriteLock(executor);
 const {entities,instant}=await immutableCatalogue(executor,contract);
 const references=new Map<EvidenceDraft,string>();
 for(const input of inputs)for(const evidence of input.evidence??[]){
  validateEvidenceLocator(evidence.locator??{});
  if(!contract.vertex.find(kind=>kind.name===evidence.target.kind)?.evidence?.immutable)throw new Error(`${WHERE}:151: EVIDENCE_INVALID target must declare immutable evidence support`);
  references.set(evidence,await refUid(executor,contract,await storedReference(executor,contract,evidence.target),context));
 }
 const mentions=inputs.flatMap(input=>input.operation==='assert'?scanMentions(input.value,`/values/${input.property}`):[]);
 const requested=[binding.sourceUid,binding.principalUid,binding.operationUid,...(binding.unitUid?[binding.unitUid]:[]),...mentions.map(mention=>mention.uid),...references.values()];
 const held=(await executor.query<BatchNode>(`SELECT n.id::text,n.uid::text,k.name AS kind,n.key,n.identity_scope::text AS scope FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.uid=ANY($1::uuid[]) OR n.id=ANY($2::bigint[]) ORDER BY n.id FOR UPDATE OF n`,[requested,inputs.filter(input=>input.sort==='vertex').map(input=>input.subjectId)])).rows;
 const nodes=new Map(held.map(node=>[node.uid,{...node,parents:[]}]));
 const edgeSubjects=(await executor.query<{id:string;kind:string;from:string;to:string}>(`SELECT e.id::text,k.name AS kind,e.from_node::text AS "from",e.to_node::text AS "to" FROM edge e JOIN entity k ON k.id=e.entity_id WHERE e.id=ANY($1::bigint[]) ORDER BY e.id FOR UPDATE OF e`,[inputs.filter(input=>input.sort==='edge').map(input=>input.subjectId)])).rows;
 const subjectNodes:string[]=[];const needActive=new Map<string,{uid:string;kind:string;error:string}>();
 for(const input of inputs){
  const subject=input.sort==='vertex'?held.find(node=>node.id===input.subjectId):edgeSubjects.find(edge=>edge.id===input.subjectId);
  if(subject?.kind!==input.kind)throw new Error(`${WHERE}:114: END_KIND_INVALID assertion subject ${input.subjectId}`);
  if(input.sort==='vertex')subjectNodes.push(input.subjectId);else{const edge=edgeSubjects.find(edge=>edge.id===input.subjectId)!;subjectNodes.push(edge.from,edge.to);}
  for(const mention of input.operation==='assert'?scanMentions(input.value,`/values/${input.property}`):[]){const node=nodes.get(mention.uid);if(!node)throw new Error(`${WHERE}:120: TARGET_MISSING ${input.kind} ${mention.uid}`);needActive.set(node.uid,{uid:node.uid,kind:node.kind,error:'TARGET_MISSING'});}
  for(const evidence of input.evidence??[]){const uid=references.get(evidence)!,node=nodes.get(uid);if(!node||node.kind!==evidence.target.kind)throw new Error(`${WHERE}:73: MISSING_ENDPOINT ${evidence.target.kind} ${uid}`);needActive.set(uid,{uid,kind:node.kind,error:'MISSING_ENDPOINT'});}
 }
 await checkBatchActivity(executor,needActive,context,nodes);
 await checkBatchScope(executor,contract,binding,subjectNodes,[],context);
 const assertions=await insertBatchAssertions(executor,{contract,version},inputs,nodes,entities,binding,context,instant);
 return assertions.map(input=>input.uid);
}
export interface GraphDrafts {readonly vertices:readonly VertexDraft[];readonly removals:readonly VertexRemovalDraft[];readonly edges?:readonly EdgeDraft[];readonly edgeRemovals?:readonly EdgeRemovalDraft[]}
interface BatchNode extends Record<string,unknown> {id:string;uid:string;kind:string;key:Record<string,unknown>;scope:string;parents:{kind:string;uid:string;edge:string;direction:string}[]}
interface BatchAssertion extends AssertionInput {uid:string;id?:string;repeat?:boolean;field:FieldContract;mentions:ReturnType<typeof scanMentions>}
/** Fixed phases: local validation → identities (UID_IDENTITY_CONFLICT, REQUIRED_PARENT)
 * → endpoint, mention and evidence-target resolution → one activity check
 * (MISSING_ENDPOINT, TARGET_MISSING) → scope (SOURCE_FORBIDDEN) → assertion
 * admission (IMMUTABLE_KEY, IMMUTABLE_EVIDENCE, digest and content locators)
 * → removals. Within a phase, reject the first draft in input order.
 * Admit at one instant and keep database work set based (0039.25–29). */
async function publishBatch(executor:SqlExecutor,prepared:PreparedContract,drafts:GraphDrafts,context:number):Promise<number>{
 const {contract,version}=prepared,binding=requireWriteCapability(executor);checkBindingRevision(binding,version,context);
 if(drafts.vertices.length===0&&(drafts.edges?.length??0)===0){await acquireGraphWriteLock(executor);return 0;}
 const kinds=new Map(contract.vertex.map(kind=>[kind.name,kind]));
 const references:EntityRefDraft[]=[];const vertexUids:string[]=[];
 const collect=async(ref:EntityRefDraft):Promise<string>=>{
  references.push(ref);for(const parent of Object.values(ref.keyEdges??{}))await collect(parent);
  if(ref.uid!==undefined&&Object.keys(ref.key).length===0&&ref.keyEdges===undefined)return ref.uid;
  return refUid(executor,contract,ref,context);
 };
 for(const draft of drafts.vertices){permitted(binding,draft.kind,'$exists');vertexUids.push(await collect(draft));}
 for(const draft of drafts.edges??[]){await collect(draft.from);await collect(draft.to);}
 for(const draft of drafts.vertices)for(const evidence of draft.evidence??[])await collect(evidence.target);
 for(const draft of drafts.edges??[])for(const evidence of draft.evidence??[])await collect(evidence.target);
 const mentions=drafts.vertices.flatMap(draft=>Object.values(draft.values??{}).flatMap(value=>scanMentions(value,''))).concat((drafts.edges??[]).flatMap(draft=>Object.values(draft.values??{}).flatMap(value=>scanMentions(value,''))));
 const requested=new Set<string>([...vertexUids,binding.sourceUid,binding.principalUid,binding.operationUid,...(binding.unitUid?[binding.unitUid]:[]),...mentions.map(mention=>mention.uid)]);
 for(const ref of references)requested.add(ref.uid!==undefined&&Object.keys(ref.key).length===0&&ref.keyEdges===undefined?ref.uid:await refUid(executor,contract,ref,context));
 await acquireGraphWriteLock(executor);
 const {entities,instant}=await immutableCatalogue(executor,contract);
 const keyRoles=contract.vertex.flatMap(kind=>(kind.keyEdges??[]).map(role=>({kind:kind.name,edge:role.edge,direction:role.direction})));
 const cache=await immutableLookups(executor);
 const complete=(uid:string,visited=new Set<string>()):boolean=>{
  if(visited.has(uid))return true;visited.add(uid);
  const node=cache.vertices.get(uid);return node!==undefined&&node.parents.every(parent=>complete(parent.uid,visited));
 };
 const missing=[...requested].filter(uid=>!complete(uid));
 // On a complete hit, verify the cached ids still exist without resolving
 // UIDs again. Keep the batch's fixed read shape for fresh and repeat writes.
 const existing=missing.length?(await executor.query<BatchNode>(`WITH RECURSIVE wanted(uid) AS (
  SELECT unnest($1::uuid[]) UNION
  SELECT parent.uid FROM wanted w CROSS JOIN LATERAL (SELECT child.* FROM node child WHERE child.uid=w.uid OFFSET 0) child JOIN entity ck ON ck.id=child.entity_id
  JOIN jsonb_to_recordset($2::jsonb) role(kind text,edge text,direction text) ON role.kind=ck.name
  JOIN entity ek ON ek.name=role.edge AND ek.sort='edge'
  CROSS JOIN LATERAL (
   SELECT e.to_node AS id FROM edge e WHERE role.direction='from' AND e.entity_id=ek.id AND e.from_node=child.id
   UNION ALL
   SELECT e.from_node AS id FROM edge e WHERE role.direction='to' AND e.entity_id=ek.id AND e.to_node=child.id
  ) link JOIN node parent ON parent.id=link.id
 ) SELECT n.id::text,n.uid::text,k.name AS kind,n.key,n.identity_scope::text AS scope,
 coalesce((SELECT jsonb_agg(jsonb_build_object('kind',pk.name,'uid',parent.uid,'edge',role.edge,'direction',role.direction))
 FROM jsonb_to_recordset($2::jsonb) role(kind text,edge text,direction text)
 JOIN entity ek ON ek.name=role.edge AND ek.sort='edge'
 CROSS JOIN LATERAL (
  SELECT e.to_node AS id FROM edge e WHERE role.direction='from' AND e.entity_id=ek.id AND e.from_node=n.id
  UNION ALL
  SELECT e.from_node AS id FROM edge e WHERE role.direction='to' AND e.entity_id=ek.id AND e.to_node=n.id
 ) link JOIN node parent ON parent.id=link.id JOIN entity pk ON pk.id=parent.entity_id
 WHERE role.kind=k.name),'[]'::jsonb) AS parents
 FROM wanted w CROSS JOIN LATERAL (SELECT n.* FROM node n WHERE n.uid=w.uid OFFSET 0) n JOIN entity k ON k.id=n.entity_id`,[missing,JSON.stringify(keyRoles)])).rows:(await executor.query<BatchNode>('SELECT id::text,uid::text FROM node WHERE id=ANY($1::bigint[])',[ [...requested].map(uid=>cache.vertices.get(uid)!.id) ])).rows;
 if(!missing.length){
  if(existing.length!==requested.size||existing.some(row=>!requested.has(row.uid)||cache.vertices.get(row.uid)?.id!==row.id)||new Set(existing.map(row=>row.uid)).size!==requested.size)throw new Error(`${WHERE}:320: UID_IDENTITY_CONFLICT cached batch identities`);
  for(let i=0;i<existing.length;i++)existing[i]=cache.vertices.get(existing[i]!.uid)!;
 }
 for(const node of existing)cache.vertices.set(node.uid,node);
 const nodes=new Map<string,BatchNode>();
 for(const uid of requested){const node=cache.vertices.get(uid);if(node!==undefined)nodes.set(uid,node);}
 for(const node of existing)nodes.set(node.uid,node);
 const includeParents=(node:ImmutableVertex):void=>{for(const parent of node.parents){if(nodes.has(parent.uid))continue;const held=cache.vertices.get(parent.uid);if(held){nodes.set(parent.uid,held);includeParents(held);}}};
 for(const node of nodes.values())includeParents(node);
 const resolvedRef=(ref:EntityRefDraft,visited:readonly string[]=[]):EntityRefDraft=>{
  if(ref.uid===undefined||Object.keys(ref.key).length>0||ref.keyEdges!==undefined)return ref;
  const held=nodes.get(ref.uid);if(!held||held.kind!==ref.kind)throw new Error(`${WHERE}:74: MISSING_ENDPOINT ${ref.kind} ${ref.uid}`);
  if(visited.includes(ref.uid))throw new Error(`${WHERE}:74: KEY_EDGE_CYCLE ${ref.kind}`);
  const keyEdges:Record<string,EntityRefDraft>={};
  for(const role of kinds.get(ref.kind)?.keyEdges??[]){const parents=held.parents.filter(parent=>parent.edge===role.edge&&parent.direction===role.direction);if(parents.length!==1)throw new Error(`${WHERE}:74: REQUIRED_PARENT ${ref.kind}.${role.role}`);const parent=parents[0]!;keyEdges[role.role]=resolvedRef({kind:parent.kind,uid:parent.uid,key:{}},[...visited,ref.uid]);}
  return {...ref,key:held.key as EntityRefDraft['key'],...(Object.keys(keyEdges).length?{keyEdges}:{})};
 };
 const referenceUid=async(ref:EntityRefDraft)=>refUid(executor,contract,resolvedRef(ref),context);
 const births:{uid:string;kind:string;key:Record<string,unknown>;scope:string}[]=[];
 const birthByUid=new Map<string,(typeof births)[number]>();
 for(const [index,draft] of drafts.vertices.entries()){
  const kind=kinds.get(draft.kind)!;const key=Object.fromEntries(kind.key.map(name=>[name,draft.key[name]]));const pairs:string[]=[];
  for(const role of kind.keyEdges??[])pairs.push(role.role,await referenceUid(draft.keyEdges![role.role]!));
  const scope=kind.identity?.namespace??(pairs.length===2?pairs[1]!:pairs.length?keyUid('madarch.parent-scope',pairs):binding.productUid);
  const uid=vertexUids[index]!;const held=nodes.get(uid);
  if(held&&(held.kind!==kind.name||!sameValue(held.key,key)||held.scope!==scope))throw new Error(`${WHERE}:42: UID_IDENTITY_CONFLICT ${uid}`);
  const prior=birthByUid.get(uid);if(prior&&(prior.kind!==kind.name||!sameValue(prior.key,key)||prior.scope!==scope))throw new Error(`${WHERE}:42: UID_IDENTITY_CONFLICT ${uid}`);
  if(!prior){const birth={uid,kind:kind.name,key,scope};births.push(birth);birthByUid.set(uid,birth);}
 }
 await executor.query<{id:string;uid:string}>(`INSERT INTO node(entity_id,uid,key,identity_scope,context_id)
 SELECT k.id,input.uid,input.key,input.scope,$5::bigint FROM unnest($1::uuid[],$2::text[],$3::jsonb[],$4::uuid[]) WITH ORDINALITY input(uid,kind,key,scope,ord)
 JOIN entity k ON k.name=input.kind AND k.sort='node' ORDER BY input.ord ON CONFLICT DO NOTHING RETURNING id::text,uid::text`,[births.map(b=>b.uid),births.map(b=>b.kind),births.map(b=>JSON.stringify(b.key)),births.map(b=>b.scope),context]);

 const unknownBirths=births.filter(birth=>!nodes.has(birth.uid));
 const locked=(await executor.query<BatchNode>(unknownBirths.length?`SELECT n.id::text,n.uid::text,k.name AS kind,n.key,n.identity_scope::text AS scope FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.uid=ANY($1::uuid[]) ORDER BY n.id FOR UPDATE OF n`:`SELECT n.id::text,n.uid::text,k.name AS kind,n.key,n.identity_scope::text AS scope FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.id=ANY($1::bigint[]) ORDER BY n.id FOR UPDATE OF n`,[unknownBirths.length?births.map(b=>b.uid):births.map(b=>nodes.get(b.uid)!.id)])).rows;
 if(locked.length!==births.length||locked.some(node=>!birthByUid.has(node.uid)||(!unknownBirths.length&&nodes.get(node.uid)?.id!==node.id))||new Set(locked.map(node=>node.uid)).size!==births.length)throw new Error(`${WHERE}:366: UID_IDENTITY_CONFLICT locked batch identities`);
 for(const node of locked)nodes.set(node.uid,{...node,parents:nodes.get(node.uid)?.parents??[]});
 for(const birth of births){const held=nodes.get(birth.uid);if(!held||held.kind!==birth.kind||held.scope!==birth.scope||!sameValue(held.key,birth.key))throw new Error(`${WHERE}:42: UID_IDENTITY_CONFLICT ${birth.uid}`);}
 const activeBirths=new Set(drafts.vertices.flatMap((draft,index)=>(draft.validFrom===undefined||Date.parse(draft.validFrom)<=instant)&&(draft.validTo==null||Date.parse(draft.validTo)>instant)?[vertexUids[index]!]:[]));
 const needActive=new Map<string,{uid:string;kind:string;error:string}>();
 const getEndpoint=async(ref:EntityRefDraft,error='MISSING_ENDPOINT'):Promise<BatchNode>=>{
  const uid=await referenceUid(ref);const node=nodes.get(uid);if(!node||node.kind!==ref.kind)throw new Error(`${WHERE}:73: ${error} ${ref.kind} ${uid}`);
  if(!(activeBirths.has(uid)))needActive.set(uid,{uid,kind:ref.kind,error});return node;
 };
 const edgeInputs:{uid:string;kind:string;from:string;to:string;discriminator:string}[]=[];
 const addEdge=(kind:string,from:BatchNode,to:BatchNode,discriminator:string)=>{const uid=edgeUid(kind,from.uid,to.uid,discriminator);edgeInputs.push({uid,kind,from:from.id,to:to.id,discriminator});return uid;};
 const plans:({-readonly [K in keyof AssertionInput]:AssertionInput[K]}&{edgeUid?:string})[]=[];let written=0;
 for(const [index,draft] of drafts.vertices.entries()){
  const kind=kinds.get(draft.kind)!,node=nodes.get(vertexUids[index]!)!;
  const common={sort:'vertex' as const,kind:draft.kind,subjectId:node.id,operation:'assert' as const,evidence:draft.evidence,validFrom:draft.validFrom,validTo:draft.validTo};
  plans.push({...common,property:'$exists',value:true});written++;
  for(const name of kind.key){plans.push({...common,property:name,value:draft.key[name]});written++;}
  for(const [property,value] of Object.entries(draft.values??{})){plans.push({...common,property,value,language:draft.lang});written++;}
  for(const role of kind.keyEdges??[]){const parent=await getEndpoint(draft.keyEdges![role.role]!);const uid=addEdge(role.edge,role.direction==='from'?node:parent,role.direction==='from'?parent:node,'');plans.push({...common,sort:'edge',kind:role.edge,subjectId:'',edgeUid:uid,property:'$exists',value:true});}
 }
 for(const draft of drafts.edges??[]){const kind=contract.edge.find(k=>k.name===draft.kind)!;
  if(!endpointKindNames(kind.from,contract.vertex).includes(draft.from.kind)||!endpointKindNames(kind.to,contract.vertex).includes(draft.to.kind))throw new Error(`${WHERE}:158: ENDPOINT_KIND ${draft.kind}`);
  const from=await getEndpoint(draft.from),to=await getEndpoint(draft.to);const uid=addEdge(draft.kind,from,to,draft.discriminator??'');
  const common={sort:'edge' as const,kind:draft.kind,subjectId:'',edgeUid:uid,operation:'assert' as const,evidence:draft.evidence,validFrom:draft.validFrom,validTo:draft.validTo};
  plans.push({...common,property:'$exists',value:true});written++;
  for(const [property,value] of Object.entries(draft.values??{})){plans.push({...common,property,value,language:draft.lang});written++;}
 }
 for(const plan of plans){
  for(const mention of scanMentions(plan.value,`/values/${plan.property.split('~').join('~0').split('/').join('~1')}`)){const node=nodes.get(mention.uid);if(!node)throw new Error(`${WHERE}:120: TARGET_MISSING ${mention.path} ${mention.uid}`);if(!(activeBirths.has(node.uid)))needActive.set(node.uid,{uid:node.uid,kind:node.kind,error:`TARGET_MISSING ${mention.path}`});}
  for(const evidence of plan.evidence??[]){try{validateEvidenceLocator(evidence.locator??{});if(!kinds.get(evidence.target.kind)?.evidence?.immutable)throw new Error(`${WHERE}:151: EVIDENCE_INVALID target must declare immutable evidence support`);await getEndpoint(evidence.target);}catch(error){throw new Error(`${String(error)}; subject ${plan.kind} ${[...nodes.values()].find(node=>node.id===plan.subjectId)?.uid??plan.subjectId}`);}}
 }
 const edgeRows=(await executor.query<{id:string;uid:string}>(`INSERT INTO edge(uid,entity_id,from_node,to_node,discriminator,context_id)
 SELECT DISTINCT input.uid,k.id,input.f,input.t,input.discriminator,$2::bigint FROM jsonb_to_recordset($1::jsonb) input(uid uuid,kind text,f bigint,t bigint,discriminator text) JOIN entity k ON k.name=input.kind AND k.sort='edge' ON CONFLICT DO NOTHING RETURNING id::text,uid::text`,[JSON.stringify(edgeInputs.map(edge=>({...edge,f:edge.from,t:edge.to}))),context])).rows;
 const edges=new Map(edgeRows.map(edge=>[edge.uid,edge.id]));
 for(const row of (await executor.query<{id:string;uid:string}>('SELECT id::text,uid::text FROM edge WHERE uid=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[edgeInputs.map(edge=>edge.uid)])).rows)edges.set(row.uid,row.id);
 for(const plan of plans)if(plan.edgeUid)plan.subjectId=edges.get(plan.edgeUid)!;
 await checkBatchActivity(executor,needActive,context,nodes);
 const subjectNodes=plans.flatMap(plan=>plan.sort==='vertex'?[plan.subjectId]:edgeInputs.filter(edge=>edges.get(edge.uid)===plan.subjectId).flatMap(edge=>[edge.from,edge.to]));
 await checkBatchScope(executor,contract,binding,subjectNodes,[...edges.values()],context);
 await insertBatchAssertions(executor,prepared,plans,nodes,entities,binding,context,instant);
 for(const node of nodes.values()){
  const parents=keyRoles.filter(role=>role.kind===node.kind).flatMap(role=>edgeInputs.filter(edge=>edge.kind===role.edge&&(role.direction==='from'?edge.from:edge.to)===node.id).map(edge=>{
   const parent=[...nodes.values()].find(candidate=>candidate.id===(role.direction==='from'?edge.to:edge.from))!;
   return {kind:parent.kind,uid:parent.uid,edge:role.edge,direction:role.direction};
  }));
  cache.vertices.set(node.uid,{...node,parents:parents.length?parents:node.parents});
 }
 return written;
}
async function checkBatchActivity(executor:SqlExecutor,needActive:Map<string,{uid:string;kind:string;error:string}>,context:number,nodes:Map<string,BatchNode>):Promise<void>{
 const inactive=(await executor.query<{uid:string}>(`SELECT input.uid::text FROM jsonb_to_recordset($1::jsonb) input(uid uuid,id bigint,kind text) WHERE NOT graph_vertex_active(input.id,input.kind,$2::bigint)`,[JSON.stringify([...needActive.values()].map(input=>({...input,id:nodes.get(input.uid)!.id}))),context])).rows;
 if(inactive.length){const missing=new Set(inactive.map(node=>node.uid));const first=[...needActive.values()].find(node=>missing.has(node.uid))!;throw new Error(`${WHERE}:73: ${first.error} ${first.kind} ${first.uid}`);}
}
async function checkBatchScope(executor:SqlExecutor,contract:GraphContract,binding:WriteCapability,subjectNodes:string[],plannedEdges:string[],context:number):Promise<void>{
 const scope=(await executor.query<{id:string}>(`WITH RECURSIVE members(subject,id) AS (
 SELECT id,id FROM unnest($4::bigint[]) x(id) WHERE $1::uuid<>$5::uuid AND $3::bigint>0 UNION
 SELECT m.subject,link.id FROM members m CROSS JOIN LATERAL (
 SELECT e.to_node AS id FROM edge e JOIN entity k ON k.id=e.entity_id
 JOIN jsonb_to_recordset($2::jsonb) role(edge text,direction text) ON role.edge=k.name AND role.direction='from'
 WHERE e.from_node=m.id AND (e.id=ANY($6::bigint[]) OR graph_edge_active(e.id,k.name,$3::bigint))
 UNION ALL
 SELECT e.from_node AS id FROM edge e JOIN entity k ON k.id=e.entity_id
 JOIN jsonb_to_recordset($2::jsonb) role(edge text,direction text) ON role.edge=k.name AND role.direction='to'
 WHERE e.to_node=m.id AND (e.id=ANY($6::bigint[]) OR graph_edge_active(e.id,k.name,$3::bigint))
 ) link
 ) SELECT id::text FROM unnest($4::bigint[]) subject(id) WHERE $1::uuid<>$5::uuid AND NOT EXISTS(SELECT 1 FROM members m JOIN node n ON n.id=m.id WHERE m.subject=subject.id AND n.uid=$1::uuid)`,[binding.scope,JSON.stringify(contract.vertex.flatMap(kind=>(kind.keyEdges??[]).map(role=>({edge:role.edge,direction:role.direction})))),context,[...new Set(subjectNodes)],binding.productUid,plannedEdges])).rows;
 if(scope.length)throw new Error(`${WHERE}:128: SOURCE_FORBIDDEN assertion outside authenticated scope`);
}

async function insertBatchAssertions(executor:SqlExecutor,prepared:PreparedContract,plans:AssertionInput[],nodes:Map<string,BatchNode>,entities:Map<string,string>,binding:WriteCapability,context:number,instant:number):Promise<BatchAssertion[]>{
 const {contract}=prepared;
 const nodeIds=new Map([...nodes.values()].map(node=>[node.id,node]));
 const assertions:BatchAssertion[]=plans.map(input=>{
  permitted(binding,input.kind,input.property,input.operation==='retract');
  const kind=contract[input.sort].find(kind=>kind.name===input.kind)!;
  const field=input.property==='$exists'?{name:'$exists',type:'boolean' as const}:kind.fields.find(field=>field.name===input.property);
  if(!field)throw new Error(`${WHERE}:116: UNKNOWN_PROPERTY ${input.kind}.${input.property}`);
  if(input.sort==='vertex'&&'key' in kind&&kind.key.includes(input.property)){
   if(input.operation!=='assert'||input.language!=null||!sameValue(nodeIds.get(input.subjectId)!.key[input.property],input.value))throw new Error(`${WHERE}:165: IMMUTABLE_KEY ${input.kind}.${input.property}: identity changes require a new UID`);
  }
  if(input.operation==='assert'){validate(field,input.value);validateFieldValue(contract,field,input.value);}else if(input.value!==undefined)throw new Error(`${WHERE}:117: RETRACTION_VALUE`);
  return {...input,uid:newUid(),field,mentions:scanMentions(input.value,`/values/${input.property.split('~').join('~0').split('/').join('~1')}`)};
 });
 const tables=new Map<string,{kind:string;sort:'vertex'|'edge';property:string}>();
 for(const input of assertions)tables.set(assertionValueTableName(input.kind,input.sort,input.property),{kind:input.kind,sort:input.sort,property:input.property});
 const literal=(value:string)=>"'"+value.replaceAll("'","''")+"'";
 const streamParts=[...tables].map(([table,slot])=>`SELECT ${literal(slot.sort)}::text AS sort,wanted.subject::text AS subject,a.property,a.language,a.operation,a.valid_from::text,a.valid_to::text,a.recorded_sequence::text,n.uid::text,a.assertion_id::text AS id,CASE WHEN pg_typeof(v.value)::text='bigint' THEN to_jsonb(v.value::text) ELSE to_jsonb(v.value) END AS value
 FROM (SELECT DISTINCT subject,language FROM jsonb_to_recordset($1::jsonb) x(sort text,kind text,subject bigint,property text,language text) WHERE sort=${literal(slot.sort)} AND kind=${literal(slot.kind)} AND property=${literal(slot.property)}) wanted
 CROSS JOIN LATERAL (
 ${slot.sort==='vertex'?`SELECT attachment.assertion_id FROM edge se CROSS JOIN LATERAL (SELECT s.assertion_id FROM assertion_vertex_subject s WHERE s.subject_edge_id=se.id OFFSET 0) attachment WHERE se.to_node=wanted.subject AND se.entity_id=${entities.get('edge:system.assertion-subject')}::bigint`:`SELECT s.assertion_id FROM assertion_edge_subject s WHERE s.edge_id=wanted.subject`}
 OFFSET 0
 ) subject
 CROSS JOIN LATERAL (SELECT header.* FROM assertion header WHERE header.assertion_id=subject.assertion_id OFFSET 0) a
 JOIN node n ON n.id=a.assertion_id
 LEFT JOIN "${table}" v ON v.assertion_id=a.assertion_id
 WHERE a.context_id=$2::bigint AND a.property=${literal(slot.property)} AND a.language IS NOT DISTINCT FROM wanted.language AND EXISTS(SELECT 1 FROM edge source WHERE source.from_node=a.assertion_id AND source.entity_id=${entities.get('edge:system.assertion-source')}::bigint AND source.to_node=${nodes.get(binding.sourceUid)!.id}::bigint)`);
 interface StreamRow extends Record<string,unknown> {sort:string;subject:string;property:string;language:string|null;operation:string;valid_from:string;valid_to:string|null;recorded_sequence:string;uid:string;id:string;value:unknown}
 const streams=new Map<string,StreamRow[]>();
 const streamKey=(sort:string,subject:string,property:string,language:string|null)=>JSON.stringify([sort,subject,property,language]);
 const streamRows=(await executor.query<StreamRow>(streamParts.length?streamParts.join(' UNION ALL '):'SELECT NULL WHERE FALSE',[JSON.stringify(assertions.map(input=>({sort:input.sort,kind:input.kind,subject:input.subjectId,property:input.property,language:input.language??null}))),context])).rows;
 for(const row of streamRows){const key=streamKey(row.sort,row.subject,row.property,row.language);const held=streams.get(key)??[];held.push(row);streams.set(key,held);}
 // Immutable support checks include all history, not just the current source stream.
 const immutableTables=new Map<string,{kind:string;property:string;ids:string[]}>();
 const supportIds=new Map<string,Set<string>>();
 for(const input of assertions)if(input.sort==='vertex'&&contract.vertex.find(kind=>kind.name===input.kind)?.evidence?.immutable){const ids=supportIds.get(input.kind)??new Set<string>();ids.add(input.subjectId);supportIds.set(input.kind,ids);}
 for(const input of assertions)for(const evidence of input.evidence??[]){const uid=evidence.target.uid??await refUid(executor,contract,evidence.target,context);const target=nodes.get(uid)!;const ids=supportIds.get(target.kind)??new Set<string>();ids.add(target.id);supportIds.set(target.kind,ids);}
 for(const [name,ids] of supportIds){const kind=contract.vertex.find(kind=>kind.name===name)!;for(const field of [{name:'$exists'},...kind.fields])immutableTables.set(assertionValueTableName(kind.name,'vertex',field.name),{kind:kind.name,property:field.name,ids:[...ids]});}
 const cache=await immutableLookups(executor);
 const immutableParts=[...immutableTables].map(([table,slot])=>[table,{...slot,ids:slot.ids.filter(id=>!cache.values.has(JSON.stringify([id,slot.property])))}] as const).filter(([,slot])=>slot.ids.length>0).map(([table,slot])=>`SELECT wanted.id::text AS subject,${literal(slot.property)}::text AS property,to_jsonb(v.value) AS value,a.recorded_sequence::text AS sequence FROM unnest(ARRAY[${slot.ids.join(',')}]::bigint[]) wanted(id)
 CROSS JOIN LATERAL (SELECT se.id FROM edge se WHERE se.to_node=wanted.id AND se.entity_id=${entities.get('edge:system.assertion-subject')}::bigint OFFSET 0) se
 CROSS JOIN LATERAL (SELECT s.assertion_id FROM assertion_vertex_subject s WHERE s.subject_edge_id=se.id OFFSET 0) s
 CROSS JOIN LATERAL (SELECT v.value FROM "${table}" v WHERE v.assertion_id=s.assertion_id OFFSET 0) v JOIN assertion a ON a.assertion_id=s.assertion_id`);
 const immutable=immutableParts.length?(await executor.query<{subject:string;property:string;value:unknown;sequence:string}>(immutableParts.join(' UNION ALL '))).rows:[];
 const immutableValues=new Map<string,unknown[]>();const content=new Map<string,{value:unknown;sequence:bigint}>();
 for(const row of immutable){const key=JSON.stringify([row.subject,row.property]);const values=immutableValues.get(key)??[];values.push(row.value);immutableValues.set(key,values);const prior=content.get(key);if(!prior||BigInt(row.sequence)>prior.sequence)content.set(key,{value:row.value,sequence:BigInt(row.sequence)});}
 for(const slot of immutableTables.values())for(const id of slot.ids){
  const key=JSON.stringify([id,slot.property]),value=cache.values.get(key);
  if(value!==undefined&&!immutableValues.has(key)){immutableValues.set(key,[value]);content.set(key,{value,sequence:0n});}
 }
 let sequence=streamRows.reduce((max,row)=>BigInt(row.recorded_sequence)>max?BigInt(row.recorded_sequence):max,0n);
 for(const input of assertions){
  const kind=input.sort==='vertex'?contract.vertex.find(kind=>kind.name===input.kind):undefined;
  if(kind?.evidence?.immutable){
   if(input.operation==='retract'||(input.property==='$exists'&&input.value!==true))throw new Error(`${WHERE}:128: IMMUTABLE_EVIDENCE immutable support cannot be retired`);
   const key=JSON.stringify([input.subjectId,input.property]);const values=immutableValues.get(key)??[];
   if(values.some(value=>!sameValue(value,input.value)))throw new Error(`${WHERE}:130: IMMUTABLE_EVIDENCE support values cannot change`);
   values.push(input.value);immutableValues.set(key,values);content.set(key,{value:input.value,sequence:++sequence});
   if(input.property===kind.evidence.contentField&&input.value!==null&&kind.evidence.digestField){const node=nodeIds.get(input.subjectId)!;if(createHash('sha256').update(String(input.value),'utf8').digest('hex')!==node.key[kind.evidence.digestField])throw new Error(`${WHERE}:131: EVIDENCE_INVALID snapshot content contradicts digest`);}
  }
  const key=streamKey(input.sort,input.subjectId,input.property,input.language??null);const stream=streams.get(key)??[];
  const at=input.validFrom===undefined?instant:Date.parse(input.validFrom),end=input.validTo==null?null:Date.parse(input.validTo);
  const current=stream.filter(row=>Date.parse(row.valid_from)<=at&&(row.valid_to===null||Date.parse(row.valid_to)>at)).sort((a,b)=>BigInt(a.recorded_sequence)>BigInt(b.recorded_sequence)?-1:1)[0];
  const normalize=(value:unknown)=>input.field.type==='timestamp'&&value!=null?new Date(String(value)).toISOString():value;
  const unchanged=current!==undefined&&(current.valid_to===null?end===null:Date.parse(current.valid_to)===end)&&!stream.some(row=>BigInt(row.recorded_sequence)>BigInt(current.recorded_sequence)&&(end===null||Date.parse(row.valid_from)<end)&&(row.valid_to===null||Date.parse(row.valid_to)>at));
  if(input.operation==='assert'&&current?.operation==='assert'&&unchanged&&sameValue(normalize(current.value),normalize(input.value))){input.uid=current.uid;input.id=current.id;input.repeat=true;}
  else {input.id=input.uid;stream.push({sort:input.sort,subject:input.subjectId,property:input.property,language:input.language??null,operation:input.operation,value:input.value,valid_from:new Date(at).toISOString(),valid_to:end===null?null:new Date(end).toISOString(),recorded_sequence:String(++sequence),uid:input.uid,id:input.uid});streams.set(key,stream);}
 }
 // Validate evidence only after all immutable support values in this batch are known.
 const evidenceTargets=new Map<EvidenceDraft,BatchNode>();
 for(const input of assertions)for(const evidence of input.evidence??[]){
  let target:BatchNode|undefined;
  if(evidence.target.uid)target=nodes.get(evidence.target.uid);
  else {const uid=await refUid(executor,contract,evidence.target,context);target=nodes.get(uid);}
  if(!target)throw new Error(`${WHERE}:73: MISSING_ENDPOINT ${evidence.target.kind}`);
  evidenceTargets.set(evidence,target);const field=contract.vertex.find(kind=>kind.name===evidence.target.kind)!.evidence!.contentField;
  const text=field?content.get(JSON.stringify([target.id,field]))?.value:undefined;
  const locator=evidence.locator??{};
  if(typeof text==='string'){
   if((typeof locator.end==='number'&&locator.end>[...text].length)||(typeof locator.lineEnd==='number'&&locator.lineEnd>text.split('\n').length))throw new Error(`${WHERE}:154: EVIDENCE_INVALID locator outside immutable content; subject ${input.kind} ${nodeIds.get(input.subjectId)?.uid??input.subjectId}`);
   if(typeof locator.digest==='string'&&createHash('sha256').update(text,'utf8').digest('hex')!==locator.digest)throw new Error(`${WHERE}:154: EVIDENCE_INVALID locator digest contradicts immutable content`);
  }
 }
 const fresh=assertions.filter(input=>!input.repeat);
 const lineageNode=(uid:string)=>{const node=nodes.get(uid);if(!node)throw new Error(`${WHERE}:102: MISSING_LINEAGE_TARGET ${uid}`);return node;};
 const structural:{uid:string;kind:string;assertion:string;target:string}[]=[];
 const subjectUids=new Map<string,string>();
 for(const input of fresh){
  const add=(kind:string,target:BatchNode)=>{const uid=edgeUid(kind,input.uid,target.uid,'');structural.push({uid,kind:entities.get('edge:'+kind)!,assertion:input.uid,target:target.id});return uid;};
  if(input.sort==='vertex')subjectUids.set(input.uid,add('system.assertion-subject',nodeIds.get(input.subjectId)!));
  for(const [relation,uid] of [['source',binding.sourceUid],['author',binding.principalUid],['operation',binding.operationUid],...(binding.unitUid?[['unit',binding.unitUid]]:[])])add('system.assertion-'+relation,lineageNode(uid!));
 }
 const data=fresh.map((input,ord)=>({uid:input.uid,property:input.property,language:input.language??null,valid_from:input.validFrom??new Date(instant).toISOString(),valid_to:input.validTo??null,operation:input.operation,subject:input.subjectId,sort:input.sort,subject_edge:subjectUids.get(input.uid)??null,ord}));
 const made=(await executor.query<{id:string;uid:string}>(`WITH input AS MATERIALIZED (SELECT * FROM jsonb_to_recordset($1::jsonb) x(uid uuid,property text,language text,valid_from timestamptz,valid_to timestamptz,operation text,subject bigint,sort text,subject_edge uuid,ord int)), identities AS (
 INSERT INTO node(entity_id,uid,key,identity_scope,context_id) SELECT $3::bigint,uid,'{}'::jsonb,$4::uuid,$5::bigint FROM input ORDER BY ord RETURNING id,uid
 ), headers AS (
 INSERT INTO assertion(assertion_id,property,language,context_id,valid_from,valid_to,operation)
 SELECT n.id,i.property,i.language,$5::bigint,i.valid_from,i.valid_to,i.operation FROM input i JOIN identities n USING(uid) ORDER BY i.ord RETURNING assertion_id
 ), structural AS (
 INSERT INTO edge(uid,entity_id,from_node,to_node,discriminator,context_id)
 SELECT s.uid,s.kind,n.id,s.target,'',$5::bigint FROM jsonb_to_recordset($2::jsonb) s(uid uuid,kind bigint,assertion uuid,target bigint) JOIN identities n ON n.uid=s.assertion JOIN headers h ON h.assertion_id=n.id RETURNING id,uid
 ), vertex_subjects AS (
 INSERT INTO assertion_vertex_subject(assertion_id,subject_edge_id) SELECT n.id,s.id FROM input i JOIN identities n USING(uid) JOIN structural s ON s.uid=i.subject_edge WHERE i.sort='vertex' RETURNING assertion_id
 ), edge_subjects AS (
 INSERT INTO assertion_edge_subject(assertion_id,edge_id) SELECT n.id,i.subject FROM input i JOIN identities n USING(uid) JOIN headers h ON h.assertion_id=n.id WHERE i.sort='edge' RETURNING assertion_id
 ) SELECT id::text,uid::text FROM identities`,[JSON.stringify(data),JSON.stringify(structural),entities.get('node:system.assertion'),binding.productUid,context])).rows;
 const ids=new Map(made.map(row=>[row.uid,row.id]));
 for(const input of assertions)input.id=ids.get(input.uid)??input.id;
 for(const [table] of tables){const values=fresh.filter(input=>assertionValueTableName(input.kind,input.sort,input.property)===table&&input.operation==='assert');const field=values[0]?.field??assertions.find(input=>assertionValueTableName(input.kind,input.sort,input.property)===table)!.field;
  const isJson=(field:FieldContract):boolean=>field.type==='json';
  const type=field.type==='timestamp'?'timestamptz':isJson(field)?'jsonb':field.type==='integer'?'integer':field.type==='bigint'?'bigint':field.type==='boolean'?'boolean':'text';
  if(isJson(field))await executor.query(`INSERT INTO "${table}"(assertion_id,value) SELECT id,value::jsonb FROM unnest($1::bigint[],$2::text[]) input(id,value)`,[values.map(input=>input.id),values.map(input=>JSON.stringify(input.value))]);
  else await executor.query(`INSERT INTO "${table}"(assertion_id,value) SELECT input.id,input.value FROM jsonb_to_recordset($1::jsonb) input(id bigint,value ${type})`,[JSON.stringify(values.map(input=>({id:input.id,value:input.value})))]);
 }
 const repeatEdges:{uid:string;kind:string;from:string;to:string}[]=[];
 for(const input of assertions.filter(input=>input.repeat))for(const [relation,uid] of [['operation',binding.operationUid],...(binding.unitUid?[['unit',binding.unitUid]]:[])]){const kind='system.assertion-'+relation;repeatEdges.push({uid:edgeUid(kind,input.uid,uid!,''),kind:entities.get('edge:'+kind)!,from:input.id!,to:lineageNode(uid!).id});}
 await executor.query(`INSERT INTO edge(uid,entity_id,from_node,to_node,discriminator,context_id) SELECT DISTINCT x.uid,x.kind,x.f,x.t,'',$2::bigint FROM jsonb_to_recordset($1::jsonb) x(uid uuid,kind bigint,f bigint,t bigint) ON CONFLICT DO NOTHING`,[JSON.stringify(repeatEdges.map(edge=>({...edge,f:edge.from,t:edge.to}))),context]);
 const extraEdges:{uid:string;kind:string;from:string;to:string;discriminator:string}[]=[];
 for(const input of assertions){
  for(const [index,evidence] of (input.evidence??[]).entries()){const target=evidenceTargets.get(evidence)!;const discriminator=canonicalJson({index,relation:evidence.relation??'supports',locator:evidence.locator??{}});const kind='system.assertion-evidence';extraEdges.push({uid:edgeUid(kind,input.uid,target.uid,discriminator),kind:entities.get('edge:'+kind)!,from:input.id!,to:target.id,discriminator});}
  for(const mention of input.mentions){const target=lineageNode(mention.uid);const discriminator=JSON.stringify({path:mention.path,start:mention.start,end:mention.end});const kind='system.assertion-mentions';extraEdges.push({uid:edgeUid(kind,input.uid,target.uid,discriminator),kind:entities.get('edge:'+kind)!,from:input.id!,to:target.id,discriminator});}
 }
 await executor.query(`INSERT INTO edge(uid,entity_id,from_node,to_node,discriminator,context_id) SELECT DISTINCT x.uid,x.kind,x.f,x.t,x.discriminator,$2::bigint FROM jsonb_to_recordset($1::jsonb) x(uid uuid,kind bigint,f bigint,t bigint,discriminator text) ON CONFLICT DO NOTHING`,[JSON.stringify(extraEdges.map(edge=>({...edge,f:edge.from,t:edge.to}))),context]);
 for(const [key,values] of immutableValues)if(!cache.values.has(key)&&values.length&&values.every(value=>sameValue(value,values[0])))cache.values.set(key,values[0]);
 return assertions;
}

export async function publishGraphDrafts(executor:SqlExecutor,declared:GraphContract,drafts:GraphDrafts,context=1,_options:Record<string,unknown>={}):Promise<number>{
 return await withSpan('graph.publish',{},async()=>{
 const prepared=preparePublicationContract(declared);const {contract}=prepared;checkBindingRevision(requireWriteCapability(executor),prepared.version,context);
 const checkFields=(kind:{readonly name:string;readonly fields:readonly FieldContract[]},values:Readonly<Record<string,unknown>>):void=>{
  for(const [name,value] of Object.entries(values)){const field=kind.fields.find(field=>field.name===name);if(!field)throw new Error(`${WHERE}:193: UNKNOWN_FIELD ${kind.name}.${name}`);validate(field,value);validateFieldValue(contract,field,value);}
 };
 const checkRef=(ref:EntityRefDraft):void=>{const kind=contract.vertex.find(kind=>kind.name===ref.kind);if(!kind)throw new Error(`${WHERE}:196: UNKNOWN_KIND ${ref.kind}`);checkFields(kind,ref.key);for(const parent of Object.values(ref.keyEdges??{}))checkRef(parent);};
 for(const draft of drafts.vertices){try{checkRef(draft);const kind=contract.vertex.find(kind=>kind.name===draft.kind)!;checkFields(kind,draft.values??{});
  const binding=requireWriteCapability(executor);permitted(binding,draft.kind,'$exists');
  for(const name of kind.key)permitted(binding,draft.kind,name);
  for(const name of Object.keys(draft.values??{}))permitted(binding,draft.kind,name);
  for(const evidence of draft.evidence??[])validateEvidenceLocator(evidence.locator??{});
  for(const value of Object.values(draft.values??{}))scanMentions(value,'/values');
 }catch(error){if(error instanceof Error){error.message+=`; subject ${draft.kind} ${draft.uid??canonicalJson(draft.key)}`;throw error;}throw error;}}
 for(const draft of drafts.edges??[]){const kind=contract.edge.find(kind=>kind.name===draft.kind);if(!kind)throw new Error(`${WHERE}:198: UNKNOWN_EDGE ${draft.kind}`);checkRef(draft.from);checkRef(draft.to);checkFields(kind,draft.values??{});}
 let written=await publishBatch(executor,prepared,drafts,context);
 for(const draft of drafts.removals){if(await removeEntity(executor,contract,draft,context))written++;}
 for(const draft of drafts.edgeRemovals??[]){const from=await endpoint(executor,contract,draft.from,context);const to=await endpoint(executor,contract,draft.to,context);const edge=(await executor.query<{id:string}>(`SELECT e.id::text AS id FROM edge e JOIN entity k ON k.id=e.entity_id WHERE k.name=$1 AND e.from_node=$2::bigint AND e.to_node=$3::bigint AND e.discriminator=$4 AND e.context_id=$5`,[draft.kind,from.id,to.id,draft.discriminator??'',context])).rows[0];if(edge&&await withdrawEdge(executor,contract,draft.kind,edge.id,draft.producer,undefined,context))written++;}
 return written;
 });
}
async function retractPropertyStreams(executor:SqlExecutor,contract:GraphContract,sort:'vertex'|'edge',kind:string,subjectId:string,property:string,context:number):Promise<void>{
 const binding=requireWriteCapability(executor);
 const association=sort==='vertex'?'JOIN assertion_vertex_subject subject ON subject.assertion_id=a.assertion_id JOIN edge attachment ON attachment.id=subject.subject_edge_id':'JOIN assertion_edge_subject subject ON subject.assertion_id=a.assertion_id';
 const subject=sort==='vertex'?'attachment.to_node':'subject.edge_id';
 const languages=(await executor.query<{language:string|null}>(`SELECT DISTINCT a.language FROM assertion a ${association} JOIN edge source ON source.from_node=a.assertion_id JOIN entity k ON k.id=source.entity_id AND k.name='system.assertion-source' JOIN node principal ON principal.id=source.to_node WHERE ${subject}=$1::bigint AND a.property=$2 AND principal.uid=$3::uuid AND a.context_id=$4`,[subjectId,property,binding.sourceUid,context])).rows;
 await admitAssertionInputs(executor,contract,(languages.length?languages:[{language:null}]).map(({language})=>({sort,kind,subjectId,property,operation:'retract',language})),context);
}
export async function removeEntity(executor:SqlExecutor,declared:GraphContract,draft:VertexRemovalDraft,context=1):Promise<boolean>{
 return await withSpan('graph.vertex.retract',{},async()=>{
 const contract=withAssertionContract(declared);
 if(draft.withdrawAll)throw new Error(`${WHERE}:190: GLOBAL_REMOVAL_REQUIRES_AUTHORIZED_OPERATION`);
 const subject=await endpoint(executor,contract,draft,context);
 const retire=async(kindName:string,id:string,visited:Set<string>):Promise<void>=>{
  if(visited.has(id))return;visited.add(id);
  for(const childKind of contract.vertex)for(const role of childKind.keyEdges??[]){
    const children=(await executor.query<{id:string}>(`SELECT child.id::text AS id FROM edge e JOIN entity ek ON ek.id=e.entity_id JOIN node child ON child.id=e.${role.direction==='from'?'from':'to'}_node JOIN entity ck ON ck.id=child.entity_id WHERE ek.name=$1 AND e.${role.direction==='from'?'to':'from'}_node=$2::bigint AND ck.name=$3 AND graph_edge_active(e.id,ek.name,$4::bigint) AND graph_vertex_active(child.id,ck.name,$4::bigint)`,[role.edge,id,childKind.name,context])).rows;
   if(children.length&&role.onDelete==='restrict')throw new Error(`${WHERE}:199: PARENT_DELETE_RESTRICTED ${childKind.name}.${role.role}`);
   for(const child of children)await retire(childKind.name,child.id,visited);
  }
  permitted(requireWriteCapability(executor),kindName,'$exists',true);
  const incident=(await executor.query<{id:string;kind:string}>(`SELECT e.id::text AS id,k.name AS kind FROM edge e JOIN entity k ON k.id=e.entity_id WHERE (e.from_node=$1::bigint OR e.to_node=$1::bigint) AND graph_edge_active(e.id,k.name,$2::bigint)`,[id,context])).rows;
  for(const edge of incident)await withdrawEdge(executor,contract,edge.kind,edge.id,'',undefined,context);
  const retiredKind=contract.vertex.find(vertex=>vertex.name===kindName)!;
  for(const property of [...retiredKind.fields.filter(field=>!retiredKind.key.includes(field.name)).map(field=>field.name),'$exists'])await retractPropertyStreams(executor,contract,'vertex',kindName,id,property,context);
 };
 if(draft.selectedFields!==undefined){for(const property of draft.selectedFields)await writeAssertion(executor,contract,{sort:'vertex',kind:draft.kind,subjectId:subject.id,property,operation:'retract'},context);}
 else await retire(draft.kind,subject.id,new Set());
 return true;
 });
}
export async function withdrawEdge(executor:SqlExecutor,contract:GraphContract,kind:string,edgeId:string,_producer:string,_journal?:unknown,context=1):Promise<boolean>{
 for(const property of [ ...(contract.edge.find(edge=>edge.name===kind)?.fields.map(field=>field.name)??[]),'$exists'])await retractPropertyStreams(executor,contract,'edge',kind,edgeId,property,context);return true;
}
