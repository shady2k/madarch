import {expect,test} from 'bun:test';
import {evidenceOf} from '../src/graph/graph-writes.js';
test('graph evidence uses its strict shared recursive reference and locator schema',()=>{
 const entry={target:{kind:'snapshot',key:{},uid:'actual-uid',keyEdges:{owner:{kind:'repository',key:{path:'example'}}}},relation:'supports',locator:{path:'file',lineStart:1,lineEnd:2}};
 expect(evidenceOf([entry])).toEqual([entry]);
 for(const bad of [{...entry,unknown:true},{...entry,target:{...entry.target,unknown:true}},{...entry,locator:{unknown:true}},{...entry,locator:{lineStart:2,lineEnd:1}}])expect(()=>evidenceOf([bad])).toThrow('evidence[0]');
});
