import {describe, expect, test} from 'bun:test';
import {linkExtractions, LINKS_PRODUCER} from '../src/extract/driver/links.js';
import type {Extraction} from '../src/extract/records.js';
const make = (producer: `code.${string}`, key: string, to: string): Extraction => ({producer, nodes: [{key, kind: key.slice(0, key.indexOf(':')) as `code.${string}`, label: key, properties: {}, span: {path: 'src/main.ts', lineStart: 1, lineEnd: 1, byteStart: 0, byteEnd: 1}}], edges: [{type: 'code.references', from: key, to, discriminator: '', properties: {}}], gaps: []});
describe('madarch-m38l.20 shared declaration links', () => {
  test('cyclic-producers: each end uses a real declaration, both directions publish after the owning nodes', () => {
    const a = make('code.extract.a', 'code.symbol:a#run', 'code.dependency:b#library');
    const b = make('code.extract.b', 'code.dependency:b#library', 'code.symbol:a#run');
    const result = linkExtractions([a, b], {'code.symbol': a.producer, 'code.dependency': b.producer});
    expect(result.extractions.map((entry) => entry.producer)).toEqual([a.producer, b.producer, LINKS_PRODUCER]);
    expect(result.extractions.slice(0, 2).flatMap((entry) => entry.edges)).toEqual([]);
    expect(result.extractions.at(-1)?.edges).toHaveLength(2);
    expect(result.extractions.at(-1)?.nodes).toEqual([]);
    expect([...result.keyOwners]).toEqual([[a.nodes[0]!.key, a.producer], [b.nodes[0]!.key, b.producer]]);
  });
  test('inline-callback-owner: a kind owner cannot invent a missing declaration or steal a real inline callback', () => {
    const callback = make('code.extract.contracts', 'code.symbol:src/main.ts#callback@1', 'code.route:src/main.ts#GET:/');
    const route = make('code.extract.contracts', 'code.route:src/main.ts#GET:/', callback.nodes[0]!.key);
    const result = linkExtractions([{...callback, nodes: [...callback.nodes, ...route.nodes]}], {'code.symbol': 'code.extract.code'});
    expect(result.keyOwners.get(callback.nodes[0]!.key)).toBe(callback.producer);
    expect(result.extractions[0]?.nodes).toHaveLength(2);
    expect(result.extractions[0]?.edges).toHaveLength(1);
  });
  test('equal-properties-ignore-insertion-order: conflicts are explicit and name both producers', () => {
    const a = make('code.extract.a', 'code.symbol:a#run', 'code.symbol:a#run');
    const b = {...a, producer: 'code.extract.b' as const};
    const first = {...a.edges[0]!, properties: {nested: {a: 1, b: 2}}};
    const equal = {...first, properties: {nested: {b: 2, a: 1}}};
    expect(linkExtractions([{...a, edges: [first]}, {...b, edges: [equal]}], {}).extractions.at(-1)?.gaps).toEqual([]);
    const different = {...first, properties: {nested: {a: 9, b: 2}}};
    const gaps = linkExtractions([{...a, edges: [first]}, {...b, edges: [different]}], {}).extractions.at(-1)?.gaps;
    expect(gaps).toHaveLength(1);
    expect(gaps?.[0]?.reason).toContain('code.extract.a and code.extract.b');
  });
  test('missing-declaration: an unresolved endpoint becomes a located gap, never an evidence-free node', () => {
    const a = make('code.extract.a', 'code.symbol:a#run', 'code.dependency:missing');
    const ex = linkExtractions([a], {'code.dependency': 'code.extract.operations'}).extractions[0]!;
    expect(ex.nodes).toHaveLength(1); expect(ex.edges).toEqual([]);
    expect(ex.gaps[0]?.path).toBe('src/main.ts'); expect(ex.gaps[0]?.reason).toContain('line 1'); expect(ex.gaps[0]?.reason).toContain('code.dependency:missing');
  });
  test('empty-links-publication: removing the final cross-producer edge still sweeps the old link publication', () => {
    expect(linkExtractions([], {}).extractions).toEqual([{producer: LINKS_PRODUCER, nodes: [], edges: [], gaps: []}]);
  });
  test('duplicate-within-extraction: preserve malformed duplicate input for the publication guard, never silently shrink it', () => {
    const a = make('code.extract.a', 'code.symbol:a#run', 'code.symbol:a#run');
    expect(() => linkExtractions([{...a, edges: [...a.edges, ...a.edges]}], {})).toThrow('twice');
    const b = make('code.extract.b', 'code.dependency:b#library', a.nodes[0]!.key);
    const foreign = {...a.edges[0]!, to: b.nodes[0]!.key};
    expect(() => linkExtractions([{...a, edges: [foreign, foreign]}, b], {})).toThrow('twice');
  });
});


test('fresh normalization: cross-producer equal logical relation keeps BOTH source producers and reading spans', () => {
 const span = (line: number) => ({path:'src/main.ts',lineStart:line,lineEnd:line,byteStart:line*10,byteEnd:line*10+1});
 const a: Extraction = {producer:'code.extract.a',nodes:[{key:'code.symbol:a',kind:'code.symbol',label:'a',properties:{}},{key:'code.symbol:b',kind:'code.symbol',label:'b',properties:{}}],edges:[{type:'code.references',from:'code.symbol:a',to:'code.symbol:b',discriminator:'',properties:{meaning:'same'},span:span(1)}],gaps:[]};
 const b: Extraction = {producer:'code.extract.b',nodes:[],edges:[{...a.edges[0]!,span:span(2)}],gaps:[]};
 const result = linkExtractions([a,b],{});
 const edges = result.extractions.flatMap((extraction) => extraction.edges);
 expect(edges).toHaveLength(1);
 const origins = edges[0]?.properties.origins as {sourceProducer:string;sourceSpan:{lineStart:number};originalDiscriminator:string}[];
 expect(origins.map((row) => row.sourceProducer)).toEqual(['code.extract.a','code.extract.b']);
 expect(origins.map((row) => row.sourceSpan.lineStart)).toEqual([1,2]);
 expect(origins.every((row) => row.originalDiscriminator === '')).toBe(true);
 expect(() => linkExtractions([{...a,edges:[a.edges[0]!,a.edges[0]!]}],{})).toThrow('twice');
});


test('positioned occurrences keep one canonical store identity and every original discriminator/span',()=>{
 const span={path:'src/main.ts',lineStart:2,lineEnd:2,byteStart:10,byteEnd:14};
 const a:Extraction={producer:'code.extract.a',nodes:[{key:'code.symbol:a',kind:'code.symbol',label:'a',properties:{}},{key:'code.symbol:b',kind:'code.symbol',label:'b',properties:{}}],edges:[{type:'code.occurrence',from:'code.symbol:a',to:'code.symbol:b',discriminator:'source-a',properties:{use:'call'},span}],gaps:[]};
 const b:Extraction={producer:'code.extract.b',nodes:[],edges:[{...a.edges[0]!,discriminator:'source-b',span:{...span,byteEnd:15}}],gaps:[]};
 const normalized=linkExtractions([a,b],{});const aggregate=normalized.extractions.find((entry)=>entry.producer==='code.extract.a')!;
 expect(normalized.extractions.flatMap((entry)=>entry.edges)).toHaveLength(1);expect(aggregate.edges).toHaveLength(1);
 const origins=aggregate.edges[0]!.properties.origins as {sourceProducer:string;originalDiscriminator:string;sourceSpan:typeof span}[];
 expect(origins.map((origin)=>origin.originalDiscriminator)).toEqual(['source-a','source-b']);expect(origins.map((origin)=>origin.sourceSpan.byteEnd)).toEqual([14,15]);
 expect(aggregate.edges[0]!.span).toEqual({...span,byteEnd:15});
});
