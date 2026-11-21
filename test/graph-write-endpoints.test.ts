/** ALX-930: endpoint lookup work and the un-deduplicated scope input. */
import {expect, test} from 'bun:test';
import {generatedTableName, type GraphContract, type EdgeDraft} from '../src/graph/contract.js';
import {bindWriteCapability, publishGraphDrafts} from '../src/graph/write.js';
import {createTestDatabaseOwner} from './test-database.js';
import {bindTestWriteCapability} from './write-capability-fixture.js';

const labels={en:{out:'to',in:'from'},ru:{out:'to',in:'from'}};
const contract:GraphContract={vertex:[
 {name:'endpoint.root',table:generatedTableName('endpoint.root','vertex'),key:['name'],fields:[{name:'name',type:'text'}],capability:'fixture'},
 {name:'endpoint.child',table:generatedTableName('endpoint.child','vertex'),key:['name'],keyEdges:[{role:'root',edge:'endpoint.parent',direction:'from',onDelete:'restrict'}],fields:[{name:'name',type:'text'}],capability:'fixture'},
],edge:[
 {name:'endpoint.parent',from:['endpoint.child'],to:['endpoint.root'],fields:[],repeats:false,cardinality:{from:'many',to:'one'},labels,capability:'fixture'},
 {name:'endpoint.link',from:['endpoint.child'],to:['endpoint.child'],fields:[{name:'weight',type:'integer'}],repeats:true,discriminator:'place',cardinality:{from:'many',to:'many'},labels,capability:'fixture'},
],dictionary:[]};
const producer={producer:'fixture',producerVersion:'1'};
const root={kind:'endpoint.root',key:{name:'root'}};
const children=['a','b'].map(name=>({kind:'endpoint.child',key:{name},keyEdges:{root}}));
function counts(ids:string[]){const result=new Map<string,number>();for(const id of ids)result.set(id,(result.get(id)??0)+1);return [...result].sort(([a],[b])=>a<b?-1:a>b?1:0);}

async function measure(size:number){
 // Execute the real scope statement, then roll back this partial publication.
 // Assertion insertion is outside this endpoint-search regression's scope.
 const scopeChecked=new Error('scope captured');
 const owner=await createTestDatabaseOwner({graphContract:contract,authenticated:false});
 try{return await owner.transaction('write',async tx=>{
  const binding=await bindTestWriteCapability(tx,contract);
  await publishGraphDrafts(tx,contract,{vertices:[{...root,...producer}],removals:[]});
  const scope=(await tx.query<{uid:string}>("SELECT n.uid::text FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='endpoint.root'")).rows[0]!.uid;
  bindWriteCapability(tx,{...binding,scope});
  // Each uid occurs twice. Each draft makes two plans. Losing duplicate
  // inputs in the index therefore loses half the endpoint multiplicity.
  const edges:EdgeDraft[]=Array.from({length:size},(_,i)=>({kind:'endpoint.link',from:children[i%2]!,to:children[(i+1)%2]!,discriminator:String(Math.floor(i/4)),values:{weight:i},...producer}));
  let inputs:{uid:string;from:string;to:string}[]=[],edgeIds=new Map<string,string>(),nodeIds:string[]=[];
  let subjectNodes:string[]|undefined,scopeParameter:string[]|undefined,comparisons=0;
  const query=tx.query.bind(tx),get=Map.prototype.get,flatMap=Array.prototype.flatMap;
  const restore=()=>{Map.prototype.get=get;Array.prototype.flatMap=flatMap;};
  tx.query=async<Row extends object = Record<string,unknown>>(sql:string,values?:readonly unknown[])=>{
   if(sql.startsWith('INSERT INTO edge(uid,entity_id'))inputs=JSON.parse(values![0] as string);
   if(sql.includes('WITH RECURSIVE members(subject,id)')){
    scopeParameter=[...(values![3] as string[])];restore();tx.query=query;
   }
   const result=await query<Row>(sql,values);
   if(sql.includes('WITH RECURSIVE members(subject,id)'))throw scopeChecked;
   if(sql.includes('ORDER BY n.id FOR UPDATE OF n'))nodeIds=result.rows.map(row=>String((row as {id:string}).id));
   if(sql.startsWith('SELECT id::text,uid::text FROM edge WHERE uid=ANY')){
    edgeIds=new Map(result.rows.map(row=>[String((row as {uid:string}).uid),String((row as {id:string}).id)]));
    const uids=new Set(inputs.map(edge=>edge.uid));
    // One Map.get is one uid equality probe in H's filter predicate. Count
    // every endpoint uid probe in the phase, including plan id assignment.
    Map.prototype.get=function(this:Map<unknown,unknown>,key:unknown){if(typeof key==='string'&&uids.has(key))comparisons++;return get.call(this,key);};
    Array.prototype.flatMap=function<U,This=undefined>(this:unknown[],callback:(this:This,value:unknown,index:number,array:unknown[])=>U|readonly U[],thisArg?:This):U[]{
     const result=flatMap.call(this,(value:unknown,index:number,array:unknown[])=>callback.call(thisArg as This,value,index,array)) as U[];
     if(this.length>0&&this.every(item=>typeof item==='object'&&item!==null&&'subjectId' in item)&&result.every(item=>typeof item==='string'))subjectNodes=result as string[];
     return result;
    };
   }
   return result;
  };
  await tx.query('SAVEPOINT endpoint_measure');
  try{await publishGraphDrafts(tx,contract,{vertices:children.map(child=>({...child,...producer})),edges,removals:[]});}
  catch(error){if(error!==scopeChecked)throw error;}
  finally{restore();tx.query=query;await tx.query('ROLLBACK TO SAVEPOINT endpoint_measure');}
  // Rebuild H's exact plan order: two vertex properties then its parent
  // edge, followed by two properties for each explicit edge draft.
  const plans=nodeIds.flatMap(id=>[{sort:'vertex',subjectId:id},{sort:'vertex',subjectId:id},{sort:'edge',subjectId:edgeIds.get(inputs[nodeIds.indexOf(id)]!.uid)!}]);
  for(const edge of inputs.slice(children.length))for(let property=0;property<2;property++)plans.push({sort:'edge',subjectId:edgeIds.get(edge.uid)!});
  const expected=plans.flatMap(plan=>plan.sort==='vertex'?[plan.subjectId]:inputs.filter(edge=>edgeIds.get(edge.uid)===plan.subjectId).flatMap(edge=>[edge.from,edge.to]));
  const evidence={size,edgeInputs:inputs.length,edgePlans:plans.length-2*children.length,comparisons,subjectCount:subjectNodes?.length,counts:counts(expected),scopeParameter};
  console.log('ALX-930',JSON.stringify(evidence));
  return {comparisons,bound:4*(inputs.length+plans.length),subjectNodes,expected,scopeParameter};
 });}finally{await owner.close();}
}

for(const size of [500,4000]){
 test(`ALX-930: endpoint comparison count is linear and the multiset matches H at ${size} edges`,async()=>{
  const result=await measure(size);
  expect(result.subjectNodes).toEqual(result.expected);
  expect(counts(result.subjectNodes!)).toEqual(counts(result.expected));
  // checkBatchScope already deduplicates: test its actual public SQL input
  // separately, not as a substitute for the full multiset above.
  expect(result.scopeParameter).toEqual([...new Set(result.expected)]);
  expect(result.comparisons).toBeLessThanOrEqual(result.bound);
 },120000);
}
