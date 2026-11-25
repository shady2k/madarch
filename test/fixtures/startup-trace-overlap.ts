import { startupEntry, startupBegin, withStartupContext } from '../../src/obs/log.js';
import { openTrace, closeTrace, runInTrace, withSpan } from '../../src/obs/trace.js';
import { randomUUID } from 'node:crypto';
startupEntry('fixture');
const a=randomUUID(), b=randomUUID();
let first!:()=>void; const started=new Promise<void>(r=>first=r);
let last!:()=>void; const release=new Promise<void>(r=>last=r);
const traceA=openTrace({store:process.argv[2]!,runId:'first'});
const traceB=openTrace({store:process.argv[2]!,runId:'second'});
await Promise.all([
 runInTrace(traceA,async()=>await withStartupContext(a,async()=>await withSpan('first',{},async()=>{const end=startupBegin('overlap');first();await release;end('ok');}))),
 runInTrace(traceB,async()=>await withStartupContext(b,async()=>{await started;await withSpan('second',{},async()=>{const end=startupBegin('overlap');end('ok');});last();})),
]);
closeTrace(traceA);closeTrace(traceB);console.log(JSON.stringify({a,b}));
