/** Isolated read-only repository inputs for ordinary filesystem-capable plugins. */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { RepositoryPin } from './repository-snapshot.js';
import { sandboxInputPath } from './sandbox.js';

function git(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(`repository input: ${stderr.trim() || error.message}`));
      else resolve(stdout.trim());
    });
  });
}

/** Copy objects, not a live checkout or a host Git RPC; resolve every revision before the plugin receives it. */
export async function prepareRepositoryInputs(pins: readonly RepositoryPin[], workRoot: string) {
  const filesystemInputs: { name: string; folder: string }[] = [];
  const repositories: { repository: string; root: string; commit: string; defaultBranch?: string }[] = [];
  for (const [index, pin] of pins.entries()) {
    const name = `repository-${index}`;
    const folder = join(workRoot, name);
    await git(['clone', '--bare', '--no-hardlinks', '--dissociate', '--', pin.root, folder]);
    const commit = await git(['--git-dir', folder, 'rev-parse', '--verify', `${pin.commit}^{commit}`]);
    filesystemInputs.push({ name, folder });
    repositories.push({ repository: pin.id, root: sandboxInputPath(name, folder), commit,
      ...(pin.defaultBranch === undefined ? {} : { defaultBranch: pin.defaultBranch }) });
  }
  return { filesystemInputs, repositories };
}
