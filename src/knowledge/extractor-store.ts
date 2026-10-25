/** The graph is a disposable index (0029). Only this derived folder is replaced; no product source is written. */
import {existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {basename, dirname, isAbsolute, join, resolve} from 'node:path';
import {canonicalJsonDigest} from '../model/canonical.js';
export interface ExtractorVersion {readonly name: string; readonly version: number}
export interface ExtractorManifest {readonly format: 1; readonly extractors: readonly ExtractorVersion[]; readonly digest: string}
const FILE = 'extractors.json';
export function extractorManifest(extractors: readonly ExtractorVersion[]): ExtractorManifest {
 const names = new Set<string>();
 for (const entry of extractors) {
  if (entry.name === '' || names.has(entry.name) || !Number.isSafeInteger(entry.version) || entry.version < 1) throw new Error(`extractor manifest: invalid or duplicate name/version ${entry.name}:${entry.version}`);
  names.add(entry.name);
 }
 const entries = extractors.map((entry) => ({name:entry.name,version:entry.version}));
 return {format:1,extractors:entries,digest:canonicalJsonDigest(entries)};
}
/** A committed manifest is part of the graph folder, so the graph and its interpretation switch together. */
function storedDigest(path: string): string | undefined {
 try {
  const value = JSON.parse(readFileSync(join(path,FILE),'utf8')) as ExtractorManifest;
  if (value.format !== 1 || !Array.isArray(value.extractors)) return undefined;
  const checked = extractorManifest(value.extractors);
  return checked.digest === value.digest ? value.digest : undefined;
 } catch {return undefined;}
}
export interface PreparedExtractorStore {
 readonly path: string;
 readonly rebuilt: boolean;
 /** Only after the build's database owner has closed successfully. */
 commit(): void;
 /** Discards only an unpromoted build. After promotion, the new graph/digest remain active. */
 abort(): void;
}
export function prepareExtractorStore(graphPath: string, manifest: ExtractorManifest, fault?: (step: 'before-rename' | 'between-renames' | 'after-promotion') => void): PreparedExtractorStore {
 if (!isAbsolute(graphPath) || basename(graphPath) !== 'graph' || resolve(graphPath) !== graphPath) throw new Error(`extractor store: ${graphPath}: expected an absolute derived graph path`);
 const parent=dirname(graphPath); mkdirSync(parent,{recursive:true});
 if (realpathSync(parent)!==parent) throw new Error(`extractor store: ${graphPath}: derived parent is a symbolic link`);
 for (const path of [graphPath,`${graphPath}.rebuild`,`${graphPath}.previous`]) {
  try {if (lstatSync(path).isSymbolicLink()) throw new Error(`extractor store: ${path}: derived path is a symbolic link`);}
  catch (error) {if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}
 }
 const stage = `${graphPath}.rebuild`; const backup = `${graphPath}.previous`;
 // A crash between the two renames leaves the closed old graph recoverable.
 if (!existsSync(graphPath) && existsSync(backup)) renameSync(backup,graphPath);
 if (storedDigest(graphPath) === manifest.digest) {
  rmSync(stage,{recursive:true,force:true}); rmSync(backup,{recursive:true,force:true});
  return {path:graphPath,rebuilt:false,commit() {},abort() {}};
 }
 rmSync(stage,{recursive:true,force:true}); mkdirSync(stage,{recursive:true});
 let committed = false;
 return {path:stage,rebuilt:true,
  commit() {
   if (committed) return;
   writeFileSync(join(stage,FILE),JSON.stringify(manifest,null,2)+'\n');
   fault?.('before-rename');
   rmSync(backup,{recursive:true,force:true});
   if (existsSync(graphPath)) renameSync(graphPath,backup);
   try {fault?.('between-renames'); renameSync(stage,graphPath);} catch (error) {if (!existsSync(graphPath) && existsSync(backup)) renameSync(backup,graphPath); throw error;}
   committed=true;
   fault?.('after-promotion');
   // Promotion already succeeded; cleanup failure cannot pretend the old graph is still active.
   try {rmSync(backup,{recursive:true,force:true});} catch (error) {process.stderr.write(`extractor store: ${backup}: promoted graph is active; old backup cleanup failed: ${String(error)}\n`);}
  },
  abort() {if (!committed) rmSync(stage,{recursive:true,force:true});},
 };
}
