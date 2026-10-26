/** Closed imported producer type identities; operation selectors stay in the library registry. */
import {createHash} from 'node:crypto';
import source from './messaging-models.json' with { type: 'text' };
export interface MessagingTypeModel {readonly id:string;readonly ecosystem:'node'|'go';readonly package:string;readonly packageName?:string;readonly exportedPath:readonly string[];readonly role:'message-producer';readonly pointer:boolean;readonly reference:string}
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(value===null||typeof value!=='object'||Array.isArray(value))throw new Error('messaging model: expected object');
 for(const key of Object.keys(value))if(!keys.includes(key))throw new Error(`messaging model: unknown field ${key}`);
 return value as Record<string,unknown>;
}
function text(value:unknown):string {if(typeof value!=='string'||value===''||value.trim()!==value||[...value].some(c=>c.codePointAt(0)!<32))throw new Error('messaging model: invalid string');return value;}
export function validateMessagingModels(value:unknown):readonly MessagingTypeModel[]{
 const root=object(value,['schemaVersion','models']);if(root.schemaVersion!==1||!Array.isArray(root.models)||root.models.length===0)throw new Error('messaging model: invalid registry');
 const result=root.models.map((entry):MessagingTypeModel=>{
  const model=object(entry,['id','ecosystem','package','packageName','exportedPath','role','pointer','reference']);
  if((model.ecosystem!=='node'&&model.ecosystem!=='go')||model.role!=='message-producer'||typeof model.pointer!=='boolean'||!Array.isArray(model.exportedPath)||model.exportedPath.length===0)throw new Error('messaging model: invalid type');
  const reference=text(model.reference);const url=new URL(reference);if(url.protocol!=='https:'||url.username!==''||url.password!=='')throw new Error('messaging model: invalid reference');
  if(model.packageName!==undefined&&(model.ecosystem!=='go'||![...text(model.packageName)].every((c,index)=>index===0?c==='_'||c.toLowerCase()!==c.toUpperCase():c==='_'||c.toLowerCase()!==c.toUpperCase()||'0123456789'.includes(c))))throw new Error('messaging model: invalid declared package name');
  return Object.freeze({id:text(model.id),ecosystem:model.ecosystem,package:text(model.package),...(model.packageName===undefined?{}:{packageName:text(model.packageName)}),exportedPath:Object.freeze(model.exportedPath.map(text)),role:model.role,pointer:model.pointer,reference});
 });
 const packages=new Map<string,string>();for(const model of result)if(model.packageName!==undefined){const key=JSON.stringify([model.ecosystem,model.package]);const previous=packages.get(key);if(previous!==undefined&&previous!==model.packageName)throw new Error('messaging model: conflicting declared package name');packages.set(key,model.packageName);}
 if(new Set(result.map(m=>m.id)).size!==result.length||new Set(result.map(m=>JSON.stringify([m.ecosystem,m.package,m.exportedPath,m.pointer]))).size!==result.length)throw new Error('messaging model: duplicate type');
 return Object.freeze(result);
}
export const messagingTypes=validateMessagingModels(JSON.parse(source as unknown as string));
export const messagingModelDigest=createHash('sha256').update(JSON.stringify(messagingTypes)).digest('hex');
