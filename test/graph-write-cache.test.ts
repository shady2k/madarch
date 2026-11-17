/** Immutable lookup lifetime: decision 0039 items 25, 28 and 31. */
import {expect,test,spyOn} from 'bun:test';
import {currentSpan} from '../src/obs/trace.js';
import {clusterQuery} from '../src/adapters/postgres-cluster.js';
import {bindTestWriteCapability} from './write-capability-fixture.js';
import {Client} from 'pg';
import {createDatabaseOwner,databaseOwnerOf} from '../src/adapters/database-owner.js';
import {type GraphContract} from '../src/graph/contract.js';
import {bindWriteCapability,ensureVertex,publishGraphDrafts,requireWriteCapability} from '../src/graph/write.js';
import {createTestDatabaseOwner,prepareTestStore,testStoreServer} from './test-database.js';
const graph:GraphContract={vertex:[{name:'cache.subject',table:'unused',key:['name'],fields:[{name:'name',type:'text'},{name:'value',type:'text'}],capability:'fixture'}],edge:[],dictionary:[]};
const subject={kind:'cache.subject',key:{name:'same'}};
const draft={...subject,values:{value:'one'},producer:'fixture',producerVersion:'1'};
test('committed identities avoid kind and uid reads in a later whole owner transaction',async()=>{
 const fixture=await createTestDatabaseOwner({graphContract:graph});
 try{
  const {owner,binding}=await fixture.transaction('write',async tx=>({owner:databaseOwnerOf(tx)!,binding:requireWriteCapability(tx)}));
  const run=async()=>{
   const statements:string[]=[];
   const original=Client.prototype.query;
   const spy=spyOn(Client.prototype,'query').mockImplementation(function(this:Client,...args:unknown[]){
    if(typeof args[0]==='string')statements.push(args[0]);
    return Reflect.apply(original,this,args);
   } as typeof original);
   try{await owner.transaction('write',async tx=>{
    bindWriteCapability(tx,binding);
    await ensureVertex(tx,graph,subject);
    await publishGraphDrafts(tx,graph,{vertices:[draft],removals:[]});
   });}finally{spy.mockRestore();}
   return {statements:statements.length,kinds:statements.filter(sql=>sql.includes('FROM entity WHERE name=')||sql.includes('AS instant FROM entity')).length,
    identities:statements.filter(sql=>sql.includes('WHERE n.uid=')||sql.includes('WITH RECURSIVE wanted(uid)')).length};
  };
  const first=await run(),second=await run();console.log('whole owner cache statements',JSON.stringify({first,second}));
  expect(second.kinds).toBe(0);expect(second.identities).toBe(0);expect(second.statements).toBeLessThan(first.statements);
 }finally{await fixture.close();}
},30000);
test('a rolled back birth never supplies the later id',async()=>{
 const fixture=await createTestDatabaseOwner({graphContract:graph});let abandoned='';
 const {owner,binding}=await fixture.transaction('write',async tx=>({owner:databaseOwnerOf(tx)!,binding:requireWriteCapability(tx)}));
 try{
  await expect(owner.transaction('write',async tx=>{bindWriteCapability(tx,binding);abandoned=(await ensureVertex(tx,graph,subject)).nodeId;throw new Error('rollback');})).rejects.toThrow('rollback');
  const kept=await owner.transaction('write',async tx=>{bindWriteCapability(tx,binding);const made=await ensureVertex(tx,graph,subject);await publishGraphDrafts(tx,graph,{vertices:[draft],removals:[]});return made;});
  expect(kept.nodeId).not.toBe(abandoned);
  const stored=await owner.run(tx=>tx.query<{id:string}>('SELECT id::text FROM node WHERE uid=$1::uuid',[kept.uid]));expect(stored.rows).toEqual([{id:kept.nodeId}]);
 }finally{await fixture.close();}
},30000);
test('separate databases cannot share local ids',async()=>{
 const a=await createTestDatabaseOwner({graphContract:graph}),b=await createTestDatabaseOwner({graphContract:graph});
 try{
  const binding=await a.transaction('write',async tx=>{await publishGraphDrafts(tx,graph,{vertices:[draft],removals:[]});return requireWriteCapability(tx);});
  const held=await b.transaction('write',async tx=>{const own=requireWriteCapability(tx);bindWriteCapability(tx,{...own,productUid:binding.productUid,scope:binding.productUid});await tx.query("SELECT setval(pg_get_serial_sequence('node','id'),100000)");const made=await ensureVertex(tx,graph,subject);await publishGraphDrafts(tx,graph,{vertices:[draft],removals:[]});return made;});
  expect(Number(held.nodeId)).toBeGreaterThan(100000);
 }finally{await a.close();await b.close();}
},30000);
test('schema reinstall keeps old ids occupied but changes the subject kind id',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:graph});
 try{
  const old=await owner.run(tx=>tx.query<{id:string}>("SELECT id::text FROM entity WHERE name='cache.subject'"));
  await owner.transaction('write',tx=>publishGraphDrafts(tx,graph,{vertices:[draft],removals:[]}));
  const replacement={...graph,vertex:[{...graph.vertex[0]!,name:'cache.replacement'},...graph.vertex]};
  await prepareTestStore(owner,{reset:true,contract:replacement});
  const ids=await owner.run(tx=>tx.query<{id:string;name:string}>("SELECT id::text,name FROM entity WHERE name IN ('cache.subject','cache.replacement') ORDER BY name COLLATE \"C\""));
  expect(ids.rows.find(row=>row.name==='cache.replacement')!.id).toBe(old.rows[0]!.id);
  expect(ids.rows.find(row=>row.name==='cache.subject')!.id).not.toBe(old.rows[0]!.id);
  await owner.transaction('write',async tx=>{await bindTestWriteCapability(tx,replacement);await ensureVertex(tx,replacement,subject);await publishGraphDrafts(tx,replacement,{vertices:[draft],removals:[]});});
  const stored=await owner.run(tx=>tx.query<{name:string}>("SELECT k.name FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.key=$1::jsonb",[JSON.stringify(subject.key)]));
  expect(stored.rows).toEqual([{name:'cache.subject'}]);
 }finally{await owner.close();}
},30000);

test('an uncommitted birth cannot serve another transaction',async()=>{
 const fixture=await createTestDatabaseOwner({graphContract:graph});
 try{
  const {owner,binding}=await fixture.transaction('write',async tx=>({owner:databaseOwnerOf(tx)!,binding:requireWriteCapability(tx)}));
  const server=await testStoreServer();
  const database=owner.location.slice(owner.location.lastIndexOf('/')+1).replace(')','');
  const peer=await createDatabaseOwner({cluster:server,database,connectOnly:true});
  try{await owner.transaction('write',async first=>{
   bindWriteCapability(first,binding);
   const made=await ensureVertex(first,graph,subject);
   const other={query:async<Row extends object>(sql:string,values?:readonly unknown[])=>{
    // This simulated snapshot must not wait on the first writer's advisory lock.
    if(sql.includes('pg_advisory_xact_lock')||sql.startsWith('INSERT INTO node')||sql.includes('FOR UPDATE'))return {rows:[] as Row[]};
    return peer.run(tx=>tx.query<Row>(sql,values));
   }};
   bindWriteCapability(other,binding);
   // Another executor's database snapshot contains no committed subject. A
   // globally published birth must not let it skip the INSERT and return an id.
   await expect(ensureVertex(other,graph,subject)).rejects.toThrow();
   expect(made.created).toBe(true);
   throw new Error('abandon');
  }).catch(error=>{expect(String(error)).toContain('abandon');});}finally{await peer.close();}
 }finally{await fixture.close();}
},30000);
test('drop and recreate of the same database name never reuses ids',async()=>{
 const database='cache_recreated';
 let fixture=await createTestDatabaseOwner({database,graphContract:graph});
 const server=await testStoreServer();
 const cluster={...server,dataDir:server.socketDir,bin:'',stop:async()=>{}};
 let binding:ReturnType<typeof requireWriteCapability>,oldId='';
 try{
  binding=await fixture.transaction('write',async tx=>{const made=await ensureVertex(tx,graph,subject);oldId=made.nodeId;await publishGraphDrafts(tx,graph,{vertices:[draft],removals:[]});return requireWriteCapability(tx);});
  await fixture.close();
  await clusterQuery(cluster,'postgres',`DROP DATABASE "${database}"`);
  fixture=await createTestDatabaseOwner({database,graphContract:graph});
  const kept=await fixture.transaction('write',async tx=>{
   const own=requireWriteCapability(tx);bindWriteCapability(tx,{...own,productUid:binding.productUid,scope:binding.productUid});
   await tx.query("SELECT setval(pg_get_serial_sequence('node','id'),100000)");
   const made=await ensureVertex(tx,graph,subject);await publishGraphDrafts(tx,graph,{vertices:[draft],removals:[]});return made;
  });
  expect(kept.nodeId).not.toBe(oldId);expect(Number(kept.nodeId)).toBeGreaterThan(100000);
 }finally{await fixture.close();await clusterQuery(cluster,'postgres',`DROP DATABASE "${database}"`);}
},30000);

for(const mode of ['missing','foreign'] as const)test(`cached identity refuses ${mode} database row`,async()=>{
 const fixture=await createTestDatabaseOwner({graphContract:graph});
 try{
  const binding=await fixture.transaction('write',async tx=>{await publishGraphDrafts(tx,graph,{vertices:[draft],removals:[]});return requireWriteCapability(tx);});
  await expect(fixture.transaction('write',async tx=>{
   const wrong={afterCommit:tx.afterCommit,query:async<Row extends object>(sql:string,values?:readonly unknown[])=>{
    if(sql.includes('FROM node WHERE id=$1'))return {rows:(mode==='missing'?[]:[{id:values![0],uid:binding.productUid}]) as Row[]};
    return tx.query<Row>(sql,values);
   }};
   bindWriteCapability(wrong,binding);await ensureVertex(wrong,graph,subject);
  })).rejects.toThrow('UID_IDENTITY_CONFLICT');
 }finally{await fixture.close();}
},30000);
for(const mode of ['missing','foreign'] as const)test(`batch cached ids refuse ${mode} database rows`,async()=>{
 const fixture=await createTestDatabaseOwner({graphContract:graph});
 try{
  const binding=await fixture.transaction('write',async tx=>{await publishGraphDrafts(tx,graph,{vertices:[draft],removals:[]});return requireWriteCapability(tx);});
  await expect(fixture.transaction('write',async tx=>{
   const wrong={afterCommit:tx.afterCommit,query:async<Row extends object>(sql:string,values?:readonly unknown[])=>{
    const result=await tx.query<Row>(sql,values);
    if(sql.startsWith('SELECT id::text,uid::text FROM node WHERE id=ANY'))return {rows:(mode==='missing'?result.rows.slice(1):result.rows.map(row=>({...row,uid:binding.productUid}))) as Row[]};
    return result;
   }};
   bindWriteCapability(wrong,binding);await publishGraphDrafts(wrong,graph,{vertices:[draft],removals:[]});
  })).rejects.toThrow('UID_IDENTITY_CONFLICT');
 }finally{await fixture.close();}
},30000);
test('ensure takes the graph lock before reading the installation key',async()=>{
 const fixture=await createTestDatabaseOwner({graphContract:graph});
 try{
  const binding=await fixture.transaction('write',async tx=>requireWriteCapability(tx));
  await fixture.transaction('write',async tx=>{
   let locked=false;
   const guarded={afterCommit:tx.afterCommit,query:async<Row extends object>(sql:string,values?:readonly unknown[])=>{
    if(sql.includes('pg_control_system'))expect(locked).toBe(true);
    const result=await tx.query<Row>(sql,values);if(sql.includes('pg_advisory_xact_lock'))locked=true;return result;
   }};
   bindWriteCapability(guarded,binding);await ensureVertex(guarded,graph,subject);await publishGraphDrafts(guarded,graph,{vertices:[draft],removals:[]});
  });
 }finally{await fixture.close();}
},30000);
test('afterCommit failure does not turn a kept write into a transaction failure',async()=>{
 let callbackContinued=false;let recorded:unknown;let recorder:ReturnType<typeof spyOn>|undefined;
 const fixture=await createTestDatabaseOwner({graphContract:graph});
 try{
  const result=await fixture.transaction('write',async tx=>{
   recorder=spyOn(currentSpan()!,'recordException').mockImplementation(error=>{recorded=error;});
   await tx.query('CREATE TABLE kept_callback (value integer)');await tx.query('INSERT INTO kept_callback VALUES (42)');
   tx.afterCommit!(()=>{throw new Error('cache publication failed');});
   tx.afterCommit!(()=>{callbackContinued=true;});
   return 'kept';
  });
  expect(String(recorded)).toContain('cache publication failed');recorder!.mockRestore();expect(callbackContinued).toBe(true);expect(result).toBe('kept');expect((await fixture.run(tx=>tx.query('SELECT value FROM kept_callback'))).rows).toEqual([{value:42}]);
 }finally{await fixture.close();}
},30000);

test('schema preparation cannot reset between installation key and cached identity use',async()=>{
 const fixture=await createTestDatabaseOwner({graphContract:graph});
 try{
  const {SCHEMA_LOCK_SQL,storeSchemaLockKey}=await import('../src/adapters/schema-lock.js');
  const binding=await fixture.transaction('write',async tx=>{await publishGraphDrafts(tx,graph,{vertices:[draft],removals:[]});return requireWriteCapability(tx);});
  await fixture.transaction('write',async tx=>{
   const guarded={afterCommit:tx.afterCommit,query:async<Row extends object>(sql:string,values?:readonly unknown[])=>{
    const result=await tx.query<Row>(sql,values);
    if(sql.includes('pg_control_system')){
     const server=await testStoreServer();
     const database=fixture.location.slice(fixture.location.lastIndexOf('/')+1).replace(')','');
     const peer=await createDatabaseOwner({cluster:server,database,connectOnly:true});
     try{await expect(peer.transaction('write',async reset=>{
      await reset.query("SET LOCAL lock_timeout='100ms'");await reset.query(SCHEMA_LOCK_SQL,[storeSchemaLockKey()]);
      await reset.query("UPDATE madarch_meta.schema_stamp SET stamp='reset' WHERE name='one-graph'");
     })).rejects.toThrow('lock timeout');}finally{await peer.close();}
    }
    return result;
   }};
   bindWriteCapability(guarded,binding);const made=await ensureVertex(guarded,graph,subject);expect(made.created).toBe(false);
  });
 }finally{await fixture.close();}
},30000);

for(const path of ['ensure','batch'] as const)test(`a deliberately wrong cache entry is refused by ${path}`,async()=>{
 const fixture=await createTestDatabaseOwner({graphContract:graph});
 try{
  const clone=globalThis.structuredClone;
  const spy=spyOn(globalThis,'structuredClone').mockImplementation(((value:unknown)=>{
   const copy=clone(value);
   if(copy!==null&&typeof copy==='object'&&'kind' in copy&&copy.kind==='cache.subject'&&'parents' in copy)return {...copy,id:'999999999'};
   return copy;
  }) as typeof structuredClone);
  let binding:ReturnType<typeof requireWriteCapability>;
  try{binding=await fixture.transaction('write',async tx=>{await publishGraphDrafts(tx,graph,{vertices:[draft],removals:[]});return requireWriteCapability(tx);});}finally{spy.mockRestore();}
  await expect(fixture.transaction('write',async tx=>{bindWriteCapability(tx,binding);if(path==='ensure')await ensureVertex(tx,graph,subject);else await publishGraphDrafts(tx,graph,{vertices:[draft],removals:[]});})).rejects.toThrow('UID_IDENTITY_CONFLICT');
 }finally{await fixture.close();}
},30000);

for(const mode of ['missing','foreign'] as const)test(`batch row locks refuse ${mode} database rows`,async()=>{
 const fixture=await createTestDatabaseOwner({graphContract:graph});
 try{
  const binding=await fixture.transaction('write',async tx=>{await publishGraphDrafts(tx,graph,{vertices:[draft],removals:[]});return requireWriteCapability(tx);});
  await expect(fixture.transaction('write',async tx=>{
   const wrong={afterCommit:tx.afterCommit,query:async<Row extends object>(sql:string,values?:readonly unknown[])=>{
    const result=await tx.query<Row>(sql,values);
    if(sql.includes('WHERE n.id=ANY($1::bigint[]) ORDER BY n.id FOR UPDATE OF n'))return {rows:(mode==='missing'?[]:result.rows.map(row=>({...row,uid:binding.productUid}))) as Row[]};
    return result;
   }};
   bindWriteCapability(wrong,binding);await publishGraphDrafts(wrong,graph,{vertices:[draft],removals:[]});
  })).rejects.toThrow('UID_IDENTITY_CONFLICT');
 }finally{await fixture.close();}
},30000);
