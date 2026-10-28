import {existsSync,realpathSync} from 'node:fs';
import * as nativePath from 'node:path';
/** Resolve symlink ancestors before creating a not-yet-existing output folder. */
export function physicalPath(input:string):string {
 let ancestor=nativePath.resolve(input);const missing:string[]=[];
 while(!existsSync(ancestor)) {const parent=nativePath.dirname(ancestor);if(parent===ancestor)throw new Error(`cannot resolve existing ancestor of ${input}`);missing.unshift(nativePath.basename(ancestor));ancestor=parent;}
 return nativePath.resolve(realpathSync(ancestor),...missing);
}
/** Native relative semantics handle drive roots, separators and sibling prefix names. */
export function containsPath(root:string,candidate:string,path:Pick<typeof nativePath,'relative'|'isAbsolute'|'sep'>=nativePath):boolean {
 const relative=path.relative(root,candidate);return relative===''||(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith(`..${path.sep}`));
}
export function safeAuditOutput(output:string,inputs:readonly string[]):string {
 const physical=physicalPath(output);
 for(const input of inputs) if(containsPath(physicalPath(input),physical))throw new Error(`audit output ${output} resolves inside input ${input}`);
 return physical;
}
