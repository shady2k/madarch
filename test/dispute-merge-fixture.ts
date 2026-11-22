import { SQL_TRANSACTION_KINDS } from '../src/sql-driver.js';
import {createTestDatabaseOwner} from './test-database.js';
import {generatedTableName,type GraphContract} from '../src/graph/contract.js';
import {withAssertionContract} from '../src/graph/system-contract.js';
import {publishGraphDrafts} from '../src/graph/write.js';
import {bindGraphProducer,activateGraphProducer,type ProducerBinding} from '../src/graph/producer-binding.js';
import {registerSystemSource} from '../src/graph/system-installation.js';
import {startupBinding} from '../src/graph/manifest-publication.js';
import {readKindAssertions} from '../src/graph/records.js';
export const productContract:GraphContract={vertex:['sample','other'].map(name=>({name,table:generatedTableName(name,'vertex'),key:['name'],capability:'fixture',fields:[{name:'name',type:'text' as const},{name:'synonyms',type:'json' as const,schema:{$schema:'https://json-schema.org/draft/2020-12/schema',type:'array',items:{type:'string'}}},{name:'note',type:'text' as const,nullable:true}]})),edge:['related','shared'].map(name=>({name,from:['sample'],to:['other'],repeats:false,cardinality:{from:'many',to:name==='related'?'one':'many'},labels:{en:{out:'related',in:'related'},ru:{out:'related',in:'related'}},fields:[],capability:'fixture'})),dictionary:[]};
export const contract:GraphContract=withAssertionContract(productContract);
export async function fixture(declared:GraphContract=contract){
 const contract=declared;
 const owner=await createTestDatabaseOwner({graphContract:contract});
 const scope=await owner.transaction(SQL_TRANSACTION_KINDS.write,async tx=>(await startupBinding(tx,contract,'fixture')).binding.productUid);
 const writer=await registerSystemSource(owner,contract,{type:'plugin',installationKey:'writer',scope,version:'1'});
 const resolver=await registerSystemSource(owner,contract,{type:'plugin',installationKey:'resolver',scope,version:'1'});
 const grants=(principal:typeof writer.principal,merge=false)=>bindGraphProducer(owner,contract,{principal,vertices:{sample:['synonyms','note'],other:['synonyms','note'],'system.content-snapshot':['content','digest'],...(contract.vertex.some(kind=>kind.name==='child')?{child:[]}: {})},edges:{related:[],shared:[],...(contract.edge.some(kind=>kind.name==='child-parent')?{'child-parent':[]}: {})},actions:merge?['assert','merge','retract-own']:['assert','retract-own']});
 const a=grants(writer.principal),r=grants(resolver.principal,true);
 const execute=async<T>(binding:ProducerBinding,apply:(tx:import('../src/sql-driver.js').SqlExecutor)=>Promise<T>)=>owner.transaction(SQL_TRANSACTION_KINDS.write,async tx=>{await activateGraphProducer(tx,contract,binding);return apply(tx);});
 const {createHash}=await import('node:crypto');const actual=createHash('sha256').update('Evidence').digest('hex');
 await execute(a,tx=>publishGraphDrafts(tx,contract,{vertices:[{kind:'system.content-snapshot',key:{digest:actual},values:{content:'Evidence'},producer:'fixture',producerVersion:'1'},...['one','two'].map(name=>({kind:'sample',key:{name},values:{synonyms:['shared'],note:name},producer:'fixture',producerVersion:'1'})),{kind:'other',key:{name:'parent'},values:{synonyms:[]},producer:'fixture',producerVersion:'1'}],edges:['related','shared'].flatMap(kind=>['one','two'].map(name=>({kind,from:{kind:'sample',key:{name}},to:{kind:'other',key:{name:'parent'}},producer:'fixture',producerVersion:'1'}))),removals:[]}));
 const rows=await owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'vertex','sample',['name','note','synonyms'],{contract}));
 const input={members:rows.map(row=>({kind:'sample',key:{},uid:row.uid})) as unknown as readonly [import('../src/graph/contract.js').EntityRefDraft,import('../src/graph/contract.js').EntityRefDraft],signals:{kind:'sample',name:'name',synonyms:'synonyms',edges:['related','shared']},decision:'sure' as const,reason:'Same entity checked',evidence:[{target:{kind:'system.content-snapshot',key:{digest:actual}}}]};
 return {owner,a,r,resolver,execute,rows,input};
}
