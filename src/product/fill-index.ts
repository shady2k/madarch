/** Deterministic inventory and structural indexing of an immutable Git snapshot. */
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import treeSitterRuntime from 'web-tree-sitter/tree-sitter.wasm' with { type: 'file' };
import goGrammar from 'tree-sitter-wasms/out/tree-sitter-go.wasm' with { type: 'file' };
import jsGrammar from 'tree-sitter-wasms/out/tree-sitter-javascript.wasm' with { type: 'file' };
import tsGrammar from 'tree-sitter-wasms/out/tree-sitter-typescript.wasm' with { type: 'file' };
import tsxGrammar from 'tree-sitter-wasms/out/tree-sitter-tsx.wasm' with { type: 'file' };
import { resolve, join } from 'node:path';
import { Parser, Language, type Node as SyntaxNode } from 'web-tree-sitter';
import { FILL_STAGES, hashFillInput, type FillStage, type FillUnit, type FillUnitPlan } from './fill-runtime.js';

const execFile = promisify(execFileCallback);
const execFileBuffer = promisify(execFileCallback);
const runtimeWasmPath = treeSitterRuntime;
const digest = (v: string | Uint8Array): string => createHash('sha256').update(v).digest('hex');
const codePointSort = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export interface SourceAnchor { path: string; blob: string; startLine: number; endLine: number; startByte: number; endByte: number }
export interface InventoryFile extends SourceAnchor { language: string | null; bytes: number }
export interface RepositoryInventory { path: string; commit: string; files: number; languages: Record<string, number> }
export interface FillEstimate { stage: FillStage; units: number; estimatedAgentCalls: number; estimatedInputTokens: number; estimatedOutputTokens: number }
export interface RepositoryInventoryResult { repository: string; commit: string; repositories: RepositoryInventory[]; files: InventoryFile[]; languages: Record<string, number>; filesByLanguage: Record<string, number>; estimates: FillEstimate[]; contentHash: string }
export interface IndexedSymbol extends SourceAnchor { name: string; kind: string; exported: boolean }
export interface IndexedReference extends SourceAnchor { source: string; target: string; kind: 'import' | 'call' }
export interface IndexedComment extends SourceAnchor { text: string }
export interface IndexedTaskKey extends SourceAnchor { key: string }
export interface StructuralFile extends InventoryFile { symbols: IndexedSymbol[]; imports: IndexedReference[]; entryPoints: string[]; callEdges: IndexedReference[]; comments: IndexedComment[]; taskKeys: IndexedTaskKey[] }
export interface StructuralIndexResult { repository: string; commit: string; files: StructuralFile[]; contentHash: string }

const extensions: Record<string, string> = { '.ts':'typescript', '.tsx':'tsx', '.mts':'typescript', '.cts':'typescript', '.js':'javascript', '.jsx':'javascript', '.mjs':'javascript', '.cjs':'javascript', '.go':'go' };
function languageFor(path: string): string | null { const ext = path.slice(path.lastIndexOf('.')).toLowerCase(); return extensions[ext] ?? null; }
async function git(cwd: string, ...args: string[]): Promise<string> {
  try { return (await execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).stdout; }
  catch (e) { const error = e as {stderr?: string; message?: string}; throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(error.stderr ?? error.message ?? String(e)).trim()}`); }
}
async function gitBlob(cwd: string, blob: string): Promise<Buffer> {
 try { const result = await execFileBuffer('git', ['-C', cwd, 'cat-file', 'blob', blob], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }); return result.stdout as Buffer; }
 catch (e) { const error=e as {stderr?: Buffer|string;message?:string}; const stderr=Buffer.isBuffer(error.stderr)?error.stderr.toString('utf8'):error.stderr; throw new Error(`git cat-file blob ${blob} failed in ${cwd}: ${(stderr??error.message??String(e)).trim()}`); }
}
interface TreeEntry { path: string; blob: string; mode: string; type: string }
async function snapshot(checkout: string, commit: string): Promise<{ root: string; tree: TreeEntry[] }> {
  const root = resolve(checkout);
  const resolved = (await git(root, 'rev-parse', '--verify', `${commit}^{commit}`)).trim();
  const raw = await git(root, 'ls-tree', '-rz', '--full-tree', '-r', resolved);
  const tree = raw.split('\0').filter(Boolean).map((row) => {
    const tab = row.indexOf('\t'); const [mode, type, blob] = row.slice(0, tab).split(' ');
    return { path: row.slice(tab + 1), mode: mode!, type: type!, blob: blob! };
  }).filter((entry) => entry.type === 'blob' && entry.mode !== '160000').sort((a,b) => codePointSort(a.path,b.path));
  return { root, tree };
}
function range(path: string, blob: string, startLine: number, endLine: number, startByte: number, endByte: number): SourceAnchor { return { path, blob, startLine, endLine, startByte, endByte }; }
function byteOffset(text: string, index: number): number { return Buffer.byteLength(text.slice(0,index),'utf8'); }
function lineAt(text: string, byte: number): number { return Buffer.from(text).subarray(0, byte).toString('utf8').split('\n').length; }
function languageCounts(files: readonly InventoryFile[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of files) { const name = f.language ?? 'unknown'; counts[name] = (counts[name] ?? 0) + 1; }
  return Object.fromEntries(Object.entries(counts).sort(([a],[b]) => codePointSort(a,b)));
}
async function filesFor(root: string, tree: TreeEntry[]): Promise<InventoryFile[]> {
 return Promise.all(tree.map(async entry => {
   const contents = await gitBlob(root, entry.blob);
   const size = contents.byteLength;
   return { ...range(entry.path, entry.blob, 1, Math.max(1, contents.toString('utf8').split('\n').length), 0, size), language: languageFor(entry.path), bytes: size };
 }));
}
/** Reports only the requested pinned commit. The checkout and its worktree are never modified. */
export async function inventoryRepository(checkoutPath: string, pinnedCommit: string, additionalCheckouts: readonly { path: string; commit: string }[] = []): Promise<RepositoryInventoryResult> {
 const {root, tree} = await snapshot(checkoutPath, pinnedCommit);
 const files = await filesFor(root, tree);
 const commit = (await git(root, 'rev-parse', `${pinnedCommit}^{commit}`)).trim();
 const languages = languageCounts(files);
 const estimates = FILL_STAGES.map((stage): FillEstimate => {
   const units = stage === 'inventory' ? 1 : stage === 'index' ? files.filter(f => f.language).length : stage === 'claims' ? files.filter(f => /\.(md|mdx)$/i.test(f.path)).length : stage === 'code-map' ? Math.max(1, Math.ceil(files.filter(f => f.language).length / 10)) : stage === 'synthesis' ? Math.max(1, Math.ceil(files.filter(f => f.language).length / 20)) : Math.max(1, Math.ceil(files.filter(f => /\.(md|mdx)$/i.test(f.path)).length / 5));
   const calls = stage === 'inventory' || stage === 'index' ? 0 : units;
   return { stage, units, estimatedAgentCalls: calls, estimatedInputTokens: stage === 'index' ? 0 : units * 2000, estimatedOutputTokens: calls * 1000 };
 });
 const repositories: RepositoryInventory[] = [{path: '.', commit, files: files.length, languages}];
 for (const additional of [...additionalCheckouts].sort((a,b)=>codePointSort(a.path,b.path))) {
   const nested = await inventoryRepository(additional.path, additional.commit);
   repositories.push(...nested.repositories.map(repo=>({...repo,path:join(additional.path,repo.path)})));
 }
 const canonical = JSON.stringify({commit, repositories, files, estimates});
 return {repository: root, commit, repositories, files, languages, filesByLanguage: languages, estimates, contentHash: digest(canonical)};
}

const grammarFiles = { typescript: tsGrammar, tsx: tsxGrammar, javascript: jsGrammar, go: goGrammar } as const;
let parserInit: Promise<void> | undefined;
const languages = new Map<string, Awaited<ReturnType<typeof Language.load>>>();
async function makeParser(lang: string): Promise<Parser> {
 parserInit ??= Parser.init({ locateFile: () => runtimeWasmPath }); await parserInit;
 let language = languages.get(lang);
 if (!language) {
   language = await Language.load(grammarFiles[lang as keyof typeof grammarFiles]); languages.set(lang, language);
 }
 const parser = new Parser(); parser.setLanguage(language); return parser;
}
function descendants(node: SyntaxNode): SyntaxNode[] { const out: SyntaxNode[] = [node]; for (const child of node.children) if (child) out.push(...descendants(child)); return out; }
function nodeAnchor(path: string, blob: string, text: string, node: SyntaxNode): SourceAnchor { return range(path, blob, node.startPosition.row + 1, node.endPosition.row + 1, byteOffset(text,node.startIndex), byteOffset(text,node.endIndex)); }
function nodeText(text: string, n: SyntaxNode): string { return text.slice(n.startIndex,n.endIndex); }
function collectFile(path: string, blob: string, text: string, root: SyntaxNode, language: string): Omit<StructuralFile, keyof InventoryFile> {
 const nodes = descendants(root); const symbols: IndexedSymbol[] = []; const imports: IndexedReference[] = []; const calls: IndexedReference[] = []; const comments: IndexedComment[] = []; const entryPoints: string[] = [];
 for (const n of nodes) {
   const parent = n.parent; const nameNode = n.childForFieldName('name');
   if (nameNode && /function_declaration|class_declaration|method_declaration|method_definition|interface_declaration|type_alias_declaration/.test(n.type)) {
     const name = nodeText(text,nameNode).replace(/^['"]|['"]$/g,'');
     symbols.push({ ...nodeAnchor(path,blob,text,n), name, kind:n.type, exported: language === 'go' ? /^\p{Lu}/u.test(name) : parent?.type === 'export_statement' });
     if (/main$/.test(name) || /main_package/.test(n.type)) entryPoints.push(name);
   }
   if (n.type === 'variable_declarator' || n.type === 'variable_declaration') {
     const variableName = n.type === 'variable_declaration' ? n : (n.childForFieldName('name') ?? n.namedChildren.find(child => child?.type === 'identifier')); const statement = n.type === 'variable_declaration' ? n.parent?.parent : n.parent;
     if (variableName && statement && /lexical_declaration|variable_declaration/.test(statement.type)) {
       const name = nodeText(text,variableName); symbols.push({...nodeAnchor(path,blob,text,n),name,kind:'variable_declaration',exported: language === 'go' ? /^\p{Lu}/u.test(name) : statement.parent?.type === 'export_statement'});
     }
   }
   if (/^import_statement$/.test(n.type)) {
     const target = nodeText(text,n).match(/from\s*["']([^"']+)|import\s*["']([^"']+)/)?.slice(1).find(Boolean) ?? nodeText(text,n);
     imports.push({...nodeAnchor(path,blob,text,n),source:path,target,kind:'import'});
   }
   if (n.type === 'import_spec') {
     const importPath=n.childForFieldName('path');
     if (importPath) imports.push({...nodeAnchor(path,blob,text,n),source:path,target:nodeText(text,importPath).replace(/^["']|["']$/g,''),kind:'import'});
   }
   if (/call_expression$/.test(n.type)) {
     const fn = n.childForFieldName('function'); if (fn) calls.push({...nodeAnchor(path,blob,text,n),source:path,target:nodeText(text,fn),kind:'call'});
   }
   if (/comment$/.test(n.type)) comments.push({...nodeAnchor(path,blob,text,n),text:nodeText(text,n)});
 }
 const exportedNames = new Set(nodes.filter(n=>n.type==='export_statement').flatMap(n=>descendants(n).filter(child=>child.type==='identifier' || child.type==='type_identifier').map(child=>nodeText(text,child))));
 if (language !== 'go') for (const symbol of symbols) symbol.exported = exportedNames.has(symbol.name);
 const taskKeys: IndexedTaskKey[] = [];
 for (const match of text.matchAll(/\b(?:Task|task):\s*([A-Za-z0-9][A-Za-z0-9._-]*)/g)) {
   const startByte = Buffer.byteLength(text.slice(0,match.index)); const endByte = startByte + Buffer.byteLength(match[0]);
   taskKeys.push({...range(path,blob,lineAt(text,startByte),lineAt(text,endByte),startByte,endByte),key:match[1]!});
 }
 return {symbols:symbols.sort((a,b)=>a.startByte-b.startByte),imports:imports.sort((a,b)=>a.startByte-b.startByte),entryPoints:[...new Set(entryPoints)].sort(codePointSort),callEdges:calls.sort((a,b)=>a.startByte-b.startByte),comments:comments.sort((a,b)=>a.startByte-b.startByte),taskKeys};
}
/** Parses one pinned source blob without reading any other source file. */
async function indexOne(root: string, entry: TreeEntry): Promise<StructuralFile> {
 const language = languageFor(entry.path); if (!language) throw new Error(`Unsupported source language for ${entry.path}`);
 const bytes = await gitBlob(root, entry.blob); const text = bytes.toString('utf8'); const parser = await makeParser(language);
 try { const parsed = parser.parse(text); if (!parsed) throw new Error(`Tree-sitter returned no syntax tree for ${entry.path}`); const result={...range(entry.path,entry.blob,1,Math.max(1,text.split('\n').length),0,bytes.byteLength),language,bytes:bytes.byteLength,...collectFile(entry.path,entry.blob,text,parsed.rootNode,language)}; parsed.delete(); return result; }
 finally { parser.delete(); }
}
/** Parses supported TS/JS/Go blobs from a Git tree, never the mutable checkout files. */
export async function indexRepository(checkoutPath: string, pinnedCommit: string): Promise<StructuralIndexResult> {
 const {root, tree} = await snapshot(checkoutPath,pinnedCommit); const files: StructuralFile[] = [];
 for (const entry of tree) {
   const language = languageFor(entry.path); if (!language) continue;
   files.push(await indexOne(root,entry));
 }
 const commit=(await git(root,'rev-parse',`${pinnedCommit}^{commit}`)).trim();
 const canonical=JSON.stringify({commit,files});
 return {repository:root,commit,files,contentHash:digest(canonical)};
}
/** Stable plans for runtime persistence; index work is one content-addressed unit per source file. */
export function inventoryUnitPlan(result: RepositoryInventoryResult): FillUnitPlan {
 return { id: 'inventory-repository', stage: 'inventory', inputHashes: { snapshot: result.contentHash }, outputPaths: ['.madarch/fill/outputs/inventory-repository/inventory.json'], dependencies: [] };
}
export function structuralIndexUnitPlans(index: StructuralIndexResult, upstreamInventoryHash: string): FillUnitPlan[] {
 return index.files.map(file => {
   const id=`index-${digest(file.path).slice(0,16)}`;
   return {id,stage:'index',inputHashes:{blob:file.blob,inventory:upstreamInventoryHash,commit:index.commit},outputPaths:[`.madarch/fill/outputs/${id}/index.json`],dependencies:[]};
 });
}
/** Persist the inventory result in the unit's contract-owned output location. */
export async function executeInventoryUnit(productRoot: string, unit: FillUnit, result: RepositoryInventoryResult, signal: AbortSignal): Promise<{outputPaths: string[]}> {
 if (unit.stage !== 'inventory') throw new Error(`Expected inventory unit, got ${unit.stage}`);
 if (signal.aborted) throw new Error('Inventory unit aborted before output write');
 const { writeFillJsonAtomic } = await import('./fill-runtime.js');
 const output = resolve(productRoot, unit.outputPaths[0] ?? `.madarch/fill/outputs/${unit.id}/inventory.json`);
 await writeFillJsonAtomic(output, result);
 return {outputPaths:[output]};
}
/** Runtime executor for one indexed file. Other stages own the output writer and are not handled here. */
export async function executeStructuralIndexUnit(checkoutPath: string, productRoot: string, unit: FillUnit, signal: AbortSignal): Promise<{outputPaths: string[]}> {
 if (unit.stage !== 'index') throw new Error(`Expected index unit, got ${unit.stage}`);
 if (signal.aborted) throw new Error('Index unit aborted before parsing');
 const root=resolve(checkoutPath); const commit=unit.inputHashes.commit ?? unit.inputHashes.snapshot ?? 'HEAD';
 const {tree}=await snapshot(root,commit); const entry=tree.find(item=>`index-${digest(item.path).slice(0,16)}`===unit.id);
 if (!entry || entry.blob!==unit.inputHashes.blob) throw new Error(`Index input mismatch for ${unit.id}`);
 const selected=await indexOne(root,entry);
 if (signal.aborted) throw new Error(`Index unit ${unit.id} aborted before output write`);
 const { writeFillJsonAtomic } = await import('./fill-runtime.js');
 const output = resolve(productRoot, unit.outputPaths[0] ?? `.madarch/fill/outputs/${unit.id}/index.json`);
 await writeFillJsonAtomic(output, selected);
 return {outputPaths:[output]};
}
export { hashFillInput };
