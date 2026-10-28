import type {TreeReader} from '../src/extract/records.js';
/** Validate the original bytes, not a lossy decoded replacement. End is exclusive. */
export function evidenceError(tree: TreeReader, value: unknown): string | null {
 if (value === null || typeof value !== 'object') return 'no source span';
 const span = value as Record<string, unknown>;
 if (typeof span.path !== 'string' || !tree.paths.includes(span.path)) return 'source path is absent from the audited tree';
 const bytes = tree.read(span.path);
 if (![span.byteStart, span.byteEnd, span.lineStart, span.lineEnd].every((number) => typeof number === 'number' && Number.isSafeInteger(number))) return 'span requires integer byte and line ranges';
 const start = span.byteStart as number; const end = span.byteEnd as number; const first = span.lineStart as number; const last = span.lineEnd as number;
 if (start < 0 || end < start || end > bytes.length || first < 1 || last < first) return 'source span is outside the file';
 const decoder = new TextDecoder('utf-8', {fatal: true});
 try {decoder.decode(bytes); decoder.decode(bytes.subarray(0, start)); decoder.decode(bytes.subarray(start, end));}
 catch {return 'source span is not on UTF-8 character boundaries in valid UTF-8 text';}
 const lineAt = (at: number): number => {let line = 1; for (const byte of bytes.subarray(0, at)) if (byte === 10) line++; return line;};
 const coveredEnd = lineAt(Math.max(start, end - 1));
 const endPosition = lineAt(end);
 if (first !== lineAt(start) || (last !== coveredEnd && last !== endPosition)) return 'source byte and line ranges disagree';
 return null;
}

export function originEvidence(tree: TreeReader, properties: Record<string,unknown>): {index:number;origin:unknown;error:string|null}[] {
 if (!Array.isArray(properties['origins'])) return [];
 return properties['origins'].map((origin,index)=>{
  if (origin===null||typeof origin!=='object') return {index,origin,error:'origin is not an object'};
  const row=origin as Record<string,unknown>;
  const shape=typeof row['sourceProducer']!=='string'||typeof row['originalDiscriminator']!=='string'||row['properties']===null||typeof row['properties']!=='object';
  return {index,origin,error:shape?'origin requires source producer, original discriminator and properties':evidenceError(tree,row['sourceSpan'])};
 });
}


/** Import endpoint aggregation retains distinct actual specifier sites, not a synthetic union. */
export function importReadingEvidence(tree:TreeReader,properties:Record<string,unknown>):{source:string;index:number;reading:unknown;error:string|null}[] {
 const sets:{source:string;value:unknown}[]=[{source:'properties',value:properties['importReadings']}];
 if(Array.isArray(properties['origins']))for(const [index,origin] of properties['origins'].entries()) {
  if(origin!==null&&typeof origin==='object'){const own=(origin as Record<string,unknown>)['properties'];if(own!==null&&typeof own==='object')sets.push({source:`origin:${index}`,value:(own as Record<string,unknown>)['importReadings']});}
 }
 return sets.flatMap(({source,value})=>!Array.isArray(value)?[]:value.map((reading,index)=>({source,index,reading,error:reading===null||typeof reading!=='object'||typeof (reading as Record<string,unknown>)['specifier']!=='string'?'import reading requires specifier and exact span':evidenceError(tree,(reading as Record<string,unknown>)['span'])})));
}

/** Structural membership may be derived from declared identities. Every other
 * relation requires a reading site, even when its missing span is null. */
export const STRUCTURAL_RELATIONS:ReadonlySet<string>=new Set([
 'code.contains','code.declares','code.carries','code.belongs-to','code.member-of',
 'code.cycle-member',
]);
export function edgeEvidenceError(tree:TreeReader,edge:{type:string;evidence:unknown;properties:Record<string,unknown>}):string|null {
 if(Array.isArray(edge.properties.origins)) {
  const origins=originEvidence(tree,edge.properties);
  if(origins.length===0)return 'semantic edge has an empty origin list';
  const errors=origins.filter((origin)=>origin.error!==null);
  return errors[0]?.error??null;
 }
 if(edge.evidence===null&&STRUCTURAL_RELATIONS.has(edge.type))return null;
 return evidenceError(tree,edge.evidence);
}
