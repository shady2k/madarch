/** Registry-owned loop/output records are not product source authority. */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseKinds, type KindsManifest } from '../src/knowledge/kinds.js';
import { renderTask } from '../src/loop/tasks.js';
import { guideProductEntity, productDocumentMembership } from '../src/writer/guides/writer.js';
import type { SnapshotReader } from '../src/fill/snapshot.js';

const folders:string[]=[];
afterEach(()=>{for(const folder of folders.splice(0))rmSync(folder,{recursive:true,force:true});});
const registry=`kinds:
  task:
    source: markdown
    origin: person
    folder: docs/plans
    template: templates/entity.md
  summary:
    source: markdown
    origin: agent
    file: docs/summary.md
    template: templates/entity.md
  requirement:
    source: document
    origin: person
    identifier: REQ
    template: templates/entity.md
`;
const entity=(kind:string,id=kind+':one',producer='agent')=>`---\nid: ${id}\nkind: ${kind}\nproducer: ${producer}\n---\n\nA record.\n`;
const task=()=>renderTask({slug:'one',title:'Change one scoped statement',status:'open',question:'question:one',answer:'answer:one',
  grounds:['doc:README.md#usage'],scope:[{type:'section',path:'README.md',anchor:'usage'}],
  by:{name:'Reader',email:'reader@example.test',verified:'local, not verified'},at:'2026-01-01T00:00:00Z',closedBy:null,closedAt:null});
function setup():{folder:string;manifest:KindsManifest;files:Map<string,string>;snapshot:SnapshotReader}{
  const folder=mkdtempSync(join(tmpdir(),'guide-source-membership-'));folders.push(folder);
  mkdirSync(join(folder,'templates'));mkdirSync(join(folder,'madarch'));
  writeFileSync(join(folder,'templates/entity.md'),'# {{title}}\n');writeFileSync(join(folder,'madarch/kinds.yaml'),registry);
  const manifest=parseKinds(registry,join(folder,'madarch/kinds.yaml'),folder);
  expect(manifest.findings).toEqual([]);
  const files=new Map([['madarch/kinds.yaml',registry],['templates/entity.md','# {{title}}\n'],['docs/help/workflow.md','# Authored workflow\n']]);
  const snapshot={root:folder,commit:'a'.repeat(40),files:()=>[...files.keys()].map((path)=>({path})),readText:async(path:string)=>{
    const value=files.get(path);if(value===undefined)throw new Error(`${path}:1: missing fixture source`);return value;
  }} as unknown as SnapshotReader;
  return {folder,manifest,files,snapshot};
}
describe('guide product source membership',()=>{
  test('classifies only actual registry-owned parsed identities, not origin or producer alone',()=>{
    const {manifest}=setup();
    expect(guideProductEntity('docs/plans/one.md',task(),manifest)).toBe(true);
    expect(guideProductEntity('docs/summary.md',entity('summary'),manifest)).toBe(true);
    expect(guideProductEntity('docs/help/workflow.md',entity('summary'),manifest)).toBe(false);
    expect(guideProductEntity('docs/plans/one.md',entity('unknown'),manifest)).toBe(false);
    expect(guideProductEntity('docs/summary.md',entity('summary','other:one'),manifest)).toBe(false);
    expect(guideProductEntity('docs/summary.md',entity('summary','summary:'),manifest)).toBe(false);
    expect(guideProductEntity('docs/summary.md','---\nkind: summary\nid: summary:one\nid: summary:two\n---\n',manifest)).toBe(false);
    expect(guideProductEntity('docs/summary.md',entity('summary','summary:one','forged'),manifest)).toBe(false);
    expect(guideProductEntity('docs/plans/one.md',entity('task'),manifest)).toBe(false); // real task parser rejects missing scope/author/status
    expect(guideProductEntity('docs/plans/one.md',task().replace('status: open','status: invented'),manifest)).toBe(false);
    expect(guideProductEntity('docs/plans/one.md',task().replace('scope:', 'unrelated:'),manifest)).toBe(false);
    expect(guideProductEntity('docs/requirements.md',entity('requirement','requirement:one','person'),manifest)).toBe(false);
    expect(guideProductEntity('docs/summary.md',entity('summary'),undefined)).toBe(false);
  });
  test('adding and changing valid registered task/output records leaves source membership unchanged',async()=>{
    const {files,snapshot}=setup();const original=await productDocumentMembership(snapshot);
    files.set('docs/plans/one.md',task());files.set('docs/summary.md',entity('summary'));
    expect(await productDocumentMembership(snapshot)).toBe(original);
    files.set('docs/plans/one.md',task().replace('status: open','status: closed'));
    files.set('docs/summary.md',entity('summary')+'Another generated statement.\n');
    expect(await productDocumentMembership(snapshot)).toBe(original);
  });
  test('invalid records, unregistered authored siblings and producer-agent claims still invalidate',async()=>{
    const {files,snapshot}=setup();const original=await productDocumentMembership(snapshot);
    files.set('docs/plans/one.md',entity('task'));
    expect(await productDocumentMembership(snapshot)).not.toBe(original);
    files.set('docs/plans/one.md',task().replace('status: open','status: invented'));
    expect(await productDocumentMembership(snapshot)).not.toBe(original);
    files.set('docs/plans/one.md',task().replace('scope:', 'unrelated:'));
    expect(await productDocumentMembership(snapshot)).not.toBe(original);
    files.delete('docs/plans/one.md');
    files.set('docs/help/workflow.md',entity('summary')+'A changed authored instruction.\n');
    expect(await productDocumentMembership(snapshot)).not.toBe(original);
  });
  test('pinned registry/template bytes invalidate; working registry does not replace pinned classification',async()=>{
    const {folder,files,snapshot}=setup();files.set('docs/plans/one.md',task());const original=await productDocumentMembership(snapshot);
    writeFileSync(join(folder,'madarch/kinds.yaml'),registry.replace('docs/plans','docs/elsewhere'));
    expect(await productDocumentMembership(snapshot)).toBe(original);
    files.set('madarch/kinds.yaml',registry.replace('docs/plans','docs/elsewhere'));
    expect(await productDocumentMembership(snapshot)).not.toBe(original);
    files.set('madarch/kinds.yaml',registry);files.set('templates/entity.md','# Changed template\n');
    expect(await productDocumentMembership(snapshot)).not.toBe(original);
  });
});
