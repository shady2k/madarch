/** Resolve supported probe targets without discarding authority, method or port. */
import type {ExtractedNode} from './records.js';
import {literalShellArgv} from './shell-command.js';
import {shellCommandModels,type ShellOptionModel} from './library-models/shell-command-models.js';
export interface EndpointTarget {readonly service:string;readonly path:string;readonly method:string;readonly port?:string}
export type EndpointResolution =
 | {readonly kind:'http';readonly target:EndpointTarget}
 | {readonly kind:'non-http';readonly modelId:string}
 | {readonly kind:'unresolved'};
const unresolved:EndpointResolution=Object.freeze({kind:'unresolved'});

/** Compose exec form is already argv; only shell form goes through Bash. */
function probeArgv(test:unknown):readonly string[]|undefined {
 if(typeof test==='string')return literalShellArgv(test);
 if(!Array.isArray(test)||!test.every((item)=>typeof item==='string'))return undefined;
 if(test[0]==='CMD')return test.slice(1);
 if(test[0]==='CMD-SHELL')return test.length===2?literalShellArgv(test[1]!):undefined;
 return undefined;
}
function commandResolution(argv:readonly string[],service:string):EndpointResolution {
 const executable=argv[0];if(executable===undefined)return unresolved;
 const name=executable.slice(executable.lastIndexOf('/')+1);
 const model=shellCommandModels.find((model)=>model.executables.includes(name));if(model===undefined)return unresolved;
 const options=new Map(model.options.flatMap((option)=>option.names.map((name)=>[name,option] as const)));
 let explicit:string|undefined;let implicit:string|undefined;let priority=-1;const urls:string[]=[];let ended=false;
 const apply=(option:ShellOptionModel,value?:string):boolean=>{
  if(option.argument==='required'&&value===undefined)return false;
  // A missing/option-like username is not positive proof of a supported argv.
  if(model.kind==='non-http'&&option.argument==='required'&&(value===''||value!.startsWith('-')))return false;
  if(option.effect==='method'){if(value===undefined||value===''||[...value].some(c=>!"!#$%&'*+-.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".includes(c)))return false;explicit=value;}
  else if(option.effect==='fixed-method'){
   if(option.priority===priority&&implicit!==undefined&&implicit!==option.method)return false;
   if(option.priority!>priority){implicit=option.method;priority=option.priority!;}
  }else if(option.effect==='url')urls.push(value!);
  return true;
 };
 for(let i=1;i<argv.length;i++){
  const arg=argv[i]!;
  if(!ended&&arg==='--'){ended=true;continue;}
  if(!ended&&arg.startsWith('--')){
   const equal=arg.indexOf('=');const key=equal===-1?arg:arg.slice(0,equal);const option=options.get(key);if(option===undefined)return unresolved;
   if(option.argument==='none'){if(equal!==-1||!apply(option))return unresolved;}
   else {const value=equal===-1?argv[++i]:arg.slice(equal+1);if(!apply(option,value))return unresolved;}
  }else if(!ended&&arg.startsWith('-')&&arg!=='-'){
   for(let j=1;j<arg.length;j++){
    const option=options.get('-'+arg[j]!);if(option===undefined)return unresolved;
    if(option.argument==='none'){if(!apply(option))return unresolved;}
    else {const value=j+1<arg.length?arg.slice(j+1):argv[++i];if(!apply(option,value))return unresolved;break;}
   }
  }else urls.push(arg);
 }
 // Non-HTTP descriptors declare no positional arguments in this bounded model.
 if(model.kind==='non-http')return urls.length===0?{kind:'non-http',modelId:model.id}:unresolved;
 if(urls.length!==1)return unresolved;
 let url:URL;try{url=new URL(urls[0]!);}catch{return unresolved;}
 if((url.protocol!=='http:'&&url.protocol!=='https:')||url.username!==''||url.password!==''||!['localhost','127.0.0.1','[::1]',service].includes(url.hostname))return unresolved;
 return {kind:'http',target:{service,path:url.pathname,method:explicit??implicit??model.defaultMethod,port:url.port||(url.protocol==='https:'?'443':'80')}};
}
/** Only positive closed command evidence excludes a healthcheck from HTTP joins. */
export function resolveEndpointTarget(node:ExtractedNode):EndpointResolution {
 const service=node.properties.service;
 if(typeof service!=='string'||service==='')return unresolved;
 if(node.kind==='code.healthcheck') {
  const argv=probeArgv(node.properties.test);return argv===undefined?unresolved:commandResolution(argv,service);
 }
 const path=node.properties.path;if(typeof path!=='string')return unresolved;
 const method=node.kind==='code.probe'?'GET':node.properties.method;
 if(typeof method!=='string'||method==='')return unresolved;
 const host=node.properties.host;
 if(typeof host==='string'&&host!==''&&!['localhost','127.0.0.1','[::1]',service].includes(host))return unresolved;
 const port=node.properties.resolvedPort??node.properties.port;
 return {kind:'http',target:{service,path,method,...(typeof port==='string'||typeof port==='number'?{port:String(port)}:{})}};
}
/** Compatibility lookup; undefined alone is never proof of a non-HTTP command. */
export function endpointTarget(node:ExtractedNode):EndpointTarget|undefined {
 const resolved=resolveEndpointTarget(node);return resolved.kind==='http'?resolved.target:undefined;
}
/** An explicit numeric port must agree with a positively declared listener. */
export function matchesEndpoint(target:EndpointTarget,node:ExtractedNode):boolean {
 if(node.properties.service!==target.service||node.properties.path!==target.path||node.properties.method!==target.method)return false;
 if(target.port===undefined)return true;
 const ports=node.properties.ports;
 return Array.isArray(ports)&&ports.some((port)=>String(port)===target.port);
}
