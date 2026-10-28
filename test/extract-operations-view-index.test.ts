import {expect, test} from 'bun:test';
import {extractCodeWithFacts} from '../src/extract/code/index.js';
import {freezeCodeFacts, type CodeFacts} from '../src/extract/code/facts.js';
import {TreeText} from '../src/extract/operations/source.js';
import {functionsOf} from '../src/extract/operations/symbol-sites.js';
import type {TreeReader} from '../src/extract/records.js';

const treeOf = (files: Readonly<Record<string,string>>): TreeReader => ({paths:Object.keys(files).sort(),read:(path)=>{
  const source=files[path]; if(source===undefined)throw new Error(`missing fixture ${path}`); return new TextEncoder().encode(source);
}});

/** The scan each index replaced, kept here so every index can be compared with it. */
const scanned = <T>(items: readonly T[], keep: (item: T) => boolean): readonly T[] => items.filter((item) => keep(item));

test('the view indexes answer every key exactly as the whole-array scans they replace did', async () => {
  const path='lib/work.ts';
  const source='const label="éλ😀"; export function outer(){ const short=()=>1; setTimeout(()=>{consume(label)},0); } export class Unit { method(){return 2;} }';
  const tree=treeOf({[path]:source});
  const code=await extractCodeWithFacts(tree);
  const facts=code.facts;
  const view=new TreeText(tree,code.extraction,facts);

  for(const expression of facts.expressions){
    expect(view.expressionsByPath.all(expression.path)).toEqual(scanned(facts.expressions,(entry)=>entry.path===expression.path));
    expect(view.expressionsById.all(expression.id)).toEqual(scanned(facts.expressions,(entry)=>entry.id===expression.id));
    expect(view.childrenByParent.all(expression.id)).toEqual([...scanned(facts.expressions,(entry)=>entry.id===expression.id)].flatMap((entry)=>entry.children));
  }
  for(const symbol of facts.symbols){
    expect(view.symbolsByPath.all(symbol.path)).toEqual(scanned(facts.symbols,(entry)=>entry.path===symbol.path));
    expect(view.symbolsByKey.all(symbol.key)).toEqual(scanned(facts.symbols,(entry)=>entry.key===symbol.key));
  }
  for(const binding of facts.bindings){
    expect(view.bindingsById.all(binding.id)).toEqual(scanned(facts.bindings,(entry)=>entry.id===binding.id));
    if(binding.initializer!==undefined)expect(view.bindingsByInitializer.all(binding.initializer)).toEqual(scanned(facts.bindings,(entry)=>entry.initializer===binding.initializer));
  }
  for(const imported of facts.imports)expect(view.importsByPath.all(imported.path)).toEqual(scanned(facts.imports,(entry)=>entry.path===imported.path));
  for(const file of facts.files)expect(view.filesByPath.all(file.path)).toEqual(scanned(facts.files,(entry)=>entry.path===file.path));

  // Every index is immutable and holds arrays, so a caller cannot shrink a proof.
  const indexes: {keys(): readonly string[]; all(key: string): readonly unknown[]}[]=[view.expressionsByPath,view.expressionsById,
    view.childrenByParent,view.bindingsById,view.bindingsByInitializer,view.symbolsByPath,view.symbolsByKey,view.importsByPath,view.filesByPath];
  for(const index of indexes)for(const key of index.keys())expect(Object.isFrozen(index.all(key))).toBe(true);
  expect(view.expressionsByPath.keys()).toContain(path);
  expect(view.importsByPath.keys()).toEqual([]);
  expect(view.importsByPath.all(path)).toEqual([]);

  // The byte-to-character table answers exactly the prefix decode it replaced.
  const bytes=tree.read(path);
  const decoder=new TextDecoder('utf-8',{fatal:true});
  const boundaries=view.charBoundaries(path);
  expect(boundaries.length).toBe(bytes.length+1);
  for(let byte=0;byte<=bytes.length;byte+=1){
    let decoded:number|undefined;
    try{decoded=decoder.decode(bytes.subarray(0,byte)).length;}catch{decoded=undefined;}
    const held=boundaries[byte];
    expect(held===undefined||held<0?undefined:held).toBe(decoded);
  }
  // A byte inside a multi-byte character is not a boundary, and the table is kept for the view.
  const firstNonAscii=bytes.findIndex((byte)=>byte>=0x80);
  expect(firstNonAscii).toBeGreaterThan(0);
  expect(boundaries[firstNonAscii+1]).toBe(-1);
  expect(boundaries[bytes.length]).toBe(new TextDecoder().decode(bytes).length);
  expect(view.charBoundaries(path)).toBe(boundaries);

  // A caller that mutates its answer cannot shrink the proof the view keeps.
  const answer=functionsOf(view,path);
  expect(answer.length).toBeGreaterThan(0);
  answer.length=0;
  expect(functionsOf(view,path).length).toBeGreaterThan(0);
});

test('duplicate expressions with one id and duplicate symbols with one key stay visible and keep their gaps', async () => {
  const path='lib/owner.ts';
  const source='export function sole(){return 1;}';
  const tree=treeOf({[path]:source});
  const code=await extractCodeWithFacts(tree);
  const symbol=code.facts.symbols.find((entry)=>entry.name==='sole')!;
  const expression=code.facts.expressions[0]!;

  // A duplicated expression id is not collapsed: both entries stay, in facts order,
  // so the last one is still the entry the per-declaration map used to keep.
  const copy={...expression};
  const repeatedExpressions=freezeCodeFacts({...code.facts,expressions:[...code.facts.expressions,copy]});
  const expressionsView=new TreeText(tree,code.extraction,repeatedExpressions);
  expect(expressionsView.expressionsById.all(expression.id)).toHaveLength(2);
  expect(expressionsView.expressionsById.all(expression.id)[0]).toBe(expression);
  expect(expressionsView.expressionsById.all(expression.id).at(-1)).toBe(copy);
  const sameFacts=new TreeText(tree,code.extraction,code.facts);
  expect(functionsOf(expressionsView,path)).toEqual(functionsOf(sameFacts,path));
  expect([...expressionsView.factGaps.values()]).toEqual([...sameFacts.factGaps.values()]);
  expect(expressionsView.factGaps.size).toBe(0);

  // A duplicated symbol key still fails closed: the same gap, and no site claimed.
  const repeatedSymbols=freezeCodeFacts({...code.facts,symbols:[...code.facts.symbols,symbol]});
  const symbolsView=new TreeText(tree,code.extraction,repeatedSymbols);
  expect(symbolsView.symbolsByKey.all(symbol.key)).toHaveLength(2);
  expect(symbolsView.symbolsByPath.all(path).filter((entry)=>entry.key===symbol.key)).toHaveLength(2);
  expect(functionsOf(symbolsView,path)).toEqual([]);
  expect([...symbolsView.factGaps.values()].filter((gap)=>gap.reason.includes('duplicate callable identity'))).toHaveLength(1);
  // Asking again answers from the same proof: no second gap and no site invented.
  const held=symbolsView.factGaps.size;
  expect(functionsOf(symbolsView,path)).toEqual([]);
  expect(symbolsView.factGaps.size).toBe(held);
});

test('a missing index entry answers as the scan did and never invents a fact', async () => {
  const absent='lib/nowhere.ts';
  const path='lib/absent.ts';
  const source='export function present(){return 1;}';
  const tree=treeOf({[path]:source});
  const code=await extractCodeWithFacts(tree);

  const view=new TreeText(tree,code.extraction,code.facts);
  expect(view.filesByPath.all(absent)).toEqual(scanned(code.facts.files,(file)=>file.path===absent));
  expect(view.filesByPath.all(absent)).toEqual([]);
  expect(view.symbolsByPath.all(absent)).toEqual([]);
  expect(view.expressionsById.all(`${absent}:0:1:identifier`)).toEqual([]);
  expect(view.childrenByParent.all(`${absent}:0:1:identifier`)).toEqual([]);
  expect(functionsOf(view,absent)).toEqual([]);
  expect([...view.factGaps.values()].map((gap)=>gap.reason)).toEqual(['line 1: callable sites require a successfully parsed file']);
  // The file the facts do hold still answers, so the empty index did not hide it.
  expect(view.filesByPath.all(path)).toHaveLength(1);
  expect(functionsOf(view,path)).toHaveLength(1);

  // A file fact the view does not hold finds no site, exactly as the scan found none.
  const withoutFile=freezeCodeFacts({...code.facts,files:[]});
  const unheld=new TreeText(tree,code.extraction,withoutFile);
  expect(unheld.filesByPath.all(path)).toEqual([]);
  expect(functionsOf(unheld,path)).toEqual([]);
  expect([...unheld.factGaps.values()].map((gap)=>gap.reason)).toEqual(['line 1: callable sites require a successfully parsed file']);
});

test('a second view over the same facts proves its own gaps and inherits none', async () => {
  const path='lib/body.ts';
  const source='export function outer(){return 1;}';
  const tree=treeOf({[path]:source});
  const code=await extractCodeWithFacts(tree);
  const symbol=code.facts.symbols.find((entry)=>entry.name==='outer')!;
  const facts:CodeFacts=freezeCodeFacts({...code.facts,symbols:code.facts.symbols.map((entry)=>entry.key===symbol.key?{...entry,bodySpan:undefined}:entry)});

  const first=new TreeText(tree,code.extraction,facts);
  const second=new TreeText(tree,code.extraction,facts);
  const firstSites=functionsOf(first,path);
  expect(firstSites).toEqual([]);
  expect([...first.factGaps.values()].map((gap)=>gap.reason)).toEqual([`line ${symbol.span.lineStart}: callable ${symbol.key} has no proved body at bytes ${symbol.span.byteStart}-${symbol.span.byteEnd}`]);
  // The first view's gap is not carried into the second, which proves its own.
  expect(second.factGaps.size).toBe(0);
  expect(functionsOf(second,path)).toEqual(firstSites);
  expect([...second.factGaps.values()]).toEqual([...first.factGaps.values()]);
  // Repeating the question inside one view is the same proof, not a second claim.
  expect(functionsOf(first,path)).toEqual(firstSites);
  expect(first.factGaps.size).toBe(1);
  // A caller that mutates its answer cannot shrink the view's proof.
  const answer=functionsOf(first,path);
  answer.length=0;
  expect(functionsOf(first,path)).toEqual(firstSites);
});
