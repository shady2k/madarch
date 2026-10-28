import {expect,test} from 'bun:test';
import {truthShotKey,verifyTruthShotSet} from '../scripts/graph-truth-shot-plan.js';
test('same-kind pages have eight distinct filenames each and progress belongs to exact completed set',()=>{
 const pages=['route:a','route:b'];const expected=pages.flatMap((id)=>['en','ru'].flatMap((language)=>[1150,390].flatMap((width)=>['light','dark'].map((scheme)=>truthShotKey('code.route',id,language,width,scheme)))));
 expected.push(...['en','ru'].flatMap((language)=>[1150,390].flatMap((width)=>['light','dark'].map((scheme)=>`truth-rebuild-progress-${language}-${width}-${scheme}`))));expect(expected).toHaveLength(24);expect(new Set(expected).size).toBe(24);expect(()=>verifyTruthShotSet(expected,expected,expected)).not.toThrow();expect(()=>verifyTruthShotSet(expected,expected.slice(8),expected.slice(8))).toThrow('incomplete');expect(()=>verifyTruthShotSet(expected,[...expected,expected[0]!],expected)).toThrow('duplicate');expect(()=>verifyTruthShotSet(expected,expected,[...expected.slice(1),'unplanned'])).toThrow('incomplete');
});

test('walk cleanup closes every owner after failures and forces an owner that never settles',async()=>{
 const {closeWalkResources}=await import('../scripts/graph-truth-shot-plan.js');const calls:string[]=[];const errors:string[]=[];
 await closeWalkResources([{name:'context',close:async()=>{calls.push('context');throw new Error('context failure');}},{name:'browser',close:()=>{calls.push('browser');return new Promise(()=>{});},force:()=>{calls.push('browser-force');}},{name:'server',close:async()=>{calls.push('server');}}],10,(name,error)=>errors.push(`${name}:${String(error)}`));
 expect(calls.sort()).toEqual(['browser','browser-force','context','server']);expect(errors).toHaveLength(2);expect(errors.some((error)=>error.includes('context failure'))).toBe(true);expect(errors.some((error)=>error.includes('cleanup exceeded'))).toBe(true);
});

test('bounded walk lanes preserve every identity/order and propagate failures',async()=>{
 const {walkConcurrent}=await import('../scripts/graph-truth-shot-plan.js');let active=0;let peak=0;const visited:number[]=[];
 const rows=await walkConcurrent(Array.from({length:31},(_,i)=>i),4,async(item)=>{active++;peak=Math.max(peak,active);await Promise.resolve();visited.push(item);active--;return item*2;});expect(peak).toBe(4);expect(visited.sort((a,b)=>a-b)).toEqual(Array.from({length:31},(_,i)=>i));expect(rows).toEqual(Array.from({length:31},(_,i)=>i*2));await expect(walkConcurrent([1,2],4,async()=>{throw new Error('actual failure');})).rejects.toThrow('actual failure');
});
