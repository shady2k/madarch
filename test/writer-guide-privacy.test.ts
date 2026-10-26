import { expect, test } from 'bun:test';
import { recordOf } from '../src/writer/journal.js';

test('guide journal privacy suppresses tool names, arguments, results and refusal details',()=>{
 const privateValue='private"credential';
 const context={run:'run-test',unit:'administrator-guide:main',agent:'scripted',model:null,session:null,privateGuide:true};
 const record=recordOf(context,{kind:'refusal',tool:privateValue,arguments:{value:privateValue},response:privateValue,isError:true,outcome:'rejected',reason:privateValue,startedAt:new Date('2026-04-01T00:00:00Z'),durationMs:0});
 expect(JSON.stringify(record)).not.toContain(privateValue);expect(record.arguments).toEqual({redacted:true});expect(record.response).toBe('[guide result withheld]');
 const ordinary=recordOf({...context,privateGuide:false},{kind:'tool-call',tool:'get_node',arguments:{key:'neutral'},response:'kept',isError:false,outcome:'ok',reason:null,startedAt:new Date('2026-04-01T00:00:00Z'),durationMs:0});
 expect(ordinary.tool).toBe('get_node');expect(ordinary.response).toBe('kept');
});
