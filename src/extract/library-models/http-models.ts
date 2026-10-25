/** Closed HTTP models-as-data vocabulary. No executable repository rules. */
import {createHash} from 'node:crypto';
import source from './http-models.json';
import {byCodePoint} from '../../model/order.js';
export type HttpRole='application'|'router'|'mux';
export type HttpTarget={readonly kind:'export';readonly paths:readonly (readonly string[])[]}|{readonly kind:'member';readonly roles:readonly HttpRole[];readonly members:readonly string[]};
export type HttpEffect={readonly kind:'factory';readonly role:HttpRole}|{readonly kind:'route';readonly pathArgument:number;readonly handlerArgument:number;readonly method:'member'|'pattern'}|{readonly kind:'listen';readonly portArgument:number;readonly handlerArgument?:number;readonly portFormat:'number'|'address'}|{readonly kind:'mount';readonly argumentsFrom:number}|{readonly kind:'server';readonly listenMember:string;readonly addressField:string;readonly handlerField:string};
export interface HttpModel {readonly id:string;readonly ecosystem:'node'|'go';readonly package:string;readonly target:HttpTarget;readonly effect:HttpEffect;readonly reference:string}
function object(value:unknown,where:string,keys:readonly string[]):Record<string,unknown>{if(value===null||typeof value!=='object'||Array.isArray(value))throw new Error(`${where}: expected object`);for(const key of Object.keys(value))if(!keys.includes(key))throw new Error(`${where}.${key}: unknown field`);return value as Record<string,unknown>;}
function string(value:unknown,where:string):string{if(typeof value!=='string'||value===''||value.trim()!==value||[...value].some(character=>character.codePointAt(0)!<32))throw new Error(`${where}: expected exact nonempty string`);return value;}
function choice<T extends string>(value:unknown,where:string,choices:readonly T[]):T{if(!choices.includes(value as T))throw new Error(`${where}: unknown vocabulary value`);return value as T;}
function integer(value:unknown,where:string,negative=false):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<(negative?-1:0))throw new Error(`${where}: invalid argument index`);return value;}
function list<T>(value:unknown,where:string,read:(entry:unknown,where:string)=>T):readonly T[]{if(!Array.isArray(value)||value.length===0)throw new Error(`${where}: expected nonempty array`);const result=value.map((entry,index)=>read(entry,`${where}[${index}]`));if(new Set(result.map(entry=>JSON.stringify(entry))).size!==result.length)throw new Error(`${where}: duplicate selector`);return Object.freeze(result);}
function role(value:unknown,where:string):HttpRole{return choice(value,where,['application','router','mux']);}
function target(value:unknown,where:string):HttpTarget{
 const header=object(value,where,['kind','paths','roles','members']);
 if(header.kind==='export'){const obj=object(value,where,['kind','paths']);return Object.freeze({kind:'export',paths:list(obj.paths,`${where}.paths`,(entry,at)=>{if(!Array.isArray(entry))throw new Error(`${at}: expected path array`);return Object.freeze(entry.map((part,index)=>string(part,`${at}[${index}]`)));})});}
 if(header.kind==='member'){const obj=object(value,where,['kind','roles','members']);return Object.freeze({kind:'member',roles:list(obj.roles,`${where}.roles`,role),members:list(obj.members,`${where}.members`,string)});}
 throw new Error(`${where}: unknown target`);
}
function effect(value:unknown,where:string):HttpEffect{
 const header=object(value,where,['kind','role','pathArgument','handlerArgument','method','portArgument','portFormat','argumentsFrom','listenMember','addressField','handlerField']);
 if(header.kind==='factory'){const obj=object(value,where,['kind','role']);return Object.freeze({kind:'factory',role:role(obj.role,`${where}.role`)});}
 if(header.kind==='route'){const obj=object(value,where,['kind','pathArgument','handlerArgument','method']);return Object.freeze({kind:'route',pathArgument:integer(obj.pathArgument,`${where}.pathArgument`),handlerArgument:integer(obj.handlerArgument,`${where}.handlerArgument`,true),method:choice(obj.method,`${where}.method`,['member','pattern'])});}
 if(header.kind==='listen'){const obj=object(value,where,['kind','portArgument','handlerArgument','portFormat']);return Object.freeze({kind:'listen',portArgument:integer(obj.portArgument,`${where}.portArgument`),...(obj.handlerArgument===undefined?{}:{handlerArgument:integer(obj.handlerArgument,`${where}.handlerArgument`)}),portFormat:choice(obj.portFormat,`${where}.portFormat`,['number','address'])});}
 if(header.kind==='mount'){const obj=object(value,where,['kind','argumentsFrom']);return Object.freeze({kind:'mount',argumentsFrom:integer(obj.argumentsFrom,`${where}.argumentsFrom`)});}
 if(header.kind==='server'){const obj=object(value,where,['kind','listenMember','addressField','handlerField']);return Object.freeze({kind:'server',listenMember:string(obj.listenMember,`${where}.listenMember`),addressField:string(obj.addressField,`${where}.addressField`),handlerField:string(obj.handlerField,`${where}.handlerField`)});}
 throw new Error(`${where}: unknown effect`);
}
export function validateHttpModels(value:unknown):readonly HttpModel[]{
 const registry=object(value,'http-models',['schemaVersion','models']);if(registry.schemaVersion!==1)throw new Error('http-models.schemaVersion: unsupported version');
 const models=list(registry.models,'http-models.models',(entry,where)=>{const obj=object(entry,where,['id','ecosystem','package','target','effect','reference']);const model={id:string(obj.id,`${where}.id`),ecosystem:choice(obj.ecosystem,`${where}.ecosystem`,['node','go']),package:string(obj.package,`${where}.package`),target:target(obj.target,`${where}.target`),effect:effect(obj.effect,`${where}.effect`),reference:string(obj.reference,`${where}.reference`)};
 if((model.effect.kind==='factory'||model.effect.kind==='server')&&model.target.kind!=='export'||model.effect.kind==='mount'&&model.target.kind!=='member')throw new Error(`${where}: incompatible target and effect`);return Object.freeze(model);});
 if(new Set(models.map(model=>model.id)).size!==models.length)throw new Error('http-models.models: duplicate model id');
 const providers=new Set(models.flatMap(model=>model.effect.kind==='factory'?[JSON.stringify([model.package,model.effect.role])]:[]));
 for(const model of models)if(model.target.kind==='member'&&model.target.roles.some(role=>!providers.has(JSON.stringify([model.package,role]))))throw new Error(`http-models.models.${model.id}: receiver role has no factory`);
 return Object.freeze([...models].sort((a,b)=>byCodePoint(a.id,b.id)));
}
export const httpModels=validateHttpModels(source);
export const httpModelDigest=createHash('sha256').update(JSON.stringify(httpModels)).digest('hex');
