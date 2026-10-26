/** Resolve supported probe targets without discarding authority, method or port. */
import type {ExtractedNode} from './records.js';
import {literalShellArgv} from './shell-command.js';
import {shellCommandModels,type ShellOptionModel} from './library-models/shell-command-models.js';
export interface EndpointTarget {readonly service:string;readonly path:string;readonly method:string;readonly port?:string}

/** Compose exec form is already argv; only shell form goes through Bash. */
function probeArgv(test:unknown):readonly string[]|undefined {
 if(typeof test==='string')return literalShellArgv(test);
 if(!Array.isArray(test)||!test.every((item)=>typeof item==='string'))return undefined;
 if(test[0]==='CMD')return test.slice(1);
 if(test[0]==='CMD-SHELL')return test.length===2?literalShellArgv(test[1]!):undefined;
 return undefined;
}
function commandTarget(argv:readonly string[],service:string):EndpointTarget|undefined {
 const executable=argv[0];if(executable===undefined)return undefined;
 const name=executable.slice(executable.lastIndexOf('/')+1);
 const model=shellCommandModels.find((model)=>model.executables.includes(name));if(model===undefined)return undefined;
 const options=new Map(model.options.flatMap((option)=>option.names.map((name)=>[name,option] as const)));
 let explicit:string|undefined;let implicit:string|undefined;let priority=-1;const urls:string[]=[];let ended=false;
 const apply=(option:ShellOptionModel,value?:string):boolean=>{
  if(option.argument==='required'&&value===undefined)return false;
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
   const equal=arg.indexOf('=');const key=equal===-1?arg:arg.slice(0,equal);const option=options.get(key);if(option===undefined)return undefined;
   if(option.argument==='none'){if(equal!==-1||!apply(option))return undefined;}
   else {const value=equal===-1?argv[++i]:arg.slice(equal+1);if(!apply(option,value))return undefined;}
  }else if(!ended&&arg.startsWith('-')&&arg!=='-'){
   for(let j=1;j<arg.length;j++){
    const option=options.get('-'+arg[j]!);if(option===undefined)return undefined;
    if(option.argument==='none'){if(!apply(option))return undefined;}
    else {const value=j+1<arg.length?arg.slice(j+1):argv[++i];if(!apply(option,value))return undefined;break;}
   }
  }else urls.push(arg);
 }
 if(urls.length!==1)return undefined;
 let url:URL;try{url=new URL(urls[0]!);}catch{return undefined;}
 if((url.protocol!=='http:'&&url.protocol!=='https:')||url.username!==''||url.password!==''||!['localhost','127.0.0.1','[::1]',service].includes(url.hostname))return undefined;
 return {service,path:url.pathname,method:explicit??implicit??model.defaultMethod,port:url.port||(url.protocol==='https:'?'443':'80')};
}
export function endpointTarget(node:ExtractedNode):EndpointTarget|undefined {
 const service=node.properties.service;
 if(typeof service!=='string'||service==='')return undefined;
 if(node.kind==='code.healthcheck') {
  const argv=probeArgv(node.properties.test);return argv===undefined?undefined:commandTarget(argv,service);
 }
 const path=node.properties.path;if(typeof path!=='string')return undefined;
 const method=node.kind==='code.probe'?'GET':node.properties.method;
 if(typeof method!=='string'||method==='')return undefined;
 const host=node.properties.host;
 if(typeof host==='string'&&host!==''&&!['localhost','127.0.0.1','[::1]',service].includes(host))return undefined;
 const port=node.properties.resolvedPort??node.properties.port;
 return {service,path,method,...(typeof port==='string'||typeof port==='number'?{port:String(port)}:{})};
}
/** An explicit numeric port must agree with a positively declared listener. */
export function matchesEndpoint(target:EndpointTarget,node:ExtractedNode):boolean {
 if(node.properties.service!==target.service||node.properties.path!==target.path||node.properties.method!==target.method)return false;
 if(target.port===undefined)return true;
 const ports=node.properties.ports;
 return Array.isArray(ports)&&ports.some((port)=>String(port)===target.port);
}
