import { expect, test } from 'bun:test';
import { firstGuideCursor, guidePagesComplete, readGuidePageContext, registerGuidePages, GUIDE_PACKET_BYTES } from '../src/writer/guides/prepared.js';
import type { GuidePreparedUnit } from '../src/writer/guides/host-contract.js';
import { UnitTools } from '../src/writer/tools.js';
import { memorySink } from '../src/writer/run.js';
import type { GraphView } from '../src/writer/view.js';
import { guideDigest } from '../src/writer/guides/digest.js';
function fixture():GuidePreparedUnit {return {prompt:'bounded context',validation:{file:'/product/docs/guides/user.md',expectedContext:{valid:'2026-01-01T00:00:00Z',known:'2026-01-02T00:00:00Z',state:'0',repositories:[{name:'sample',commit:'a'.repeat(40)}]},expectedInputDigest:'b'.repeat(64),expectedUnitVersion:'1',containsSecret:()=>false,verifyStep:async()=>[]},publishChecked:async()=>({ok:true,path:'docs/guides/user.md',unchanged:false})};}
test('prepared context pages are bounded, deterministic and complete with explicit final cursor',()=>{
 const entries=Array.from({length:9},(_,index)=>({index,text:'x'.repeat(5000)}));const digest=guideDigest(entries);const a=fixture();const b=fixture();registerGuidePages(a,digest,entries);registerGuidePages(b,digest,entries);
 expect(firstGuideCursor(a)).toBe(firstGuideCursor(b));expect(guidePagesComplete(a)).toBe(false);
 let cursor:string|null=firstGuideCursor(a)!;const held:unknown[]=[];let count=0;let lastCursor='';
 while(cursor!==null){const page: import('../src/writer/guides/prepared.js').GuideContextPage=readGuidePageContext(a,cursor)!;expect(page.inputDigest).toBe(digest);expect(Buffer.byteLength(JSON.stringify(page.entries))).toBeLessThanOrEqual(GUIDE_PACKET_BYTES);held.push(...page.entries);count++;lastCursor=cursor;cursor=page.next;}
 expect(count).toBeGreaterThan(1);expect(held).toEqual(entries);expect(guidePagesComplete(a)).toBe(true);expect(readGuidePageContext(a,`${lastCursor}:past-final`)).toBeUndefined();expect(readGuidePageContext(a,'1:forged')).toBeUndefined();expect(guidePagesComplete(b)).toBe(false);
});
test('empty prepared input still has one explicit complete coverage page',()=>{const unit=fixture();registerGuidePages(unit,'c'.repeat(64),[]);const page=readGuidePageContext(unit,firstGuideCursor(unit))!;expect(page.entries).toEqual([]);expect(page.next).toBeNull();expect(page.coverage).toEqual({seen:1,total:1,complete:true});});
test('unseen required packet refuses guide publication before payload validation',async()=>{const unit=fixture();registerGuidePages(unit,'d'.repeat(64),[{text:'x'.repeat(10000)},{text:'y'.repeat(10000)}]);const session=new UnitTools({} as GraphView,{kind:'user-guide',id:'user-guide:main',path:'docs/guides/user.md',prepared:unit},memorySink());expect(session.tools.map(x=>x.name)).toEqual(['read_prepared_context','write_guide']);const result=await session.call('write_guide',{guide:{}});expect(result.isError).toBe(true);expect(JSON.stringify(result)).toContain('guide-context-incomplete');expect((await session.call('read_prepared_context',{cursor:'forged'})).isError).toBe(true);});
test('a single oversized entry is refused visibly, never shortened',()=>{expect(()=>registerGuidePages(fixture(),'e'.repeat(64),[{text:'z'.repeat(GUIDE_PACKET_BYTES+1)}])).toThrow('not shortened');});
