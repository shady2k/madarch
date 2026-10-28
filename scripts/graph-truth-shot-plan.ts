import {createHash} from 'node:crypto';
export function truthShotKey(kind:string,id:string,language:string,width:number,scheme:string):string {return `truth-${kind}-${createHash('sha256').update(id).digest('hex').slice(0,20)}-${language}-${width}-${scheme}`;}
export function verifyTruthShotSet(expected:readonly string[],completed:readonly string[],actual:readonly string[]):void {
 if(new Set(expected).size!==expected.length||new Set(completed).size!==completed.length||new Set(actual).size!==actual.length||expected.length!==completed.length||expected.length!==actual.length||expected.some((name)=>!completed.includes(name)||!actual.includes(name))||actual.some((name)=>!expected.includes(name)))throw new Error(`incomplete or duplicate truth screenshot set: expected${expected.length} completed${completed.length} actual${actual.length}`);
}

/** Close every owned resource even when an earlier close rejects or never settles. */
export async function closeWalkResources(resources:readonly {name:string;close:()=>Promise<unknown>;force?:()=>void}[],deadlineMs:number,failed:(name:string,error:unknown)=>void):Promise<void> {
 await Promise.all(resources.map(async(resource)=>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {await Promise.race([Promise.resolve().then(resource.close),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(`cleanup exceeded ${deadlineMs} ms`)),deadlineMs);})]);}
  catch(error){failed(resource.name,error);try{resource.force?.();}catch(forceError){failed(`${resource.name}:force`,forceError);}}
  finally{clearTimeout(timer);}
 }));
}

/** Fixed lanes bound browser/reader pressure; preserve input order and propagate every failure. */
export async function walkConcurrent<T,R>(items:readonly T[],lanes:number,work:(item:T,index:number,lane:number)=>Promise<R>):Promise<R[]> {
 if(!Number.isSafeInteger(lanes)||lanes<1)throw new Error('walk lanes must be a positive integer');
 const results:R[]=new Array(items.length);let next=0;
 const settled=await Promise.allSettled(Array.from({length:Math.min(lanes,items.length)},async(_,lane)=>{for(;;){const index=next++;if(index>=items.length)return;results[index]=await work(items[index]!,index,lane);}}));
 const rejected=settled.find((row)=>row.status==='rejected');if(rejected?.status==='rejected')throw rejected.reason;return results;
}
