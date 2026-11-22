import { createUnitIn, FILL_STATE_TABLES, type FillStateDatabase, type UnitCreateOptions } from '../src/graph/fill-state.js';
import { acquireGraphWriteLock } from '../src/graph/write.js';
import { here, withLocation } from '../src/fill/fsm-core.js';
import { withSpan } from '../src/obs/trace.js';

/** A fixture opens the transaction that production planning already owns. */
export async function createUnit(database:FillStateDatabase,options:UnitCreateOptions){
 return await withSpan('graph.fillstate.run',{'fillstate.operation':`createUnit(${options.unitId})`,'fillstate.kind':'write'},async()=>
  await withLocation(here(),`createUnit(${options.unitId})`,FILL_STATE_TABLES,async()=>await database.transaction('write',async tx=>{
   await acquireGraphWriteLock(tx);
   return await createUnitIn(tx,options);
  })));
}
