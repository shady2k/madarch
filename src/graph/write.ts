/** The sole graph writer: immutable, typed assertions (0039 items 14,25,26,28). */
import {createHash} from 'node:crypto';
import type { SqlExecutor } from '../sql-driver.js';
import { withSpan } from '../obs/trace.js';
import { assertionValueTableName, graphContractVersion, type GraphContract, type EntityRefDraft, type VertexDraft, type VertexRemovalDraft, type EdgeDraft, type EdgeRemovalDraft, type EvidenceDraft, type FieldContract } from './contract.js';
import { withAssertionContract, isDisputableProperty } from './system-contract.js';
import { keyUid, newUid } from './uid.js';
import {validateEvidenceLocator} from './evidence-locator.js';
import { validateFieldValue,validateValueContracts } from './value-validation.js';
import { scanMentions } from './mentions.js';
import { canonicalAssertionValue } from './assertion-selection.js';
export type {EdgeDraft,EdgeRemovalDraft} from './contract.js';

const WHERE=import.meta.path;
/** Serialize graph operations before any identity or queue locks. */
export async function acquireGraphWriteLock(executor:SqlExecutor):Promise<void>{await executor.query('SELECT pg_advisory_xact_lock($1::bigint)',[739251902]);}
export interface WriteCapability {
  readonly sourceUid:string; readonly principalUid:string; readonly operationUid:string;
  readonly unitUid?:string; readonly productUid:string; readonly context:number; readonly contractVersion:string; readonly scope:string;
  readonly permissions:readonly {readonly kind:string;readonly properties:readonly string[];readonly assert:boolean;readonly retractOwn:boolean}[];
}
const bindings=new WeakMap<object,WriteCapability>();
const semanticRefreshers=new WeakMap<object,()=>Promise<void>>();
/** The host supplies the canonical semantic reader without a writer-to-reader dependency. */
export function bindSemanticRefresh(executor:SqlExecutor,refresh:()=>Promise<void>):void {semanticRefreshers.set(executor,refresh);}
export async function refreshWriteSemantics(executor:SqlExecutor):Promise<void> {await semanticRefreshers.get(executor)?.();}

const pendingEvidence=new WeakMap<object,Array<()=>Promise<void>>>();
const publicationIdentities=new WeakMap<object,{entities:Map<string,string>;nodes:Map<string,string>;uids:Map<string,string>}>();
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
 const cache=publicationIdentities.get(executor)?.entities;const key=sort+':'+kind;const held=cache?.get(key);if(held!==undefined)return held;
 const row=(await executor.query<{id:string}>(`SELECT id::text AS id FROM entity WHERE name=$1 AND sort=$2`,[kind,sort])).rows[0];
 if(!row)throw new Error(`${WHERE}:35: UNKNOWN_KIND ${kind}`);cache?.set(key,row.id);return row.id;
}
async function identity(executor:SqlExecutor,kind:string,uid:string,key:Readonly<Record<string,unknown>>,scope:string,context:number):Promise<{nodeId:string;uid:string;created:boolean;revived:boolean}>{
 const kindId=await entityId(executor,kind,'node');
 const made=await executor.query<{id:string}>(`INSERT INTO node(entity_id,uid,key,identity_scope,context_id) VALUES($1::bigint,$2::uuid,$3::jsonb,$4::uuid,$5) ON CONFLICT DO NOTHING RETURNING id::text AS id`,[kindId,uid,JSON.stringify(key),scope,context]);
 const row=(await executor.query<{id:string;kind:string;key:unknown;scope:string}>(`SELECT n.id::text AS id,k.name AS kind,n.key,n.identity_scope::text AS scope FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.uid=$1::uuid FOR UPDATE OF n`,[uid])).rows[0];
 if(!row||row.kind!==kind||!sameValue(row.key,key)||row.scope!==scope)throw new Error(`${WHERE}:42: UID_IDENTITY_CONFLICT ${uid}`);
 publicationIdentities.get(executor)?.nodes.set(row.id,uid);publicationIdentities.get(executor)?.uids.set(uid,row.id);
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
 if(isDisputableProperty('vertex',ref.kind,'$exists'))await refreshWriteSemantics(executor);
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
async function putEdge(executor:SqlExecutor,kind:string,from:string,to:string,discriminator:string,context:number):Promise<string>{
 const kindId=await entityId(executor,kind,'edge');
 const nodes=publicationIdentities.get(executor)?.nodes??new Map<string,string>();
 const missing=[...new Set([from,to])].filter(id=>!nodes.has(id));
 if(missing.length)for(const row of (await executor.query<{id:string;uid:string}>(`SELECT id::text AS id,uid::text AS uid FROM node WHERE id=ANY($1::bigint[]) ORDER BY uid`,[missing])).rows)nodes.set(row.id,row.uid);
 const uid=keyUid(keyUid('madarch.catalogue.kind',[kind]),[nodes.get(from)!,nodes.get(to)!,discriminator]);
 const made=await executor.query<{id:string}>(`INSERT INTO edge(uid,entity_id,from_node,to_node,discriminator,context_id) VALUES($1::uuid,$2::bigint,$3::bigint,$4::bigint,$5,$6) ON CONFLICT DO NOTHING RETURNING id::text AS id`,[uid,kindId,from,to,discriminator,context]);
 return made.rows[0]?.id??(await executor.query<{id:string}>(`SELECT id::text AS id FROM edge WHERE uid=$1::uuid`,[uid])).rows[0]!.id;
}
async function uidNode(executor:SqlExecutor,uid:string):Promise<string>{const cache=publicationIdentities.get(executor);const held=cache?.uids.get(uid);if(held!==undefined)return held;const row=(await executor.query<{id:string}>(`SELECT id::text AS id FROM node WHERE uid=$1::uuid`,[uid])).rows[0];if(!row)throw new Error(`${WHERE}:102: MISSING_LINEAGE_TARGET ${uid}`);cache?.uids.set(uid,row.id);cache?.nodes.set(row.id,uid);return row.id;}
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
  await refreshWriteSemantics(executor);
  const scopeNode=(await executor.query<{id:string}>(`SELECT id::text AS id FROM node WHERE uid=$1::uuid`,[binding.scope])).rows[0];
  const subjectNodes=subject.sort==='vertex'?[subject.subjectId]:(await executor.query<{from_node:string;to_node:string}>(`SELECT from_node::text,to_node::text FROM edge WHERE id=$1::bigint`,[subject.subjectId])).rows.flatMap(row=>[row.from_node,row.to_node]);
  const keyNames=contract.vertex.flatMap(vertex=>(vertex.keyEdges??[]).map(role=>({name:role.edge,direction:role.direction})));
  const scoped=scopeNode===undefined?false:(await executor.query<{allowed:boolean}>(`WITH RECURSIVE members(id) AS (SELECT $1::bigint UNION SELECT CASE WHEN role.direction='from' THEN e.from_node ELSE e.to_node END FROM members m JOIN edge e ON true JOIN entity k ON k.id=e.entity_id JOIN jsonb_to_recordset($2::jsonb) role(name text,direction text) ON role.name=k.name WHERE CASE WHEN role.direction='from' THEN e.to_node ELSE e.from_node END=m.id AND graph_edge_active(e.id,k.name,$4::bigint)) SELECT bool_and(id IN(SELECT id FROM members)) AS allowed FROM unnest($3::bigint[]) subject(id)`,[scopeNode.id,JSON.stringify(keyNames),subjectNodes,context])).rows[0]?.allowed===true;
  if(!scoped)throw new Error(`${WHERE}:128: SOURCE_FORBIDDEN assertion outside authenticated scope`);
 }
 });
}
export async function writeAssertion(executor:SqlExecutor,declared:GraphContract,input:AssertionInput,context=1):Promise<string>{
 const contract=withAssertionContract(declared);const version=checkBinding(requireWriteCapability(executor),contract,context);
 return await writeCheckedAssertion(executor,{contract,version},input,context);
}
async function writeCheckedAssertion(executor:SqlExecutor,prepared:PreparedContract,input:AssertionInput,context:number):Promise<string>{
 return await withSpan('graph.assertion.write',{'graph.kind':input.kind,'graph.property':input.property},async()=>{
 const {contract,version}=prepared;const binding=requireWriteCapability(executor);checkBindingRevision(binding,version,context);permitted(binding,input.kind,input.property,input.operation==='retract');
 const kind=contract[input.sort].find(k=>k.name===input.kind);if(!kind)throw new Error(`${WHERE}:114: UNKNOWN_KIND ${input.kind}`);
 const subject=(await executor.query<{kind:string}>(`SELECT k.name AS kind FROM ${input.sort==='vertex'?'node':'edge'} s JOIN entity k ON k.id=s.entity_id WHERE s.id=$1::bigint FOR UPDATE OF s`,[input.subjectId])).rows[0];
 if(subject?.kind!==input.kind)throw new Error(`${WHERE}:114: END_KIND_INVALID assertion subject ${input.subjectId}`);
 await requireAssertionScope(executor,contract,binding,{sort:input.sort,subjectId:input.subjectId},context);
 const field:FieldContract|undefined=input.property==='$exists'?{name:'$exists',type:'boolean' as const}:kind.fields.find(f=>f.name===input.property);
 if(!field)throw new Error(`${WHERE}:116: UNKNOWN_PROPERTY ${input.kind}.${input.property}`);
 if(input.sort==='vertex'&&'key' in kind&&kind.key.includes(input.property)){
  const held=(await executor.query<{key:Record<string,unknown>}>(`SELECT key FROM node WHERE id=$1::bigint`,[input.subjectId])).rows[0]!;
  if(input.operation!=='assert'||input.language!=null||!sameValue(held.key[input.property],input.value))throw new Error(`${WHERE}:165: IMMUTABLE_KEY ${input.kind}.${input.property}: identity changes require a new UID`);
 }
 if(input.operation==='assert'){validate(field,input.value);validateFieldValue(contract,field,input.value);}else if(input.value!==undefined)throw new Error(`${WHERE}:117: RETRACTION_VALUE`);
 if(input.sort==='vertex'&&'evidence' in kind&&kind.evidence?.immutable){
  if(input.operation==='retract'||(input.property==='$exists'&&input.value!==true))throw new Error(`${WHERE}:128: IMMUTABLE_EVIDENCE immutable support cannot be retired`);
  const held=(await executor.query<{value:unknown}>(`SELECT v.value FROM "${assertionValueTableName(input.kind,'vertex',input.property)}" v JOIN assertion_vertex_subject subject ON subject.assertion_id=v.assertion_id JOIN edge attachment ON attachment.id=subject.subject_edge_id WHERE attachment.to_node=$1::bigint`,[input.subjectId])).rows;
  if(held.some(row=>!sameValue(row.value,input.value)))throw new Error(`${WHERE}:130: IMMUTABLE_EVIDENCE support values cannot change`);
  if(input.property===kind.evidence.contentField&&input.value!==null&&kind.evidence.digestField){const node=(await executor.query<{key:Record<string,unknown>}>(`SELECT key FROM node WHERE id=$1::bigint`,[input.subjectId])).rows[0]!;if(createHash('sha256').update(String(input.value),'utf8').digest('hex')!==node.key[kind.evidence.digestField])throw new Error(`${WHERE}:131: EVIDENCE_INVALID snapshot content contradicts digest`);}
 }

 const mentions=input.operation==='assert'?scanMentions(input.value,`/values/${input.property.split('~').join('~0').split('/').join('~1')}`):[];
 if(mentions.length>0)await refreshWriteSemantics(executor);
 for(const mention of mentions){const endpointNode=(await executor.query<{id:string;kind:string}>(`SELECT n.id::text AS id,k.name AS kind FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.uid=$1::uuid`,[mention.uid])).rows[0];if(!endpointNode||!(await executor.query<{active:boolean}>(`SELECT graph_vertex_active($1::bigint,$2,$3::bigint) AS active`,[endpointNode.id,endpointNode.kind,context])).rows[0]?.active)throw new Error(`${WHERE}:120: TARGET_MISSING ${mention.path} ${mention.uid}`);}
 const uid=newUid();const made=await identity(executor,'system.assertion',uid,{},binding.productUid,context);
 await executor.query(`INSERT INTO assertion(assertion_id,property,language,context_id,valid_from,valid_to,operation) VALUES($1::bigint,$2,$3,$4,coalesce($5::timestamptz,clock_timestamp()),$6::timestamptz,$7)`,[made.nodeId,input.property,input.language??null,context,input.validFrom??null,input.validTo??null,input.operation]);
 if(input.sort==='vertex'){const edgeId=await putEdge(executor,'system.assertion-subject',made.nodeId,input.subjectId,'',context);await executor.query(`INSERT INTO assertion_vertex_subject(assertion_id,subject_edge_id) VALUES($1::bigint,$2::bigint)`,[made.nodeId,edgeId]);}
 else await executor.query(`INSERT INTO assertion_edge_subject(assertion_id,edge_id) VALUES($1::bigint,$2::bigint)`,[made.nodeId,input.subjectId]);
 for(const [relation,lineageUid] of [['source',binding.sourceUid],['author',binding.principalUid],['operation',binding.operationUid],...(binding.unitUid?[['unit',binding.unitUid]]:[])])await putEdge(executor,`system.assertion-${relation}`,made.nodeId,await uidNode(executor,lineageUid!),'',context);
 if(input.operation==='assert')await executor.query(`INSERT INTO "${assertionValueTableName(input.kind,input.sort,input.property)}"(assertion_id,value) VALUES($1::bigint,$2${field.type==='json'?'::jsonb':''})`,[made.nodeId,field.type==='json'?JSON.stringify(input.value):input.value]);
 for(const [index,evidence] of (input.evidence??[]).entries()){
   const locator=evidence.locator??{};
   validateEvidenceLocator(locator);
   const attach=async()=>{const evidenceKind=contract.vertex.find(vertex=>vertex.name===evidence.target.kind);if(!evidenceKind?.evidence?.immutable)throw new Error(`${WHERE}:151: EVIDENCE_INVALID target must declare immutable evidence support`);const endpointNode=await endpoint(executor,contract,evidence.target as EntityRefDraft,context);
    if(evidenceKind.evidence.contentField){const row=(await executor.query<{value:string}>(`SELECT v.value FROM "${assertionValueTableName(evidenceKind.name,'vertex',evidenceKind.evidence.contentField)}" v JOIN assertion a ON a.assertion_id=v.assertion_id JOIN assertion_vertex_subject subject ON subject.assertion_id=a.assertion_id JOIN edge attachment ON attachment.id=subject.subject_edge_id WHERE attachment.to_node=$1::bigint ORDER BY a.recorded_sequence DESC LIMIT 1`,[endpointNode.id])).rows[0];
     if(row&&row.value!==null){const points=[...row.value];const lines=row.value.split('\n');if((typeof locator.end==='number'&&locator.end>points.length)||(typeof locator.lineEnd==='number'&&locator.lineEnd>lines.length))throw new Error(`${WHERE}:154: EVIDENCE_INVALID locator outside immutable content`);if(typeof locator.digest==='string'&&createHash('sha256').update(row.value,'utf8').digest('hex')!==locator.digest)throw new Error(`${WHERE}:154: EVIDENCE_INVALID locator digest contradicts immutable content`);}
    }
    await putEdge(executor,'system.assertion-evidence',made.nodeId,endpointNode.id,canonicalJson({index,relation:evidence.relation??'supports',locator}),context);};
   const deferred=pendingEvidence.get(executor);if(deferred)deferred.push(attach);else await attach();
 }
 for(const mention of mentions)await putEdge(executor,'system.assertion-mentions',made.nodeId,await uidNode(executor,mention.uid),JSON.stringify({path:mention.path,start:mention.start,end:mention.end}),context);
 return uid;
 });
}
export interface GraphDrafts {readonly vertices:readonly VertexDraft[];readonly removals:readonly VertexRemovalDraft[];readonly edges?:readonly EdgeDraft[];readonly edgeRemovals?:readonly EdgeRemovalDraft[]}
export async function publishGraphDrafts(executor:SqlExecutor,declared:GraphContract,drafts:GraphDrafts,context=1,_options:Record<string,unknown>={}):Promise<number>{
 return await withSpan('graph.publish',{},async()=>{
 const prepared=preparePublicationContract(declared);const {contract}=prepared;checkBindingRevision(requireWriteCapability(executor),prepared.version,context);
 const checkFields=(kind:{readonly name:string;readonly fields:readonly FieldContract[]},values:Readonly<Record<string,unknown>>):void=>{
  for(const [name,value] of Object.entries(values)){const field=kind.fields.find(field=>field.name===name);if(!field)throw new Error(`${WHERE}:193: UNKNOWN_FIELD ${kind.name}.${name}`);validate(field,value);validateFieldValue(contract,field,value);}
 };
 const checkRef=(ref:EntityRefDraft):void=>{const kind=contract.vertex.find(kind=>kind.name===ref.kind);if(!kind)throw new Error(`${WHERE}:196: UNKNOWN_KIND ${ref.kind}`);checkFields(kind,ref.key);for(const parent of Object.values(ref.keyEdges??{}))checkRef(parent);};
 for(const draft of drafts.vertices){checkRef(draft);checkFields(contract.vertex.find(kind=>kind.name===draft.kind)!,draft.values??{});}
 for(const draft of drafts.edges??[]){const kind=contract.edge.find(kind=>kind.name===draft.kind);if(!kind)throw new Error(`${WHERE}:198: UNKNOWN_EDGE ${draft.kind}`);checkRef(draft.from);checkRef(draft.to);checkFields(kind,draft.values??{});}
 await acquireGraphWriteLock(executor);let written=0;
 const inheritedIdentities=publicationIdentities.has(executor);if(!inheritedIdentities)publicationIdentities.set(executor,{entities:new Map(),nodes:new Map(),uids:new Map()});
 const inheritedEvidence=pendingEvidence.get(executor);const evidenceQueue=inheritedEvidence??[];if(!inheritedEvidence)pendingEvidence.set(executor,evidenceQueue);
 try{
 const pending=[...drafts.vertices];
 while(pending.length){let progressed=false;for(let i=0;i<pending.length;){const draft=pending[i]!;const kind=contract.vertex.find(k=>k.name===draft.kind);if(!kind)throw new Error(`${WHERE}:145: UNKNOWN_KIND ${draft.kind}`);
 let ready=true;for(const parent of Object.values(draft.keyEdges??{})){const uid=await refUid(executor,contract,parent,context);if(!(await executor.query(`SELECT id FROM node WHERE uid=$1::uuid`,[uid])).rows.length)ready=false;}
 if(!ready){i++;continue;}
 const made=await ensureCheckedVertex(executor,prepared,draft,context);
 await writeCheckedAssertion(executor,prepared,{sort:'vertex',kind:draft.kind,subjectId:made.nodeId,property:'$exists',operation:'assert',value:true,evidence:draft.evidence,validFrom:draft.validFrom,validTo:draft.validTo},context);written++;
 for(const name of kind.key){await writeCheckedAssertion(executor,prepared,{sort:'vertex',kind:draft.kind,subjectId:made.nodeId,property:name,operation:'assert',value:draft.key[name],evidence:draft.evidence,validFrom:draft.validFrom,validTo:draft.validTo},context);written++;}
 for(const [name,value] of Object.entries(draft.values??{})){await writeCheckedAssertion(executor,prepared,{sort:'vertex',kind:draft.kind,subjectId:made.nodeId,property:name,operation:'assert',value,language:draft.lang,evidence:draft.evidence,validFrom:draft.validFrom,validTo:draft.validTo},context);written++;}
 for(const role of kind.keyEdges??[]){const parent=await endpoint(executor,contract,draft.keyEdges![role.role]!,context);const from=role.direction==='from'?made.nodeId:parent.id;const to=role.direction==='from'?parent.id:made.nodeId;const edgeId=await putEdge(executor,role.edge,from,to,'',context);await writeCheckedAssertion(executor,prepared,{sort:'edge',kind:role.edge,subjectId:edgeId,property:'$exists',operation:'assert',value:true,evidence:draft.evidence,validFrom:draft.validFrom,validTo:draft.validTo},context);}
 pending.splice(i,1);progressed=true;}
 if(!progressed)throw new Error(`${WHERE}:155: REQUIRED_PARENT: missing parent or instance cycle`);}
 for(const draft of drafts.edges??[]){const kind=contract.edge.find(k=>k.name===draft.kind);if(!kind)throw new Error(`${WHERE}:157: UNKNOWN_EDGE ${draft.kind}`);if(!kind.from.includes(draft.from.kind)||!kind.to.includes(draft.to.kind))throw new Error(`${WHERE}:158: ENDPOINT_KIND ${draft.kind}`);
 const from=await endpoint(executor,contract,draft.from,context);const to=await endpoint(executor,contract,draft.to,context);
 const edgeId=await putEdge(executor,draft.kind,from.id,to.id,draft.discriminator??'',context);
 await writeCheckedAssertion(executor,prepared,{sort:'edge',kind:draft.kind,subjectId:edgeId,property:'$exists',operation:'assert',value:true,evidence:draft.evidence,validFrom:draft.validFrom,validTo:draft.validTo},context);written++;
 for(const [name,value] of Object.entries(draft.values??{})){await writeCheckedAssertion(executor,prepared,{sort:'edge',kind:draft.kind,subjectId:edgeId,property:name,operation:'assert',value,language:draft.lang,evidence:draft.evidence,validFrom:draft.validFrom,validTo:draft.validTo},context);written++;}}
 for(const draft of drafts.removals){if(await removeEntity(executor,contract,draft,context))written++;}
 for(const draft of drafts.edgeRemovals??[]){const from=await endpoint(executor,contract,draft.from,context);const to=await endpoint(executor,contract,draft.to,context);const edge=(await executor.query<{id:string}>(`SELECT e.id::text AS id FROM edge e JOIN entity k ON k.id=e.entity_id WHERE k.name=$1 AND e.from_node=$2::bigint AND e.to_node=$3::bigint AND e.discriminator=$4 AND e.context_id=$5`,[draft.kind,from.id,to.id,draft.discriminator??'',context])).rows[0];if(edge&&await withdrawEdge(executor,contract,draft.kind,edge.id,draft.producer,undefined,context))written++;}
 if(!inheritedEvidence)for(const attach of evidenceQueue)await attach();
 return written;
 }finally{if(!inheritedEvidence)pendingEvidence.delete(executor);if(!inheritedIdentities)publicationIdentities.delete(executor);}
 });
}
async function retractPropertyStreams(executor:SqlExecutor,contract:GraphContract,sort:'vertex'|'edge',kind:string,subjectId:string,property:string,context:number):Promise<void>{
 const binding=requireWriteCapability(executor);
 const association=sort==='vertex'?'JOIN assertion_vertex_subject subject ON subject.assertion_id=a.assertion_id JOIN edge attachment ON attachment.id=subject.subject_edge_id':'JOIN assertion_edge_subject subject ON subject.assertion_id=a.assertion_id';
 const subject=sort==='vertex'?'attachment.to_node':'subject.edge_id';
 const languages=(await executor.query<{language:string|null}>(`SELECT DISTINCT a.language FROM assertion a ${association} JOIN edge source ON source.from_node=a.assertion_id JOIN entity k ON k.id=source.entity_id AND k.name='system.assertion-source' JOIN node principal ON principal.id=source.to_node WHERE ${subject}=$1::bigint AND a.property=$2 AND principal.uid=$3::uuid AND a.context_id=$4`,[subjectId,property,binding.sourceUid,context])).rows;
 for(const language of languages.length?languages:[{language:null}])await writeAssertion(executor,contract,{sort,kind,subjectId,property,operation:'retract',...(language.language===null?{}:{language:language.language})},context);
}
export async function removeEntity(executor:SqlExecutor,declared:GraphContract,draft:VertexRemovalDraft,context=1):Promise<boolean>{
 return await withSpan('graph.vertex.retract',{},async()=>{
 const contract=withAssertionContract(declared);
 if(draft.withdrawAll)throw new Error(`${WHERE}:190: GLOBAL_REMOVAL_REQUIRES_AUTHORIZED_OPERATION`);
 const subject=await endpoint(executor,contract,draft,context);
 const retire=async(kindName:string,id:string,visited:Set<string>):Promise<void>=>{
  if(visited.has(id))return;visited.add(id);
  for(const childKind of contract.vertex)for(const role of childKind.keyEdges??[]){
   await refreshWriteSemantics(executor);
   const children=(await executor.query<{id:string}>(`SELECT child.id::text AS id FROM edge e JOIN entity ek ON ek.id=e.entity_id JOIN node child ON child.id=e.${role.direction==='from'?'from':'to'}_node JOIN entity ck ON ck.id=child.entity_id WHERE ek.name=$1 AND e.${role.direction==='from'?'to':'from'}_node=$2::bigint AND ck.name=$3 AND graph_edge_active(e.id,ek.name,$4::bigint) AND graph_vertex_active(child.id,ck.name,$4::bigint)`,[role.edge,id,childKind.name,context])).rows;
   if(children.length&&role.onDelete==='restrict')throw new Error(`${WHERE}:199: PARENT_DELETE_RESTRICTED ${childKind.name}.${role.role}`);
   for(const child of children)await retire(childKind.name,child.id,visited);
  }
  permitted(requireWriteCapability(executor),kindName,'$exists',true);
  await refreshWriteSemantics(executor);
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
