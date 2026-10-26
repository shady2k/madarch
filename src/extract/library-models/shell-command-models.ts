/** Closed command option semantics. Shell syntax belongs to the Bash grammar. */
import {createHash} from 'node:crypto';
import source from './shell-command-models.json';
export interface ShellOptionModel {readonly names:readonly string[];readonly argument:'none'|'required';readonly effect:'method'|'fixed-method'|'url'|'ignore';readonly method?:string;readonly priority?:number}
export interface ShellCommandModel {readonly id:string;readonly ecosystem:'shell';readonly package:string;readonly reference:string;readonly executables:readonly string[];readonly defaultMethod:string;readonly options:readonly ShellOptionModel[]}
function object(value:unknown, keys:readonly string[]):Record<string,unknown>{
 if(value===null||typeof value!=='object'||Array.isArray(value))throw new Error('shell command model: expected object');
 for(const key of Object.keys(value))if(!keys.includes(key))throw new Error(`shell command model: unknown field ${key}`);
 return value as Record<string,unknown>;
}
function text(value:unknown):string {if(typeof value!=='string'||value===''||value.trim()!==value||[...value].some(c=>c.codePointAt(0)!<32))throw new Error('shell command model: invalid string');return value;}
function strings(value:unknown):readonly string[]{if(!Array.isArray(value)||value.length===0)throw new Error('shell command model: expected nonempty list');const result=value.map(text);if(new Set(result).size!==result.length)throw new Error('shell command model: duplicate selector');return Object.freeze(result);}
export function validateShellCommandModels(value:unknown):readonly ShellCommandModel[]{
 const root=object(value,['schemaVersion','models']);if(root.schemaVersion!==1||!Array.isArray(root.models)||root.models.length===0)throw new Error('shell command model: unsupported registry');
 const models=root.models.map((entry):ShellCommandModel=>{
  const model=object(entry,['id','ecosystem','package','reference','executables','defaultMethod','options']);
  if(model.ecosystem!=='shell'||!Array.isArray(model.options)||model.options.length===0)throw new Error('shell command model: invalid ecosystem/options');
  const reference=text(model.reference);const url=new URL(reference);if(url.protocol!=='https:'||url.username!==''||url.password!=='')throw new Error('shell command model: invalid reference');
  const options=model.options.map((entry):ShellOptionModel=>{
   const option=object(entry,['names','argument','effect','method','priority']);
   if(option.argument!=='none'&&option.argument!=='required')throw new Error('shell command model: invalid arity');
   if(!['method','fixed-method','url','ignore'].includes(String(option.effect)))throw new Error('shell command model: unknown effect');
   const effect=option.effect as ShellOptionModel['effect'];
   if((effect==='fixed-method')!==(option.method!==undefined)||((effect==='method'||effect==='url')&&option.argument!=='required'))throw new Error('shell command model: inconsistent effect');
   if(effect==='fixed-method'?(typeof option.priority!=='number'||!Number.isSafeInteger(option.priority)||option.priority<0):option.priority!==undefined)throw new Error('shell command model: invalid priority');
   return Object.freeze({names:strings(option.names),argument:option.argument,effect,...(option.method===undefined?{}:{method:text(option.method),priority:option.priority as number})});
  });
  const names=options.flatMap(o=>o.names);if(new Set(names).size!==names.length||names.some(n=>!n.startsWith('-')||n==='-'||n==='--'))throw new Error('shell command model: duplicate/invalid option');
  return Object.freeze({id:text(model.id),ecosystem:'shell',package:text(model.package),reference,executables:strings(model.executables),defaultMethod:text(model.defaultMethod),options:Object.freeze(options)});
 });
 if(new Set(models.map(m=>m.id)).size!==models.length||new Set(models.flatMap(m=>m.executables)).size!==models.flatMap(m=>m.executables).length)throw new Error('shell command model: duplicate command');
 return Object.freeze(models);
}
export const shellCommandModels=validateShellCommandModels(source);
export const shellCommandModelDigest=createHash('sha256').update(JSON.stringify(shellCommandModels)).digest('hex');
