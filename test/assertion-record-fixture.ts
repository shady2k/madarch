/** Minimal declared repository graph used by record reads (0039 items 1, 25, 30). */
import { generatedTableName,type GraphContract,type EdgeContract } from '../src/graph/contract.js';
import { GIT_KINDS } from '../src/fill/stages/git-contract.js';
const vertex=(name:string,key:string[],fields:readonly [string,'text'|'integer'|'bigint'|'boolean'|'timestamp'|'json'][]=[])=>({name,table:generatedTableName(name,'vertex'),key,fields:[...key.map(name=>({name,type:'text' as const})),...fields.map(([name,type])=>({name,type,nullable:true,...(type==='json'?{schema:{$schema:'https://json-schema.org/draft/2020-12/schema',type:'array',items:{type:'string'}}}:{})}))],capability:'fixture'});
const edge=(name:string,from:string,to:string,fields:readonly [string,'integer'][]=[]):EdgeContract=>({name,from:[from],to:[to],repeats:false,cardinality:{from:'many',to:'many'},labels:{en:{out:'links to',in:'linked from'},ru:{out:'ссылается',in:'ссылка из'}},fields:fields.map(([name,type])=>({name,type,nullable:true})),capability:'fixture'});
const recordKinds:GraphContract={vertex:[
 vertex(GIT_KINDS.repository,['name'],[['tree_snapshot','text'],['url','text'],['default_branch','text'],['history_shallow','boolean']]),
 vertex(GIT_KINDS.file,['path'],[['mode','text'],['blob','text'],['bytes','bigint'],['form','text'],['lines','integer'],['content','text'],['language','text'],['languages','json'],['class','text']]),
 vertex(GIT_KINDS.directory,['path']),
 vertex(GIT_KINDS.commit,['hash'],[['subject','text'],['author_date','timestamp'],['author_offset_min','integer'],['commit_date','timestamp'],['commit_offset_min','integer']]),
 vertex(GIT_KINDS.signature,['name','email']),
],edge:[edge(GIT_KINDS.contains,GIT_KINDS.repository,GIT_KINDS.file),edge(GIT_KINDS.history,GIT_KINDS.repository,GIT_KINDS.commit,[['walk','integer']]),edge(GIT_KINDS.asIs,GIT_KINDS.repository,GIT_KINDS.commit),edge(GIT_KINDS.parent,GIT_KINDS.commit,GIT_KINDS.commit,[['position','integer']]),edge(GIT_KINDS.authored,GIT_KINDS.signature,GIT_KINDS.commit),edge(GIT_KINDS.renamedFrom,GIT_KINDS.file,GIT_KINDS.file),edge(GIT_KINDS.touched,GIT_KINDS.commit,GIT_KINDS.file)],dictionary:[]};
export const repoRef=(name='shop')=>({kind:GIT_KINDS.repository,key:{name}});
export const fileRef=(path:string)=>({kind:GIT_KINDS.file,key:{path}});
export const commitRef=(hash:string)=>({kind:GIT_KINDS.commit,key:{hash}});
export const fixtureProducer={producer:'fixture',producerVersion:'1'};

import {withManifestContract} from '../src/graph/manifest-contract.js';
export const recordGraph=withManifestContract(recordKinds);
import {publishGraphDrafts} from '../src/graph/write.js';
import {createTestDatabaseOwner} from './test-database.js';
export async function createRecordOwner(options:{readonly parentPositionFieldType?:'integer'|'text'}={}){
 const contract=options.parentPositionFieldType===undefined?recordGraph:{...recordGraph,edge:recordGraph.edge.map(edge=>edge.name!==GIT_KINDS.parent?edge:{...edge,fields:edge.fields.map(field=>field.name==='position'?{...field,type:options.parentPositionFieldType!}:field)})};
 const owner=await createTestDatabaseOwner({graphContract:contract});
 const fields=(names:string[])=>Object.fromEntries(names.map(name=>[name,name]));
 const edge=(kind:string,direction:'from'|'to',mapped:Record<string,string>={})=>({kind,direction,fields:mapped,line:1});
 const semanticBindings={$map:[
 ['repository',{kind:GIT_KINDS.repository,line:1,fields:fields(['name','url','default_branch','history_shallow','tree_snapshot']),edges:{contains:edge(GIT_KINDS.contains,'from'),asIs:edge(GIT_KINDS.asIs,'from'),history:edge(GIT_KINDS.history,'from',{walk:'walk'})}}],
 ['file',{kind:GIT_KINDS.file,line:1,fields:fields(['path','mode','blob','bytes','form','lines','language','languages','content']),values:{form:{text:'text',binary:'binary'}},edges:{repository:edge(GIT_KINDS.contains,'to'),renamedFrom:edge(GIT_KINDS.renamedFrom,'from')}}],
 ['directory',{kind:GIT_KINDS.directory,line:1,fields:{}}],
 ['commit',{kind:GIT_KINDS.commit,line:1,fields:fields(['hash','subject','author_date','author_offset_min','commit_date','commit_offset_min']),edges:{parent:edge(GIT_KINDS.parent,'from',{position:'position'}),touched:edge(GIT_KINDS.touched,'from')}}],
 ['author',{kind:GIT_KINDS.signature,line:1,fields:fields(['name','email']),edges:{authored:edge(GIT_KINDS.authored,'from')}}],
 ]};
 const declaration={file:'/fixture/catalog.yaml',semanticBindings,kinds:{$map:contract.vertex.map(v=>[v.name,{name:v.name,key:v.key,fields:v.fields}])},edges:{$map:contract.edge.map(e=>[e.name,e])}};
 await owner.transaction('write',tx=>publishGraphDrafts(tx,contract,{vertices:[{kind:'manifest.catalogue',key:{name:'product'},values:{declaration:JSON.stringify(declaration)},...fixtureProducer}],removals:[]}));
 return owner;
}
