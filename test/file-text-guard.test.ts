/**
 * The read's guard (madarch-u3vw.16, decision 0037): a page's text is read only from a repository the product connected,
 * by a plugin the product locked, inside the product's own folder. Each refusal names the file and what is wrong, so a
 * request that lies about its paths is answered with words, never a read.
 */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyBlobRead } from '../src/knowledge/file-texts.js';
import { closureOf } from '../src/plugin/closure.js';
import { sdkClosureFiles } from '../src/plugin/closure.js';
import { createHash } from 'node:crypto';

const IDENTITY = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
const git = (root: string, ...args: string[]): string => execFileSync('git', args, { cwd: root, env: { ...process.env, ...IDENTITY }, encoding: 'utf8' });

/** A product folder with a repository checkout and a locked plugin, shaped like a filled product. */
function product(): { folder: string; repo: string } {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-file-guard-'));
  writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: sample\nname: sample\n');
  const plugin = join(folder, 'plugins', 'git');
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({ name: 'git', version: '1.0.0', entry: 'entry.ts', runtime: { name: 'bun', version: Bun.version }, produces: [{ kind: 'code.file', fields: '*', partition: 'key' }] }));
  writeFileSync(join(plugin, 'contract.json'), JSON.stringify({ id: 'git', version: '1.0.0', outputs: { vertices: [{ kind: 'code.file', key: ['repository', 'path'], fields: [{ name: 'path', type: 'text', meaning: 'p', example: 'a.ts', required: true }] }], edges: [] }, rights: { network: 'none', filesystem: true } }));
  writeFileSync(join(plugin, 'entry.ts'), `import { definePlugin } from 'madarch-plugin-sdk';\nawait definePlugin({name:'git',version:'1.0.0',contract:{vertices:[],edges:[]},extract:()=>({end:{state:'complete'}})});`);
  const repo = join(folder, 'repos', 'sample');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(join(repo, 'a.ts'), 'export const answer = 42;\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '--quiet', '-m', 'first');
  return { folder, repo };
}

test('a read is refused by name for a product, a plugin or a repository that is not the product\'s', () => {
  const held = product();
  try {
    const ask = { product: held.folder, plugin: join('plugins', 'git'), repository: 'sample', root: held.repo, blob: 'a'.repeat(40) };
    expect(() => verifyBlobRead(ask)).toThrow('names no plugin');
    // The lock names the closure, so the read is allowed once the lock stands.
    const closure = createHash('sha256').update('x').digest('hex');
    mkdirSync(join(held.folder, 'madarch'), { recursive: true });
    writeFileSync(join(held.folder, 'madarch', 'plugins.lock'), `plugins:\n  - id: git\n    version: 1.0.0\n    closure: ${closure}\n    path: plugins/git\n`);
    expect(() => verifyBlobRead(ask)).toThrow('hashes to');
    expect(() => verifyBlobRead({ ...ask, plugin: join('..', 'elsewhere') })).toThrow('is not inside the product');
    expect(() => verifyBlobRead({ ...ask, root: join(held.folder, 'src') })).toThrow('is not read from the product\'s repos/');
    expect(() => verifyBlobRead({ ...ask, product: join(held.folder, 'nothing') })).toThrow('holds no workspace.yaml');
    void sdkClosureFiles;
  } finally {
    rmSync(held.folder, { recursive: true, force: true });
  }
});

test('a repository or a plugin folder that is a link out of the product is refused by where it really goes', () => {
  // The owner's review of madarch-u3vw.16: product/repos/sample as a link to an outside Git repository was accepted.
  const held = product();
  const outside = mkdtempSync(join(tmpdir(), 'madarch-file-guard-outside-'));
  try {
    git(outside, 'init', '--quiet', '--initial-branch=main');
    writeFileSync(join(outside, 'a.ts'), 'export const answer = 42;\n');
    git(outside, 'add', '-A'); git(outside, 'commit', '--quiet', '-m', 'outside');
    // The lock names the plugin's real closure, so the lock is not what refuses the read.
    const closure = closureOf(join(held.folder, 'plugins', 'git')).hash;
    mkdirSync(join(held.folder, 'madarch'), { recursive: true });
    writeFileSync(join(held.folder, 'madarch', 'plugins.lock'), `plugins:\n  - id: git\n    version: 1.0.0\n    closure: ${closure}\n    path: plugins/git\n`);
    const ask = { product: held.folder, plugin: join('plugins', 'git'), repository: 'sample', root: held.repo, blob: 'a'.repeat(40) };
    expect(() => verifyBlobRead(ask)).not.toThrow();
    // The connected repository is replaced by a link to a repository outside the product.
    rmSync(held.repo, { recursive: true, force: true });
    symlinkSync(outside, held.repo);
    expect(() => verifyBlobRead(ask)).toThrow(/resolves to .*which is neither the product .* nor a folder its repos\/ holds/);
    // The plugin folder that links out of the product is refused too.
    const escaped = join(outside, 'plugin');
    mkdirSync(escaped, { recursive: true });
    writeFileSync(join(escaped, 'plugin.json'), '{}');
    const pluginFolder = join(held.folder, 'plugins', 'git');
    rmSync(pluginFolder, { recursive: true, force: true });
    symlinkSync(escaped, pluginFolder);
    expect(() => verifyBlobRead(ask)).toThrow(/which is not inside the product/);
  } finally {
    rmSync(held.folder, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
