/** Private snapshots of declared filesystem inputs; no repository format is interpreted here. */
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ClosureRefusal } from './closure-refusal.js';

export interface FilesystemInput {
  readonly name: string;
  readonly folder: string;
}

export function filesystemInputSnapshotPath(workRoot: string, name: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new ClosureRefusal('plugin-filesystem', `src/plugin/filesystem-inputs.ts:1: invalid filesystem input name ${JSON.stringify(name)}`, 'src/plugin/filesystem-inputs.ts');
  return join(workRoot, 'plugin', 'inputs', name);
}

/** Refuse links and special files. Only isolated copied bytes reach a confined plugin. */
export function snapshotFilesystemInputs(inputs: readonly FilesystemInput[], workRoot: string): readonly FilesystemInput[] {
  const names = new Set<string>();
  return inputs.map((input) => {
    const target = filesystemInputSnapshotPath(workRoot, input.name);
    const refuse = (path: string): never => { throw new ClosureRefusal('plugin-filesystem', `src/plugin/filesystem-inputs.ts:1: input ${input.name} contains a link or nonregular entry at ${path}`, path); };
    if (names.has(input.name)) throw new ClosureRefusal('plugin-filesystem', `src/plugin/filesystem-inputs.ts:1: duplicate input ${input.name}`, input.folder);
    names.add(input.name);
    const source = resolve(input.folder);
    if (resolve(target) === source || resolve(target).startsWith(`${source}/`)) throw new ClosureRefusal('plugin-filesystem', 'src/plugin/filesystem-inputs.ts:1: input snapshot must stand outside its source', input.folder);
    const copy = (from: string, to: string): void => {
      const stat = lstatSync(from);
      if (stat.isSymbolicLink()) return refuse(from);
      if (stat.isDirectory()) {
        mkdirSync(to, { recursive: true });
        for (const entry of readdirSync(from).sort()) copy(join(from, entry), join(to, entry));
      } else if (stat.isFile()) {
        const fd = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          if (!fstatSync(fd).isFile()) return refuse(from);
          writeFileSync(to, readFileSync(fd), { mode: 0o444, flag: 'wx' });
        } finally { closeSync(fd); }
      } else refuse(from);
    };
    if (!lstatSync(source).isDirectory()) refuse(source);
    copy(source, target);
    return { name: input.name, folder: target };
  });
}
