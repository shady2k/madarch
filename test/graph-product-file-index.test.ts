import {expect,test} from 'bun:test';
import {listFiles,productFileIndex} from '../src/graph/records.js';
import {publishGraphDrafts} from '../src/graph/write.js';
import {createRecordOwner,recordGraph,repoRef,fileRef,fixtureProducer} from './assertion-record-fixture.js';
import {GIT_KINDS} from '../src/fill/stages/git-contract.js';
import {bindTestWriteCapability} from './write-capability-fixture.js';
test('0039.30: product inventory traverses only declared active edges and uses newest values under dispute',async()=>{
 const owner=await createRecordOwner();try{
 await owner.transaction('write',tx=>publishGraphDrafts(tx,recordGraph,{vertices:[{...repoRef(),...fixtureProducer},{...fileRef('a.ts'),values:{mode:'100644',bytes:20,form:'text',language:'TypeScript',languages:['TypeScript']},...fixtureProducer},{...fileRef('outside.ts'),...fixtureProducer}],edges:[{kind:GIT_KINDS.contains,from:repoRef(),to:fileRef('a.ts'),...fixtureProducer}],removals:[]}));
 await owner.transaction('write',async tx=>{await bindTestWriteCapability(tx,recordGraph,'019a0000-0000-7000-8000-000000000004');await publishGraphDrafts(tx,recordGraph,{vertices:[{...fileRef('a.ts'),values:{bytes:40,language:'JavaScript',languages:['JavaScript']},...fixtureProducer}],removals:[]});});
 expect(await productFileIndex(owner,'shop')).toEqual([{path:'a.ts',mode:'100644',blob:null,bytes:40,form:'text',lines:null,language:'JavaScript',candidates:['JavaScript']}]);
 const page=await listFiles(owner,{repository:'shop',limit:10,projection:'map'});expect(page.next).toBeNull();expect(page.rows[0]).toMatchObject({path:'a.ts',bytes:40,language:'JavaScript'});
 expect(await productFileIndex(owner,'absent')).toEqual([]);
 }finally{await owner.close();}
});
test('0039.30: filters and pagination use the same selected values as inventory',async()=>{
 const owner=await createRecordOwner();try{
 await owner.transaction('write',tx=>publishGraphDrafts(tx,recordGraph,{vertices:[{...repoRef(),...fixtureProducer},...['a.ts','b.ts','c.ts'].map(path=>({...fileRef(path),values:{language:'TypeScript'},...fixtureProducer}))],edges:['a.ts','b.ts','c.ts'].map(path=>({kind:GIT_KINDS.contains,from:repoRef(),to:fileRef(path),...fixtureProducer})),removals:[]}));
 const first=await listFiles(owner,{repository:'shop',limit:2,language:'TypeScript'});expect(first.rows.map(f=>f.path)).toEqual(['a.ts','b.ts']);expect(first.next).toBe('b.ts');
 expect((await listFiles(owner,{repository:'shop',limit:2,after:first.next!,language:'TypeScript'})).rows.map(f=>f.path)).toEqual(['c.ts']);
 expect((await listFiles(owner,{repository:'shop',limit:2,language:'JavaScript'})).rows).toEqual([]);
 await owner.transaction('write',tx=>publishGraphDrafts(tx,recordGraph,{vertices:[],removals:[{...fileRef('a.ts'),...fixtureProducer}]}));
 expect((await productFileIndex(owner,'shop')).map(f=>f.path)).toEqual(['b.ts','c.ts']);
 }finally{await owner.close();}
});


test('0039.30: inventory follows explicit semantic kind, field and reversed edge mappings',async()=>{
 const {withManifestContract}=await import('../src/graph/manifest-contract.js');
 const {generatedTableName}=await import('../src/graph/contract.js');
 const {createTestDatabaseOwner}=await import('./test-database.js');
 const actualKinds=[['code.repository','project'],['code.file','document']] as const;
 const vertices=actualKinds.map(([original,name])=>{
   const declared=recordGraph.vertex.find(kind=>kind.name===original)!;
   return {...declared,name,table:generatedTableName(name,'vertex'),key:declared.key.map(key=>'actual_'+key),fields:declared.fields.map(field=>({...field,name:'actual_'+field.name}))};
 });
 const relation={...recordGraph.edge.find(edge=>edge.name===GIT_KINDS.contains)!,name:'belongs',from:['document'],to:['project']};
 const graph=withManifestContract({vertex:vertices,edge:[relation,{...relation,name:'includes',from:['project'],to:['document']}],dictionary:[]});
 const repositoryFields=['name','url','default_branch','history_shallow','tree_snapshot'];
 const fileFields=['path','mode','blob','bytes','form','lines','content','language','languages'];
 const mappings=(names:string[])=>Object.fromEntries(names.map(name=>[name,'actual_'+name]));
 const bindings=[['repository',{kind:'project',line:7,fields:mappings(repositoryFields),edges:{contains:{kind:'belongs',direction:'to',line:9}}}],['file',{kind:'document',line:10,fields:mappings(fileFields),values:{form:{text:'plain',binary:'opaque'}}}]];
 const declaration={file:'/fixture/remapped/catalog.yaml',semanticBindings:{$map:bindings},kinds:{$map:graph.vertex.map(v=>[v.name,{name:v.name,key:v.key,fields:v.fields}])},edges:{$map:graph.edge.map(e=>[e.name,e])}};
 const owner=await createTestDatabaseOwner({graphContract:graph});
 const project={kind:'project',key:{actual_name:'shop'}},document={kind:'document',key:{actual_path:'mapped.ts'}};
 const publishDeclaration=async(value:unknown)=>await owner.transaction('write',tx=>publishGraphDrafts(tx,graph,{vertices:[{kind:'manifest.catalogue',key:{name:'product'},values:{declaration:JSON.stringify(value)},...fixtureProducer}],removals:[]}));
 try{
   await publishDeclaration(declaration);
   await owner.transaction('write',tx=>publishGraphDrafts(tx,graph,{vertices:[{...project,...fixtureProducer},{...document,values:{actual_form:'plain',actual_bytes:12,actual_language:'TypeScript'},...fixtureProducer}],edges:[{kind:'belongs',from:document,to:project,...fixtureProducer},{kind:'includes',from:project,to:document,...fixtureProducer}],removals:[]}));
   expect((await listFiles(owner,{repository:'shop',limit:10})).rows).toEqual([{path:'mapped.ts',mode:null,blob:null,bytes:12,form:'text',lines:null,language:'TypeScript',candidates:[]}]);
   const forwardBindings=[['repository',{kind:'project',line:7,fields:mappings(repositoryFields),edges:{contains:{kind:'includes',direction:'from',line:9}}}],bindings[1]];
   await publishDeclaration({...declaration,semanticBindings:{$map:forwardBindings}});
   expect((await listFiles(owner,{repository:'shop',limit:10})).rows.map(file=>file.path)).toEqual(['mapped.ts']);
   await owner.transaction('write',tx=>publishGraphDrafts(tx,graph,{vertices:[{...document,values:{actual_form:null},...fixtureProducer}],removals:[]}));
   expect((await listFiles(owner,{repository:'shop',limit:10})).rows[0]?.form).toBeNull();
   await owner.transaction('write',tx=>publishGraphDrafts(tx,graph,{vertices:[{...document,values:{actual_form:'unmapped'},...fixtureProducer}],removals:[]}));
   await expect(listFiles(owner,{repository:'shop',limit:10})).rejects.toThrow('/fixture/remapped/catalog.yaml:10: semantic role file.form has no declared value for "unmapped"');
   await owner.transaction('write',tx=>publishGraphDrafts(tx,graph,{vertices:[{...document,values:{actual_form:'plain'},...fixtureProducer}],removals:[]}));
   const malformedFields=bindings.map(([role,binding])=>role==='file'?[role,{kind:'document',line:10,fields:{...mappings(fileFields),bytes:'actual_language'},values:{form:{text:'plain',binary:'opaque'}}}]:[role,binding]);
   await publishDeclaration({...declaration,semanticBindings:{$map:malformedFields}});
   await expect(listFiles(owner,{repository:'shop',limit:10})).rejects.toThrow('/fixture/remapped/catalog.yaml:10: semantic role "file" projection');
   const withoutRole={...declaration,semanticBindings:{$map:bindings.filter(([name])=>name!=='file')}};
   await publishDeclaration(withoutRole);
   await expect(listFiles(owner,{repository:'shop',limit:10})).rejects.toThrow('/fixture/remapped/catalog.yaml:1: semantic-bindings.file');
   const withoutEdge={...declaration,semanticBindings:{$map:[['repository',{kind:'project',line:7,fields:mappings(repositoryFields)}],bindings[1]]}};
   await publishDeclaration(withoutEdge);
   await expect(listFiles(owner,{repository:'shop',limit:10})).rejects.toThrow('semantic-bindings.repository.edges.contains');
   const withoutField={...declaration,semanticBindings:{$map:[bindings[0],['file',{kind:'document',line:10,fields:mappings(fileFields.filter(name=>name!=='path'))}]]}};
   await publishDeclaration(withoutField);
   await expect(listFiles(owner,{repository:'shop',limit:10})).rejects.toThrow('requires field binding path');
 }finally{await owner.close();}
});
