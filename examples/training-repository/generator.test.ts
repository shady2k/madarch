import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.dirname(new URL(import.meta.url).pathname);
const generator = path.join(root, 'generate.mjs');
const keyPath = path.join(root, 'answer-key.json');
const key = JSON.parse(await readFile(keyPath, 'utf8'));
const run = (args, cwd) => execFileSync(args[0], args.slice(1), {cwd, encoding:'utf8'}).trim();
async function snapshot(dir) {
  const rows = [];
  async function walk(folder, prefix='') {
    for (const name of (await readdir(folder)).sort()) {
      if (name === '.git') continue;
      const full = path.join(folder,name), rel=path.posix.join(prefix,name);
      const stat = await (await import('node:fs/promises')).stat(full);
      if (stat.isDirectory()) await walk(full,rel); else rows.push([rel, await readFile(full)]);
    }
  }
  await walk(dir); return rows;
}
async function checkItems(value, repo) {
  if (Array.isArray(value)) { for (const item of value) await checkItems(item,repo); return; }
  if (!value || typeof value !== 'object') return;
  if (typeof value.url === 'string') expect(typeof value.file).toBe('string');
  if (typeof value.codeFile === 'string') { const text = await readFile(path.join(repo,value.codeFile),'utf8'); expect(text.includes(value.symbol), `${value.codeFile} symbol ${value.symbol}`).toBe(true); }
  if (typeof value.file === 'string') {
    const file = path.join(repo,value.file);
    const text = await readFile(file, 'utf8');
    expect(text.length, `${value.file} present`).toBeGreaterThan(0);
    if (value.symbol) expect(text.includes(value.symbol), `${value.file} symbol ${value.symbol}`).toBe(true);
    if (value.comment) expect(text.includes(value.comment), `${value.file} comment`).toBe(true);
  }
  for (const v of Object.values(value)) await checkItems(v,repo);
}

describe('training repository generator', () => {
 test('creates byte-identical output and commit history on repeated runs', async () => {
   const tmp=await mkdtemp(path.join(os.tmpdir(),'madarch-training-'));
   try {
     const a=path.join(tmp,'a'), b=path.join(tmp,'b');
     run(['node',generator,a],root); run(['node',generator,b],root);
     const sa=await snapshot(a), sb=await snapshot(b);
     expect(sa.map(([p,x])=>[p,x.toString('base64')])).toEqual(sb.map(([p,x])=>[p,x.toString('base64')]));
     expect(run(['git','log','--format=%H'],a)).toEqual(run(['git','log','--format=%H'],b));
     expect(run(['git','log','--format=%an <%ae> %aI %s'],a)).toContain('ORD-12');
     expect(run(['git','log','--format=%an <%ae> %aI %s'],a)).toContain('PAY-4');
     expect(run(['git','log','--format=%an <%ae> %aI %s'],a)).toContain('ORD-19');
     expect(run(['git','log','--format=%H'],a).split('\n')).toHaveLength(3);
     expect(run(['git','log','--format=%H --name-only'],a)).not.toContain('\n\n\n');
     for (const hash of run(['git','log','--format=%H'],a).split('\n')) expect(run(['git','diff-tree','--root','--no-commit-id','--name-only','-r',hash],a).length).toBeGreaterThan(0);
     expect(path.resolve(keyPath).startsWith(path.resolve(a)+path.sep)).toBe(false);
     expect(await readdir(a)).not.toContain('answer-key.json');
   } finally { await rm(tmp,{recursive:true,force:true}); }
 });
 test('every key reference resolves in generated files', async () => {
   const tmp=await mkdtemp(path.join(os.tmpdir(),'madarch-training-'));
   try { const repo=path.join(tmp,'repo'); run(['node',generator,repo],root); await checkItems(key,repo);
     const checkout=await readFile(path.join(repo,'services/checkout/src/checkout.ts'),'utf8');
     const payments=await readFile(path.join(repo,'services/payments/src/payment.ts'),'utf8');
     const orders=await readFile(path.join(repo,'services/orders/src/order.go'),'utf8');
     expect(checkout).toContain('fetch(\'http://promotions-api/internal/apply\'');
     expect(payments).toContain("eventBroker.publish('payments', event)"); expect(orders).toContain('EventBus.Publish(\"orders\", event)');
     expect(key.stateMachine.transitions.at(-1).fromStates).toEqual(['pending_payment','confirmed','cancelled']);
     expect(new Set(key.entities.map(e=>e.id)).size).toBe(key.entities.length);
   }
   finally { await rm(tmp,{recursive:true,force:true}); }
 });

 test('refuses destinations inside the source checkout before deleting them', async () => {
   const target=path.join(root,'must-not-be-deleted'); await (await import('node:fs/promises')).mkdir(target,{recursive:true});
   await (await import('node:fs/promises')).writeFile(path.join(target,'sentinel'),'safe');
   try { expect(() => run(['node',generator,target],root)).toThrow(); expect(await readFile(path.join(target,'sentinel'),'utf8')).toBe('safe'); }
   finally { await rm(target,{recursive:true,force:true}); }
 });
 test('refuses a symlink destination that resolves inside checkout', async () => {
   const fs=await import('node:fs/promises'), outside=await mkdtemp(path.join(os.tmpdir(),'training-link-'));
   const link=path.join(root,'training-link'); await fs.symlink(outside,link);
   try { expect(() => run(['node',generator,link],root)).toThrow(); expect(await readdir(outside)).toEqual([]); }
   finally { await fs.unlink(link); await rm(outside,{recursive:true,force:true}); }
 });

 test('refuses a destination below a symlinked parent into checkout', async () => {
   const fs=await import('node:fs/promises'), outside=await mkdtemp(path.join(os.tmpdir(),'training-parent-link-'));
   const link=path.join(outside,'checkout-link'); await fs.symlink(root,link);
   const target=path.join(link,'must-not-be-deleted');
   try { expect(() => run(['node',generator,target],root)).toThrow(); expect(await readdir(root)).not.toContain('must-not-be-deleted'); }
   finally { await fs.rm(outside,{recursive:true,force:true}); }
 });

});
