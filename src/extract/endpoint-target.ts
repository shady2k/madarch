/** Resolve supported probe targets without discarding authority, method or port. */
import type {ExtractedNode} from './records.js';
export interface EndpointTarget {readonly service:string;readonly path:string;readonly method:string;readonly port?:string}
export function endpointTarget(node:ExtractedNode):EndpointTarget|undefined {
 const service=node.properties.service;
 if(typeof service!=='string'||service==='')return undefined;
 if(node.kind==='code.healthcheck') {
  const test=node.properties.test;const command=Array.isArray(test)?test.join(' '):test;
  if(typeof command!=='string')return undefined;
  const literal=/https?:\/\/[^\s'"\]]+/.exec(command)?.[0];if(literal===undefined)return undefined;
  let url:URL;try{url=new URL(literal);}catch{return undefined;}
  if(!['localhost','127.0.0.1','[::1]',service].includes(url.hostname))return undefined;
  // curl has GET semantics only in the absence of options that change them.
  if(!/(?:^|\s)(?:\S*\/)?curl(?:\s|$)/.test(command))return undefined;
  const explicit=/(?:--request(?:=|\s+)|-X\s*)([A-Za-z]+)/.exec(command)?.[1];
  const method=explicit?.toUpperCase()??(/(?:^|\s)(?:-I|--head)(?:\s|$)/.test(command)?'HEAD':/(?:^|\s)(?:-d|--data(?:-\w+)?|--json|--upload-file|-T)(?:[=\s]|$)/.test(command)?undefined:'GET');
  if(method===undefined)return undefined;
  return {service,path:url.pathname,method,port:url.port|| (url.protocol==='https:'?'443':'80')};
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
