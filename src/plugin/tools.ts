/** Declared executable inputs: caller-approved bytes, copied before a plugin starts. */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClosureRefusal } from './closure-refusal.js';
import type { PluginManifest } from './closure.js';
import { systemGit } from './system-git.js';

export type TrustedTool = { readonly sha256: string } & (
  | { readonly executable: string }
  | { readonly bytes: Uint8Array }
);
export interface SandboxTool {
  readonly name: string;
  readonly executable: string;
}

/** Exact-digest tools are copied; declared system Git is approved by resolved path and version. */
export function snapshotTools(declarations: PluginManifest['tools'], trusted: Readonly<Record<string, TrustedTool>>, workRoot: string, env: Readonly<Record<string, string | undefined>> = process.env): readonly SandboxTool[] {
  const folder = join(workRoot, 'tools');
  const names = new Set<string>();
  return (declarations ?? []).map((declaration) => {
    const refuse = (message: string): never => { throw new ClosureRefusal('plugin-tool', `src/plugin/tools.ts:1: ${message}`, 'src/plugin/tools.ts'); };
    if (names.has(declaration.name)) refuse(`duplicate tool ${declaration.name}`);
    names.add(declaration.name);
    if ('source' in declaration) return systemGit(declaration.minimumVersion, env);
    const tool = trusted[declaration.name];
    if (tool === undefined || tool.sha256 !== declaration.sha256) return refuse(`tool ${declaration.name} has no approved executable pin matching its declaration`);
    let bytes: Buffer;
    try {
      if ('bytes' in tool) bytes = Buffer.from(tool.bytes);
      else {
        const stat = lstatSync(tool.executable);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) refuse(`tool ${declaration.name} is not a regular executable file`);
        bytes = readFileSync(tool.executable);
      }
    } catch (error) {
      if (error instanceof ClosureRefusal) throw error;
      return refuse(`tool ${declaration.name} cannot read approved executable ${'executable' in tool ? tool.executable : 'embedded bytes'}: ${(error as Error).message}; supply an executable with the approved pin`);
    }
    if (createHash('sha256').update(bytes).digest('hex') !== declaration.sha256) refuse(`tool ${declaration.name} differs from its approved sha256`);
    mkdirSync(folder, { recursive: true });
    const executable = join(folder, declaration.name);
    writeFileSync(executable, bytes, { mode: 0o555, flag: 'wx' });
    return { name: declaration.name, executable };
  });
}
