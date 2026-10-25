/** Resolve declarations and all edge contributions before publication. No edge origin is first-wins. */
import {byCodePoint} from '../../model/order.js';
import {canonicalJsonDigest} from '../../model/canonical.js';
import type {ExtractedEdge, ExtractedNode, Extraction, PropertyValue} from '../records.js';
export const LINKS_PRODUCER = 'code.extract.links';
export function linkExtractions(extractions: readonly Extraction[], owners: Readonly<Record<string,string>>): {extractions:Extraction[]; keyOwners:ReadonlyMap<string,string>} {
 const declarations = new Map<string,{producer:string;node:ExtractedNode}[]>();
 for (const extraction of extractions) for (const node of extraction.nodes) {
  const held=declarations.get(node.key)??[]; held.push({producer:extraction.producer,node}); declarations.set(node.key,held);
 }
 const keyOwners=new Map<string,string>(); const canonical=new Map<string,ExtractedNode>();
 for (const [key,candidates] of declarations) {
  const preferred=owners[candidates[0]!.node.kind]; const chosen=candidates.find((entry)=>entry.producer===preferred)??candidates[0]!;
  keyOwners.set(key,chosen.producer); canonical.set(key,chosen.node);
 }
 const prepared=extractions.map((extraction):Extraction=>{
  const nodes:ExtractedNode[]=[]; const candidates=[...extraction.edges]; const gaps=[...extraction.gaps];
  for (const node of extraction.nodes) {
   if (keyOwners.get(node.key)===extraction.producer) {nodes.push(node);continue;}
   const held=canonical.get(node.key)!;
   const extra=Object.fromEntries(Object.entries(node.properties).filter(([name])=>!(name in held.properties)));
   for (const [name,value] of Object.entries(node.properties)) if (name in held.properties && canonicalJsonDigest(value)!==canonicalJsonDigest(held.properties[name])) gaps.push({path:node.span?.path??node.key,reason:`line ${node.span?.lineStart??1}: property "${name}" of ${node.key} differs from its declaration by ${keyOwners.get(node.key)}; the owning declaration stands`});
   if (Object.keys(extra).length===0) continue;
   const span=node.span??held.span; const path=node.key.startsWith('code.file:')?node.key.slice('code.file:'.length):span?.path;
   const facet:ExtractedNode={key:`code.facet:${extraction.producer}#${node.key}`,kind:'code.facet',label:path===undefined?node.label:`${node.label} · ${path}`,properties:{...extra,ownerKey:node.key},...(span===undefined?{}:{span})};
   nodes.push(facet);keyOwners.set(facet.key,extraction.producer);
   candidates.push({type:'code.facet-of',from:facet.key,to:node.key,discriminator:'',properties:{}});
   if (path!==undefined) candidates.push({type:'code.describes-file',from:facet.key,to:`code.file:${path}`,discriminator:'',properties:{}});
  }
  return {...extraction,nodes,edges:candidates,gaps};
 });
 interface Contribution {producer:string;edge:ExtractedEdge}
 const groups=new Map<string,Contribution[]>();
 const identity=(edge:ExtractedEdge):string=>JSON.stringify([edge.type,edge.from,edge.to,edge.type==='code.occurrence'?edge.span?.byteStart:edge.discriminator]);
 for (const extraction of prepared) {
  const own=new Map<string,ExtractedEdge>();
  for (const edge of extraction.edges) {
   if(edge.type==='code.occurrence'&&edge.span===undefined) throw new Error(`extract links: ${edge.from}:1: producer ${extraction.producer} emits occurrence without source span`);
   const key=identity(edge);const duplicate=own.get(key);
   if (duplicate!==undefined) throw new Error(`extract links: ${edge.span?.path??edge.from}:${edge.span?.lineStart??1}: producer ${extraction.producer} emits ${edge.type} from ${edge.from} to ${edge.to} (discriminator ${JSON.stringify(edge.discriminator)}) twice; first at ${duplicate.span?.path??duplicate.from}:${duplicate.span?.lineStart??1}`);
   own.set(key,edge);
   const missing=[edge.from,edge.to].filter((end)=>!keyOwners.has(end));
   if (missing.length>0) {
    const span=edge.span??canonical.get(edge.from)?.span;
    (extraction.gaps as Extraction['gaps'][number][]).push({path:span?.path??edge.from,reason:`line ${span?.lineStart??1}: ${edge.type} (${edge.from} -> ${edge.to}) has no declared endpoint ${missing.join(', ')}; no evidence-free reference node is created`});continue;
   }
   const held=groups.get(key)??[];held.push({producer:extraction.producer,edge});groups.set(key,held);
  }
 }
 const byProducer=new Map<string,ExtractedEdge[]>(); const links:ExtractedEdge[]=[]; const linkGaps:Extraction['gaps'][number][]=[];
 for (const contributions of groups.values()) {
  const sorted=[...contributions].sort((a,b)=>byCodePoint(a.producer,b.producer)||byCodePoint(canonicalJsonDigest(a.edge),canonicalJsonDigest(b.edge)));
  const first=sorted[0]!; const edge=first.edge;
  const fromOwner=keyOwners.get(edge.from)!; const toOwner=keyOwners.get(edge.to)!;
  // Ownership follows endpoint declarations, never the changing number/presence of contributions.
  const destination=fromOwner===toOwner?fromOwner:LINKS_PRODUCER;
  if(sorted.length===1&&destination===first.producer&&edge.type!=='code.occurrence') {const held=byProducer.get(destination)??[];held.push(edge);byProducer.set(destination,held);continue;}
  const origins:PropertyValue[]=sorted.map(({producer,edge})=>({sourceProducer:producer,originalDiscriminator:edge.discriminator,sourceSpan:edge.span===undefined?null:{...edge.span},properties:edge.properties}));
  const common=Object.fromEntries(Object.entries(edge.properties).filter(([name,value])=>sorted.every((entry)=>name in entry.edge.properties&&canonicalJsonDigest(entry.edge.properties[name])===canonicalJsonDigest(value))));
  const differing=sorted.some((entry)=>canonicalJsonDigest(entry.edge.properties)!==canonicalJsonDigest(edge.properties));
  if(differing) for(const contribution of sorted.slice(1)) linkGaps.push({path:contribution.edge.span?.path??contribution.edge.from,reason:`line ${contribution.edge.span?.lineStart??1}: parallel declarations of ${edge.type} (${edge.from} -> ${edge.to}) differ between ${first.producer} and ${contribution.producer}; all origin properties are retained`});
  // The store keys occurrences by byte start. Use the longest ACTUAL contributor span (producer order breaks ties); every exact origin remains separate.
  const span=edge.type==='code.occurrence'?[...sorted].sort((a,b)=>(b.edge.span?.byteEnd??0)-(a.edge.span?.byteEnd??0))[0]!.edge.span:edge.span;
  const normalized:ExtractedEdge={...edge,properties:{...common,origins,...(sorted.length===1?{sourceProducer:first.producer}:{})},...(sorted.length===1||edge.type==='code.occurrence'?{...(span===undefined?{}:{span})}:{span:undefined})};
  if(destination===LINKS_PRODUCER) links.push(normalized);
  else {if(!prepared.some((entry)=>entry.producer===destination)) throw new Error(`extract links: ${span?.path??edge.from}:${span?.lineStart??1}: canonical endpoint owner ${destination} has no extraction`);const held=byProducer.get(destination)??[];held.push(normalized);byProducer.set(destination,held);} 
 }
 const order=(a:ExtractedEdge,b:ExtractedEdge)=>byCodePoint(a.type,b.type)||byCodePoint(a.from,b.from)||byCodePoint(a.to,b.to)||byCodePoint(a.discriminator,b.discriminator)||(a.span?.byteStart??0)-(b.span?.byteStart??0);
 return {extractions:[...prepared.map((entry)=>({...entry,edges:(byProducer.get(entry.producer)??[]).sort(order)})),{producer:LINKS_PRODUCER,nodes:[],edges:links.sort(order),gaps:linkGaps}],keyOwners};
}
