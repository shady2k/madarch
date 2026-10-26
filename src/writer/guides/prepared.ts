/** Per-prepared-unit pagination: no scheduler and no second publication authority. */
import type { GuidePreparedUnit } from './host-contract.js';
import { guideDigest } from './digest.js';
import { GuidePreparationError } from './preparation-error.js';

export const GUIDE_PACKET_BYTES = 16 * 1024;
export interface GuideContextPage {
  readonly inputDigest: string;
  readonly index: number;
  readonly total: number;
  readonly cursor: string;
  readonly next: string | null;
  readonly entries: readonly unknown[];
  readonly coverage: { readonly seen: number; readonly total: number; readonly complete: boolean };
}
interface Pages { readonly digest: string; readonly packets: readonly (readonly unknown[])[]; readonly seen: Set<number> }
const pages = new WeakMap<GuidePreparedUnit, Pages>();
/** Stable input order comes from the complete canonical preparation, never agent-selected fields. */
export function registerGuidePages(unit: GuidePreparedUnit, inputDigest: string, entries: readonly unknown[]): void {
  const packets: unknown[][] = [];let packet: unknown[] = [];
  for (const entry of entries) {
    if (Buffer.byteLength(JSON.stringify([entry])) > GUIDE_PACKET_BYTES) {
      const fact = entry !== null && typeof entry === 'object' && 'type' in entry && entry.type === 'fact' && 'value' in entry && entry.value !== null && typeof entry.value === 'object' && 'id' in entry.value && typeof entry.value.id === 'string' ? entry.value.id : undefined;
      throw Object.assign(new GuidePreparationError({stage:'context-packets',code:'bound',file:'src/writer/guides/prepared.ts',line:22,...(fact===undefined?{}:{fact})}),{message:'guide prepared-context entry exceeds the packet bound; it was not shortened'});
    }
    if (packet.length > 0 && Buffer.byteLength(JSON.stringify([...packet,entry])) > GUIDE_PACKET_BYTES) { packets.push(packet);packet=[]; }
    packet.push(entry);
  }
  if(packet.length>0||packets.length===0)packets.push(packet);
  pages.set(unit,{digest:inputDigest,packets,seen:new Set()});
}
const cursorOf = (state: Pages,index:number):string => `${index}:${guideDigest({input:state.digest,index})}`;
export function firstGuideCursor(unit:GuidePreparedUnit):string|undefined {const state=pages.get(unit);return state===undefined?undefined:cursorOf(state,0);}
export function guidePagesComplete(unit:GuidePreparedUnit):boolean {const state=pages.get(unit);return state===undefined||state.seen.size===state.packets.length;}
export function readGuidePageContext(unit:GuidePreparedUnit,cursor:unknown):GuideContextPage|undefined {
  const state=pages.get(unit);if(state===undefined||typeof cursor!=='string')return undefined;
  const index=state.packets.findIndex((_,i)=>cursorOf(state,i)===cursor);
  if(index<0||index>0&&!state.seen.has(index-1))return undefined;
  state.seen.add(index);
  return {inputDigest:state.digest,index,total:state.packets.length,cursor,next:index+1<state.packets.length?cursorOf(state,index+1):null,entries:state.packets[index]!,coverage:{seen:state.seen.size,total:state.packets.length,complete:state.seen.size===state.packets.length}};
}

export function guidePageCount(unit:GuidePreparedUnit):number{return pages.get(unit)?.packets.length??0;}

// Set by the production host only after it checks complete current evidence, durable proof and exact materialized bytes.
const current = new WeakMap<GuidePreparedUnit,string>();
export function markGuideCurrent(unit:GuidePreparedUnit,path:string):void {current.set(unit,path);}
export function currentGuidePath(unit:GuidePreparedUnit):string|undefined {return current.get(unit);}
