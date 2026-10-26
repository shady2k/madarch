/** Structural HTTP joins over immutable CodeFacts. Never parse source text. */
import type {CodeBindingFact,CodeCallFact,CodeExpressionFact,CodeImportFact} from '../code/facts.js';
import type {SourceSpan} from '../records.js';
import {byCodePoint} from '../../model/order.js';
import {functionsOf,type FunctionSite} from './symbol-sites.js';
import type {TreeText} from './source.js';
import {httpModels,type HttpModel,type HttpRole,type HttpParameterType} from '../library-models/http-models.js';
export interface HttpRegistrationFact {readonly span:SourceSpan;readonly path:string;readonly method:string;readonly handler?:FunctionSite;readonly handlerExpression?:string;readonly receiverExpression:string;readonly ports:readonly string[]}
const contains=(a:SourceSpan,b:SourceSpan):boolean=>a.path===b.path&&a.byteStart<=b.byteStart&&b.byteEnd<=a.byteEnd;
const same=(a:SourceSpan,b:SourceSpan):boolean=>contains(a,b)&&contains(b,a);
const unique=<T>(items:readonly T[]):T|undefined=>items.length===1?items[0]:undefined;
class HttpFacts {
 private readonly expressions=new Map<string,CodeExpressionFact>();
 private readonly bindings=new Map<string,CodeBindingFact>();
 private readonly imports=new Map<string,CodeImportFact>();
 private readonly calls=new Map<string,CodeCallFact>();
 private readonly written=new Set<string>();
 private readonly validSites=new Map<string,readonly FunctionSite[]>();
 constructor(private readonly t:TreeText){
  const index=<T>(items:readonly T[],key:(item:T)=>string,target:Map<string,T>):void=>{const duplicates=new Set<string>();for(const item of items){const id=key(item);if(target.has(id)||duplicates.has(id)){target.delete(id);duplicates.add(id);}else target.set(id,item);}};
  index(t.facts?.expressions??[],x=>x.id,this.expressions);index(t.facts?.bindings??[],x=>x.id,this.bindings);index(t.facts?.imports??[],x=>x.id,this.imports);index(t.facts?.calls??[],x=>x.expression,this.calls);
  const mark=(id:string,seen=new Set<string>()):void=>{if(seen.has(id))return;seen.add(id);const expression=this.expressions.get(id);if(expression===undefined)return;if(expression.bindingId!==undefined)this.written.add(expression.bindingId);for(const child of expression.children)mark(child,seen);};
  for(const expression of this.expressions.values()){
   if(['assignment_expression','augmented_assignment_expression','assignment_statement'].includes(expression.syntaxKind))for(const id of expression.fields.left??[])mark(id);
   else if(['update_expression','inc_statement','dec_statement'].includes(expression.syntaxKind))for(const id of expression.children)mark(id);
  }
 }
 private expression(id:string):CodeExpressionFact|undefined{const x=this.expressions.get(id);return x!==undefined&&x.path===x.span.path&&this.t.facts?.files.some(file=>file.path===x.path&&file.parsed)?x:undefined;}
 private field(x:CodeExpressionFact,name:string):CodeExpressionFact|undefined{const id=unique(x.fields[name]??[]);const child=id===undefined?undefined:this.expression(id);return child!==undefined&&x.children.includes(child.id)&&contains(x.span,child.span)?child:undefined;}
 private children(x:CodeExpressionFact):CodeExpressionFact[]|undefined{const children=x.children.map(id=>this.expression(id));return children.some(child=>child===undefined||!contains(x.span,child.span))?undefined:(children as CodeExpressionFact[]).filter(child=>child.syntaxKind!=='comment');}
 private binding(x:CodeExpressionFact):CodeBindingFact|undefined{const binding=x.bindingId===undefined?undefined:this.bindings.get(x.bindingId);return binding!==undefined&&binding.path===x.path&&contains(binding.scope,x.span)&&!this.written.has(binding.id)&&(binding.kind!=='local'||binding.span.byteStart<=x.span.byteStart)?binding:undefined;}
 private importedTarget(imported:CodeImportFact):CodeExpressionFact|undefined{
  if(imported.typeOnly||imported.targetPath===undefined||imported.targetExpression===undefined)return undefined;
  const name=imported.imported.form==='named'?imported.imported.name:imported.imported.form==='default'?'default':undefined;const chain=imported.targetChain??[];
  if(name===undefined||chain.length===0||new Set(chain).size!==chain.length)return undefined;
  const exports=this.t.facts?.exports??[];const proof=chain.map(id=>unique(exports.filter(entry=>entry.id===id)));
  if(proof.some(entry=>entry===undefined||entry.typeOnly||exports.filter(other=>other.path===entry.path&&other.name===entry.name).length!==1))return undefined;
  const first=proof[0];const last=proof.at(-1);const target=this.expression(imported.targetExpression);
  if(first?.path!==imported.targetPath||first.name!==name||last===undefined||target===undefined||last.path!==target.path)return undefined;
  if(!proof.every((entry,index)=>index===0||proof[index-1]?.reexport?.targetPath===entry?.path&&proof[index-1]?.reexport?.name===entry?.name))return undefined;
  const endpoint=last.expression===target.id&&last.localBinding===undefined&&last.reexport===undefined||last.expression===undefined&&last.reexport===undefined&&last.localBinding!==undefined&&last.localBinding===target.bindingId&&this.bindings.get(last.localBinding)?.path===last.path;
  return endpoint?target:undefined;
 }
 /** Follow only lexical bindings and explicit shared export proofs. */
 private unwrap(id:string,seen=new Set<string>()):CodeExpressionFact|undefined{
  if(seen.has(id)||seen.size>80)return undefined;seen.add(id);const x=this.expression(id);if(x===undefined)return undefined;
  if(x.bindingId!==undefined){const binding=this.binding(x);if(binding===undefined)return undefined;
   if(binding.kind==='local'&&binding.initializer!==undefined)return this.unwrap(binding.initializer,seen);
   if(binding.kind==='import'&&binding.importId!==undefined){const imported=this.imports.get(binding.importId);if(imported===undefined||imported.typeOnly||imported.path!==x.path)return undefined;if(imported.targetPath!==undefined){const target=this.importedTarget(imported);return target===undefined?undefined:this.unwrap(target.id,seen);}}
  }
  if(['parenthesized_expression','literal_element','expression_list'].includes(x.syntaxKind)){const child=unique(this.children(x)??[]);return child===undefined?undefined:this.unwrap(child.id,seen);}return x;
 }
 private call(id:string):CodeCallFact|undefined{const x=this.expression(id);const call=this.calls.get(id);if(x===undefined||call===undefined||!same(call.span,x.span)||x.callee!==call.callee||JSON.stringify(x.arguments??[])!==JSON.stringify(call.arguments)||!x.children.includes(call.callee))return undefined;return call.arguments.some(id=>{const argument=this.expression(id);return argument===undefined||!contains(call.span,argument.span);})?undefined:call;}
 private external(id:string,seen=new Set<string>()):{package:string;path:readonly string[]}|undefined{
  if(seen.has(id))return undefined;seen.add(id);const x=this.unwrap(id);if(x===undefined)return undefined;
  if(x.receiver!==undefined&&x.member!==undefined){const receiver=this.expression(x.receiver);if(receiver===undefined||!contains(x.span,receiver.span)||!x.children.includes(receiver.id))return undefined;const origin=this.external(receiver.id,seen);return origin===undefined?undefined:{...origin,path:[...origin.path,x.member]};}
  const binding=this.binding(x);const imported=binding?.importId===undefined?undefined:this.imports.get(binding.importId);
  if(binding?.kind!=='import'||imported===undefined||imported.targetPath!==undefined||imported.typeOnly||imported.path!==x.path)return undefined;
  return {package:imported.specifier,path:imported.imported.form==='named'?[imported.imported.name]:imported.imported.form==='default'?['default']:[]};
 }
 private sites(path:string):readonly FunctionSite[]{let sites=this.validSites.get(path);if(sites===undefined){sites=functionsOf(this.t,path);this.validSites.set(path,sites);}return sites;}
 private canonical(key:string):FunctionSite|undefined{const symbol=unique((this.t.facts?.symbols??[]).filter(x=>x.key===key&&x.callable));return symbol===undefined?undefined:unique(this.sites(symbol.path).filter(site=>site.key===key&&same(site.span,symbol.span)));}
 private owner(span:SourceSpan):FunctionSite|undefined{const raw=(this.t.facts?.symbols??[]).filter(x=>x.callable&&x.path===span.path&&x.span.byteStart<=span.byteStart&&span.byteStart<x.span.byteEnd).sort((a,b)=>a.span.byteEnd-a.span.byteStart-(b.span.byteEnd-b.span.byteStart));const first=raw[0];if(first===undefined||raw[1]!==undefined&&same(first.span,raw[1].span)||first.bodySpan===undefined||!contains(first.bodySpan,span))return undefined;return this.canonical(first.key);}
 private target(callee:CodeExpressionFact):FunctionSite|undefined{
  const targets=[...new Set((this.t.facts?.sites??[]).filter(site=>site.use==='call'&&contains(callee.span,site.span)).map(site=>site.to))];const sites=targets.map(key=>this.canonical(key)).filter((site):site is FunctionSite=>site!==undefined);
  if(sites.length===1){
   const site=sites[0]!;
   if(callee.bindingId!==undefined){const binding=this.binding(callee);if(binding===undefined||binding.kind==='parameter'||binding.kind==='receiver')return undefined;if(binding.kind==='import'){const imported=binding.importId===undefined?undefined:this.imports.get(binding.importId);if(imported===undefined||this.importedTarget(imported)===undefined)return undefined;}else if(binding.initializer===undefined&&!contains(site.span,binding.span))return undefined;}
   if(site.receiverType!==undefined&&!this.methodReceiver(callee,site))return undefined;
   return site;
  }
  const value=this.unwrap(callee.id);return value===undefined?undefined:unique(this.sites(value.path).filter(site=>same(site.span,value.span)));
 }
 /** Resolve a direct declared Go type, never a spelling or alias. */
 private declaredType(raw:CodeExpressionFact):{binding:CodeBindingFact;pointer:boolean}|undefined{
  const pointer=raw.syntaxKind==='pointer_type';const type=pointer?unique(this.children(raw)??[]):raw;
  if(type?.syntaxKind!=='type_identifier')return undefined;const binding=this.binding(type);const proof=binding?.typeDeclaration;
  if(binding?.kind!=='type'||proof?.shape!=='struct')return undefined;
  const declaration=this.expression(proof.expression);const name=this.expression(proof.nameExpression);const body=this.expression(proof.typeExpression);const scope=this.expression(proof.scopeExpression);
  if(declaration?.syntaxKind!=='type_spec'||name===undefined||body?.syntaxKind!=='struct_type'||scope===undefined||!same(declaration.span,proof.declarationSpan)||!same(scope.span,binding.scope)||!contains(scope.span,type.span)||type.span.byteStart<proof.scopeStart||!same(name.span,binding.span)||this.field(declaration,'name')?.id!==name.id||this.field(declaration,'type')?.id!==body.id||!contains(declaration.span,name.span)||!contains(declaration.span,body.span))return undefined;
  return {binding,pointer};
 }
 private parameterType(binding:CodeBindingFact):CodeExpressionFact|undefined{
  const parameter=unique([...this.expressions.values()].filter(expression=>expression.syntaxKind==='parameter_declaration'&&contains(expression.span,binding.span)&&(expression.fields.name??[]).some(id=>{const name=this.expression(id);return name?.bindingId===binding.id&&same(name.span,binding.span);})));
  return parameter===undefined?undefined:this.field(parameter,'type');
 }
 private receiverType(site:FunctionSite):{binding:CodeBindingFact;pointer:boolean}|undefined{
  const symbol=unique((this.t.facts?.symbols??[]).filter(symbol=>symbol.key===site.key));const receiver=symbol?.receiver;
  const binding=receiver===undefined?undefined:this.bindings.get(receiver.bindingId);
  if(binding===undefined||!['receiver','parameter'].includes(binding.kind)||binding.path!==site.path||!contains(binding.scope,site.span)||receiver?.name!==binding.name)return undefined;
  const type=this.parameterType(binding);return type===undefined?undefined:this.declaredType(type);
 }
 /** Field sites must prove both the exact declaration and its receiver type. */
 private valueType(id:string,seen=new Set<string>()):{binding:CodeBindingFact;pointer:boolean}|undefined{
  if(seen.has(id)||seen.size>80)return undefined;seen.add(id);const value=this.unwrap(id);if(value===undefined)return undefined;
  const binding=this.binding(value);
  if(binding?.kind==='parameter'||binding?.kind==='receiver'){const type=this.parameterType(binding);return type===undefined?undefined:this.declaredType(type);}
  if(value.receiver!==undefined&&value.member!==undefined){
   const property=this.field(value,'field');if(property===undefined||property.name!==value.member)return undefined;
   const sites=(this.t.facts?.sites??[]).filter(site=>site.use==='reference'&&same(site.span,property.span));const target=unique([...new Set(sites.map(site=>site.to))]);
   const field=target===undefined?undefined:unique((this.t.facts?.fields??[]).filter(field=>field.key===target));
   const owner=this.valueType(value.receiver,seen);const raw=field===undefined?undefined:this.expression(field.typeExpression);const declaration=field===undefined?undefined:this.expression(field.ownerDeclaration);
   const symbol=field===undefined?undefined:unique((this.t.facts?.symbols??[]).filter(symbol=>symbol.key===field.key&&!symbol.callable));
   if(field===undefined||owner===undefined||raw===undefined||declaration?.syntaxKind!=='type_spec'||symbol===undefined||symbol.path!==field.path||!contains(symbol.span,field.span)||field.name!==value.member||field.ownerDeclaration!==owner.binding.typeDeclaration?.expression||!contains(declaration.span,field.span)||!contains(declaration.span,raw.span))return undefined;
   const fieldDeclaration=unique([...this.expressions.values()].filter(expression=>expression.syntaxKind==='field_declaration'&&contains(declaration.span,expression.span)&&contains(expression.span,field.span)&&this.field(expression,'type')?.id===raw.id&&(expression.fields.name??[]).some(id=>{const name=this.expression(id);return name!==undefined&&same(name.span,field.span);} )));
   return fieldDeclaration===undefined?undefined:this.declaredType(raw);
  }
  return undefined;
 }
 private importedType(raw:CodeExpressionFact,packageName:string,expected:HttpParameterType):boolean{
  const pointer=raw.syntaxKind==='pointer_type';const type=pointer?unique(this.children(raw)??[]):raw;
  if(pointer!==expected.pointer||type===undefined)return false;const origin=this.external(type.id);
  return origin?.package===packageName&&JSON.stringify(origin.path)===JSON.stringify(expected.path);
 }
 private signature(site:FunctionSite,model:HttpModel,method:boolean):boolean{
  const effect=model.effect;if(effect.kind!=='handler'||site.language!=='go')return false;
  const declaration=unique([...this.expressions.values()].filter(expression=>same(expression.span,site.span)&&(method?expression.syntaxKind===effect.declarationKind:effect.functionDeclarationKinds.includes(expression.syntaxKind))));
  if(declaration===undefined||(declaration.fields.result??[]).length!==0)return false;
  const list=this.field(declaration,'parameters');const parameters=list===undefined?undefined:this.children(list);
  if(parameters===undefined||parameters.length!==effect.parameters.length)return false;
  return parameters.every((parameter,index)=>{const type=this.field(parameter,'type');return parameter.syntaxKind==='parameter_declaration'&&(parameter.fields.name??[]).length<=1&&type!==undefined&&this.importedType(type,model.package,effect.parameters[index]!);});
 }
 /** A Go method receiver must have the exact direct constructor result type. */
 private methodReceiver(callee:CodeExpressionFact,site:FunctionSite):boolean{
  if(callee.receiver===undefined)return false;const actual=this.valueType(callee.receiver);const expected=this.receiverType(site);if(actual!==undefined&&expected!==undefined)return actual.binding.id===expected.binding.id&&(!expected.pointer||actual.pointer);const receiver=this.unwrap(callee.receiver);if(receiver===undefined)return false;
  const call=this.call(receiver.id);const constructor=call===undefined?undefined:this.expression(call.callee);if(constructor===undefined)return false;
  const target=this.target(constructor);if(target===undefined||target.receiverType!==undefined)return false;
  let result=this.returned(target);if(result?.syntaxKind==='unary_expression')result=this.field(result,'operand');
  if(result?.syntaxKind!=='composite_literal')return false;const returnedType=this.field(result,'type');if(returnedType===undefined)return false;
  const declared=(this.t.facts?.symbols??[]).find(symbol=>symbol.key===site.key)?.receiver;
  const binding=declared===undefined?undefined:this.bindings.get(declared.bindingId);if(binding===undefined)return false;
  const parameter=unique([...this.expressions.values()].filter(expression=>expression.syntaxKind==='parameter_declaration'&&contains(expression.span,binding.span)));
  let receiverType=parameter===undefined?undefined:this.field(parameter,'type');
  if(receiverType?.syntaxKind==='pointer_type')receiverType=unique(this.children(receiverType)??[]);
  return returnedType.bindingId!==undefined&&receiverType?.bindingId===returnedType.bindingId&&this.bindings.get(returnedType.bindingId)?.kind==='type';
 }
 private returned(site:FunctionSite):CodeExpressionFact|undefined{
  const returns=[...this.expressions.values()].filter(x=>x.syntaxKind==='return_statement'&&contains(site.span,x.span)&&this.owner(x.span)?.key===site.key);const statement=unique(returns);if(statement===undefined)return undefined;
  const owner=(this.t.facts?.symbols??[]).find(symbol=>symbol.key===site.key);if(owner?.bodySpan===undefined)return undefined;
  let node=statement;const seen=new Set<string>();
  while(!same(node.span,owner.bodySpan)){
   if(seen.has(node.id))return undefined;seen.add(node.id);
   const parent=unique([...this.expressions.values()].filter(expression=>expression.children.includes(node.id)));
   if(parent===undefined||!['statement_block','block','statement_list'].includes(parent.syntaxKind)||!contains(owner.bodySpan,parent.span))return undefined;node=parent;
  }
  return unique(this.children(statement)??[]);
 }
 private exportedModels(id:string):readonly HttpModel[]{const imported=this.external(id);const expression=this.expression(id);const language=this.t.facts?.files.find(file=>file.path===expression?.path)?.language;const ecosystem=language===undefined?undefined:language==='go'?'go':'node';return imported===undefined?[]:httpModels.filter(model=>model.target.kind==='export'&&model.ecosystem===ecosystem&&model.package===imported.package&&model.target.paths.some(path=>JSON.stringify(path)===JSON.stringify(imported.path)));}
 private origin(id:string,seen=new Set<string>()):{id:string;package:string;role:HttpRole}|undefined{
  if(seen.has(id)||seen.size>80)return undefined;seen.add(id);const value=this.unwrap(id);if(value===undefined)return undefined;const registry=unique(this.exportedModels(value.id).filter(model=>model.effect.kind==='registry'));if(registry?.effect.kind==='registry')return this.defaultOrigin(registry.package,registry.effect.role,value.path);const call=this.call(value.id);const callee=call===undefined?undefined:this.expression(call.callee);if(call===undefined||callee===undefined)return undefined;
  const model=unique(this.exportedModels(callee.id).filter(model=>model.effect.kind==='factory'));
  if(model?.effect.kind==='factory')return {id:value.id,package:model.package,role:model.effect.role};
  const target=this.target(callee);const result=target===undefined?undefined:this.returned(target);return result===undefined?undefined:this.origin(result.id,seen);
 }
 /** A process-global registry is only joined within its proved source unit; no process graph is inferred. */
 private defaultOrigin(packageName:string,role:HttpRole,path:string):{id:string;package:string;role:HttpRole}{return {id:JSON.stringify(['http-default-registry',packageName,role,path]),package:packageName,role};}
 private defaultModelOrigin(model:HttpModel,path:string):{id:string;package:string;role:HttpRole}|undefined{return 'defaultReceiver' in model.effect&&model.effect.defaultReceiver!==undefined?this.defaultOrigin(model.package,model.effect.defaultReceiver,path):undefined;}
 private listenerOrigin(handler:string|undefined,model:HttpModel,path:string):{id:string;package:string;role:HttpRole}|undefined{
  if(handler===undefined)return this.defaultModelOrigin(model,path);const value=this.unwrap(handler);
  return value?.literal?.kind==='null'?this.defaultModelOrigin(model,path):this.origin(handler);
 }
 private registrationOrigin(call:CodeCallFact,model:HttpModel):{id:string;package:string;role:HttpRole}|undefined{return this.defaultModelOrigin(model,call.path)??(this.member(call)?.receiver===undefined?undefined:this.origin(this.member(call)!.receiver!));}
 private models(call:CodeCallFact):readonly HttpModel[]{
  const exported=this.exportedModels(call.callee);const member=this.member(call);const receiver=member?.receiver===undefined?undefined:this.origin(member.receiver);
  return [...exported,...(receiver===undefined?[]:httpModels.filter(model=>model.target.kind==='member'&&model.package===receiver.package&&model.target.roles.includes(receiver.role)&&model.target.members.includes(member?.member??'')))];
 }
 private value(id:string):string|number|undefined{const value=this.unwrap(id)?.literal?.value;return typeof value==='string'||typeof value==='number'?value:undefined;}
 private port(id:string,address=false):string|undefined{const value=this.value(id);if(!address)return typeof value==='number'&&Number.isInteger(value)&&value>0&&value<=65535?String(value):undefined;if(typeof value!=='string')return undefined;const port=value.slice(value.lastIndexOf(':')+1);const parsed=Number(port);return port!==''&&Number.isInteger(parsed)&&parsed>0&&parsed<=65535&&String(parsed)===port?port:undefined;}
 private member(call:CodeCallFact):CodeExpressionFact|undefined{const callee=this.expression(call.callee);return callee?.receiver!==undefined&&callee.member!==undefined&&callee.children.includes(callee.receiver)?callee:undefined;}
 private server(id:string):{value:CodeExpressionFact;model:HttpModel}|undefined{let value=this.unwrap(id);if(value?.syntaxKind==='unary_expression'){const operand=this.field(value,'operand');value=operand===undefined?undefined:this.unwrap(operand.id);}if(value?.syntaxKind!=='composite_literal')return undefined;const type=this.field(value,'type');const model=type===undefined?undefined:unique(this.exportedModels(type.id).filter(model=>model.effect.kind==='server'));return model===undefined?undefined:{value,model};}
 private serverFields(server:CodeExpressionFact):ReadonlyMap<string,CodeExpressionFact>|undefined{
  const body=this.field(server,'body');if(body?.syntaxKind!=='literal_value')return undefined;const pairs=this.children(body);if(pairs===undefined)return undefined;const result=new Map<string,CodeExpressionFact>();
  for(const pair of pairs){if(pair.syntaxKind!=='keyed_element')return undefined;const parts=this.children(pair);if(parts?.length!==2)return undefined;const keyWrapper=parts[0]!;const valueWrapper=parts[1]!;const key=unique(this.children(keyWrapper)??[]);const value=unique(this.children(valueWrapper)??[]);if(keyWrapper.syntaxKind!=='literal_element'||valueWrapper.syntaxKind!=='literal_element'||key?.name===undefined||value===undefined||result.has(key.name))return undefined;result.set(key.name,value);}return result;
 }
 /** Traverse only explicit mount edges between proved receiver identities. */
 ports(receiver:string,wanted=this.origin(receiver)):string[]{
  if(wanted===undefined)return [];const reachable=new Set([wanted.id]);const listeners:{origin:string;port:string}[]=[];const mounts:{child:string;parent:string}[]=[];
  for(const raw of this.calls.values()){
   const call=this.call(raw.expression);if(call===undefined)continue;const member=this.member(call);const receiverOrigin=member?.receiver===undefined?undefined:this.origin(member.receiver);
   for(const model of this.models(call)){
    const effect=model.effect;
    if(effect.kind==='listen'){
     const address=call.arguments[effect.portArgument];const handler=effect.handlerArgument===undefined?undefined:call.arguments[effect.handlerArgument];
     const origin=effect.handlerArgument===undefined?receiverOrigin:handler===undefined?undefined:this.listenerOrigin(handler,model,call.path);
     const port=address===undefined?undefined:this.port(address,effect.portFormat==='address');if(origin!==undefined&&port!==undefined)listeners.push({origin:origin.id,port});
    }
    if(effect.kind==='mount'&&receiverOrigin!==undefined)for(const argument of call.arguments.slice(effect.argumentsFrom)){const child=this.origin(argument);if(child!==undefined)mounts.push({child:child.id,parent:receiverOrigin.id});}
   }
   if(member?.receiver!==undefined){const server=this.server(member.receiver);const effect=server?.model.effect;
    if(server!==undefined&&effect?.kind==='server'&&member.member===effect.listenMember){const fields=this.serverFields(server.value);const address=fields?.get(effect.addressField);const handler=fields?.get(effect.handlerField);const port=address===undefined?undefined:this.port(address.id,true);const origin=fields===undefined?undefined:this.listenerOrigin(handler?.id,server.model,server.value.path);if(port!==undefined&&origin!==undefined)listeners.push({origin:origin.id,port});}
   }
  }
  let changed=true;while(changed){changed=false;for(const mount of mounts)if(reachable.has(mount.child)&&!reachable.has(mount.parent)){reachable.add(mount.parent);changed=true;}}
  return [...new Set(listeners.filter(listener=>reachable.has(listener.origin)).map(listener=>listener.port))].sort(byCodePoint);
 }
 private handler(id:string,seen=new Set<string>()):FunctionSite|undefined{
  if(seen.has(id)||seen.size>80)return undefined;seen.add(id);const value=this.unwrap(id);if(value===undefined)return undefined;
  const language=this.t.facts?.files.find(file=>file.path===value.path)?.language;
  const signatures=httpModels.filter(model=>model.effect.kind==='handler'&&model.ecosystem===language);
  let direct=this.target(value);
  if(direct===undefined&&['identifier','selector_expression','member_expression'].includes(value.syntaxKind)){
   const property=value.receiver===undefined?value:this.field(value,value.syntaxKind==='selector_expression'?'field':'property');
   const keys=property===undefined?[]:[...new Set((this.t.facts?.sites??[]).filter(site=>site.use==='reference'&&same(site.span,property.span)).map(site=>site.to))];
   const candidate=keys.length===1?this.canonical(keys[0]!):undefined;const binding=value.bindingId===undefined?undefined:this.binding(value);
   const imported=binding?.kind==='import'&&binding.importId!==undefined?this.imports.get(binding.importId):undefined;
   const bound=value.bindingId===undefined||binding!==undefined&&binding.kind!=='parameter'&&binding.kind!=='receiver'&&(binding.kind!=='import'||imported!==undefined&&this.importedTarget(imported)!==undefined);
   if(candidate!==undefined&&bound&&(candidate.receiverType===undefined||this.methodReceiver(value,candidate)))direct=candidate;
  }
  if(direct!==undefined){if(language!=='go')return direct;return signatures.some(model=>this.signature(direct,model,direct.receiver!==undefined))?direct:undefined;}
  const call=this.call(value.id);
  if(call!==undefined){const adapter=unique(this.exportedModels(call.callee).filter(model=>model.effect.kind==='handler-adapter'));if(adapter?.effect.kind==='handler-adapter'&&call.arguments.length===1){const argument=call.arguments[adapter.effect.argument];return argument===undefined?undefined:this.handler(argument,seen);}}
  if(language!=='go')return undefined;const type=this.valueType(value.id);if(type===undefined)return undefined;
  const candidates:FunctionSite[]=[];
  for(const model of signatures){if(model.effect.kind!=='handler')continue;for(const symbol of this.t.facts?.symbols??[]){
   if(!symbol.callable||symbol.name!==model.effect.member)continue;const site=this.canonical(symbol.key);if(site===undefined)continue;
   const receiver=this.receiverType(site);if(receiver===undefined||receiver.binding.id!==type.binding.id||receiver.pointer&&!type.pointer||!this.signature(site,model,true))continue;candidates.push(site);
  }}
  return unique(candidates);
 }
 registrations():HttpRegistrationFact[]{
  const result:HttpRegistrationFact[]=[];
  for(const raw of this.calls.values()){
   const call=this.call(raw.expression);if(call===undefined)continue;const member=this.member(call);
   const model=unique(this.models(call).filter(model=>model.effect.kind==='route'));if(model?.effect.kind!=='route')continue;const effect=model.effect;
   const receiver=member?.receiver;if(receiver===undefined)continue;const origin=this.registrationOrigin(call,model);
   const first=call.arguments[effect.pathArgument];const literal=first===undefined?undefined:this.value(first);if(typeof literal!=='string')continue;
   let path=literal;let method=(member?.member??'').toUpperCase();
   if(effect.method==='pattern'){const split=literal.indexOf(' ');method=split<0?'':literal.slice(0,split);path=split<0?literal:literal.slice(split+1);}
   if(!path.startsWith('/'))continue;
   const handlerId=effect.handlerArgument===-1?call.arguments.at(-1):call.arguments[effect.handlerArgument];const handler=handlerId===undefined?undefined:this.handler(handlerId);
   const ports=origin===undefined?[]:this.ports(receiver,origin);if(this.defaultModelOrigin(model,call.path)!==undefined&&ports.length===0)this.t.factGap(call.path,`line ${call.span.lineStart}: default registry receiver/listener proof is limited to its declaring file; cross-file process ownership is unsupported (${call.path})`);
   result.push({span:call.span,path,method,receiverExpression:receiver,ports,...(handlerId===undefined?{}:{handlerExpression:handlerId}),...(handler===undefined?{}:{handler})});
  }
  return result.sort((a,b)=>byCodePoint(a.span.path,b.span.path)||a.span.byteStart-b.span.byteStart);
 }
 routePorts(span:SourceSpan):string[]{
  const call=unique([...this.calls.values()].filter(call=>same(call.span,span)));if(call===undefined)return [];
  const valid=this.call(call.expression);const member=valid===undefined?undefined:this.member(valid);
  const model=valid===undefined?undefined:unique(this.models(valid).filter(model=>model.effect.kind==='route'));const origin=valid===undefined||model===undefined?undefined:this.registrationOrigin(valid,model);
  return member?.receiver===undefined||origin===undefined?[]:this.ports(member.receiver,origin);
 }
}
export function structuralHttpRegistrations(t:TreeText):readonly HttpRegistrationFact[]{
 if(t.facts===undefined){t.factGap('.','line 1: HTTP registrations require shared resolved code facts');return [];}
 return new HttpFacts(t).registrations();
}
export function routeListenerPorts(t:TreeText,span:SourceSpan):string[]{
 if(t.facts===undefined){t.factGap(span.path,`line ${span.lineStart}: route receiver/listener association requires shared resolved code facts (${span.path})`);return [];}
 const ports=new HttpFacts(t).routePorts(span);
 if(ports.length===0)t.factGap(span.path,`line ${span.lineStart}: route receiver/listener association has no complete immutable proof (${span.path})`);
 return ports;
}
