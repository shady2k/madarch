import {expect,test,spyOn} from 'bun:test';
import {CommittedLookups,TransactionLookups} from '../src/graph/immutable-lookups.js';

for(const size of [1,10000])test(`lookup and publication copy only touched records with ${size} shared records`,()=>{
 const shared=new CommittedLookups<{key:string}>(20000,4*1024*1024);
 for(let i=0;i<size;i++)shared.set(String(i),{key:String(i)});
 const clone=spyOn(globalThis,'structuredClone');
 try{
  const local=new TransactionLookups(shared);
  expect(local.get('0')).toEqual({key:'0'});
  expect(local.get('0')).toEqual({key:'0'});
  local.set('0',local.get('0')!);
  local.publish();
  expect(clone).toHaveBeenCalledTimes(1);
  console.log('shared records',shared.size,'clones for one lookup and commit',clone.mock.calls.length);
 }finally{clone.mockRestore();}
});
test('content cache evicts least recently used records within its byte and entry limits',()=>{
 const shared=new CommittedLookups<string>(2,20);
 shared.set('a','one');shared.set('b','two');expect(shared.get('a')).toBe('one');
 shared.set('c','three');expect(shared.get('b')).toBeUndefined();
 expect(shared.size).toBe(2);
 shared.set('large','x'.repeat(21));expect(shared.get('large')).toBeUndefined();
 expect(shared.get('a')).toBe('one');
});
test('transaction values are detached once from caller values and published only on demand',()=>{
 const shared=new CommittedLookups<{key:string}>(10,1000),local=new TransactionLookups(shared);
 const value={key:'before'};local.set('a',value);value.key='after';
 expect(shared.get('a')).toBeUndefined();local.publish();expect(shared.get('a')).toEqual({key:'before'});
});

test('byte accounting handles replacement, exact limits and eviction independently of entry count',()=>{
 const shared=new CommittedLookups<string>(100,10);
 shared.set('a','abc');shared.set('b','def');expect(shared.size).toBe(2);
 shared.set('a','x');shared.set('c','z');
 expect(shared.get('b')).toBeUndefined();expect(shared.get('a')).toBe('x');expect(shared.get('c')).toBe('z');
 const local=new TransactionLookups(shared);expect(local.has('a')).toBe(true);expect(local.has('missing')).toBe(false);expect(local.get('missing')).toBeUndefined();
 shared.set('a','12345678');expect(shared.size).toBe(1);expect(shared.get('a')).toBe('12345678');
});
