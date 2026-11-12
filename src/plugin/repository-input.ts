/** Isolated read-only repository inputs for ordinary filesystem-capable plugins. */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { RepositoryPin } from './repository-snapshot.js';
import { sandboxInputPath } from './sandbox.js';
import { filesystemInputSnapshotPath } from './filesystem-inputs.js';

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
    const commit = await git(['-C', pin.root, 'rev-parse', '--verify', `${pin.commit}^{commit}`]);
    const format = await git(['-C', pin.root, 'rev-parse', '--show-object-format']);
    await git(['init', '--bare', `--object-format=${format}`, '--', folder]);
    await git(['--git-dir', folder, 'fetch', '--no-tags', '--update-shallow', '--', pin.root, commit]);
    await git(['--git-dir', folder, 'update-ref', '--no-deref', 'HEAD', commit]);
    const remote = await git(['-C', pin.root, 'remote', 'get-url', 'origin']).catch(() => '');
    if (remote !== '') {
      let address = remote;
      try {
        const url = new URL(remote);
        url.username = '';
        url.password = '';
        address = url.toString();
      } catch { /* Git also permits scp-like remote addresses. */ }
      await git(['--git-dir', folder, 'config', 'remote.origin.url', address]);
    }
    filesystemInputs.push({ name, folder });
    repositories.push({ repository: pin.id, root: sandboxInputPath(name, filesystemInputSnapshotPath(workRoot, name)), commit,
      ...(pin.defaultBranch === undefined ? {} : { defaultBranch: pin.defaultBranch }) });
  }
  return { filesystemInputs, repositories };
}
