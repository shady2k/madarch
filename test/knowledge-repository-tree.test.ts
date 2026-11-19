import { expect,test } from 'bun:test';
import {GraphReader} from '../src/knowledge/graph-read.js';
import {publishGraphDrafts} from '../src/graph/write.js';
import {createRecordOwner,recordGraph,repoRef,fixtureProducer} from './assertion-record-fixture.js';
// Empty inventory publication remains distinct from history and metadata publication.
test.each([
 {name:'empty inventory publication',values:{tree_snapshot:'4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'},tree:true},
 {name:'history only',values:{history_shallow:false},tree:false},
 {name:'metadata only',values:{url:'https://example.test/repo.git'},tree:false},
])('$name reports tree availability independently of counts',async({values,tree})=>{
 const owner=await createRecordOwner();try{
 await owner.transaction('write',tx=>publishGraphDrafts(tx,recordGraph,{vertices:[{...repoRef('fixture'),values,...fixtureProducer}],removals:[]}));
 const reader=new GraphReader(owner,()=>'',undefined,undefined,new Set(['code.repository']));
 expect(await reader.repository('fixture')).toMatchObject({asIsCommit:null,counts:{files:0,commits:0,folders:0},steps:{tree,history:false}});
 }finally{await owner.close();}
});
