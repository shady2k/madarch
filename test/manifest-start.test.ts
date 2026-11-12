import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { writeFolderManifest } from './catalog-folder-fixture.js';
import { seedStarterSet } from '../src/knowledge/seed.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function freePort(): Promise<number> {
  return await new Promise((answer) => {
    const listener = createServer();
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      if (typeof address !== 'object' || address === null) throw new Error('the listener answered no port');
      listener.close(() => answer(address.port));
    });
  });
}

test('madarch start refuses invalid manifests before its wiki listens, printing every full path and line', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-manifest-start-')); roots.push(root);
  const home = join(root, 'products');
  const product = join(home, 'sample'); mkdirSync(product, { recursive: true });
  writeFileSync(join(product, 'workspace.yaml'), 'schemaVersion: 1\nid: sample\nname: sample\n');
  seedStarterSet(product);
  const kinds = join(product, 'madarch', 'catalog.yaml');
  const workflows = join(product, 'madarch', 'workflows.yaml');
  writeFileSync(kinds, 'groups: [\n');
  writeFileSync(workflows, 'workflows: [\n');
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' };
  for (const args of [['init', '--quiet'], ['add', '.'], ['commit', '--quiet', '-m', 'fixture']]) {
    const result = Bun.spawnSync(['git', ...args], { cwd: product, env: gitEnv });
    expect(result.exitCode).toBe(0);
  }
  const app = join(root, 'app'); mkdirSync(join(app, 'dist'), { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { build: 'true' } }));
  writeFileSync(join(app, 'dist', 'index.html'), '<!doctype html><title>Fixture wiki</title>');
  const port = await freePort();
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'scripts', 'madarch.ts'), 'start', '--home', home, '--port', String(port)], {
    env: { ...process.env, MADARCH_HOME: root, MADARCH_APP: app, MADARCH_OWN_WIKI: 'off' }, stdout: 'pipe', stderr: 'pipe',
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).not.toBe(0);
  const said = out + err;
  expect(said).toMatch(new RegExp(kinds.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\d+:'));
  expect(said).toMatch(new RegExp(workflows.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\d+:'));
  await expect(fetch(`http://127.0.0.1:${port}/products/sample/api/status`)).rejects.toThrow();
}, 120_000);


test('daemon publishes and refreshes a never-filled catalogue while content remains unfilled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-manifest-live-')); roots.push(root);
  const home = join(root, 'products');
  const product = join(home, 'sample'); mkdirSync(join(product, 'madarch'), { recursive: true });
  writeFileSync(join(product, 'workspace.yaml'), 'schemaVersion: 1\nid: sample\nname: sample\n');
  const kinds = join(product, 'madarch', 'catalog.yaml');
  writeFileSync(kinds, '{}\n');
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' };
  for (const args of [['init', '--quiet'], ['add', '.'], ['commit', '--quiet', '-m', 'fixture']]) {
    expect(Bun.spawnSync(['git', ...args], { cwd: product, env: gitEnv }).exitCode).toBe(0);
  }
  const app = join(root, 'app'); mkdirSync(app); writeFileSync(join(app, 'index.html'), '<!doctype html><title>Fixture</title>');
  const port = await freePort();
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'scripts', 'madarch.ts'), 'daemon-serve', '--home', home, '--port', String(port)], {
    env: { ...process.env, MADARCH_HOME: root, MADARCH_APP_DIST: app, MADARCH_OWN_WIKI: 'off' }, stdout: 'pipe', stderr: 'pipe',
  });
  let diagnostics = '';
  const errors = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) diagnostics += decoder.decode(chunk, { stream: true });
    return diagnostics;
  })();
  const output = new Response(child.stdout).text();
  const base = `http://127.0.0.1:${port}/products/sample/api`;
  async function until(read: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try { if (await read()) return; } catch { /* listener or next publication not ready */ }
      if (child.exitCode !== null) throw new Error(await errors);
      await Bun.sleep(100);
    }
    throw new Error(`daemon catalogue did not reach the expected publication: ${diagnostics}`);
  }
  try {
    await until(async () => (await fetch(`${base}/catalog`)).ok);
    const initial = await (await fetch(`${base}/status`)).json();
    expect(initial).toMatchObject({ manifest: 'not-filled', filled: false });
    // Prime the reader cache before the valid edit; the manifest journal must invalidate it.
    expect((await (await fetch(`${base}/catalog`)).json()).kinds).toEqual([]);
    mkdirSync(join(product, 'templates')); writeFileSync(join(product, 'templates', 'term.md'), '# Term');
    writeFolderManifest(product, 'kinds:\n  term:\n    source: document\n    template: templates/term.md\n    terms: ["docs/*.md"]\n');
    await until(async () => (await (await fetch(`${base}/catalog`)).json()).kinds.some((one: { kind: string }) => one.kind === 'term'));
    expect(await (await fetch(`${base}/status`)).json()).toMatchObject({ manifest: 'not-filled', filled: false });
    writeFileSync(kinds, 'groups: [\n');
    await until(async () => diagnostics.includes(`${kinds}:`));
    expect((await (await fetch(`${base}/catalog`)).json()).kinds.map((one: { kind: string }) => one.kind)).toEqual(['term']);
    expect(diagnostics).toContain(`${kinds}:`);
  } finally {
    if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; }
    await output; await errors;
  }
}, 120_000);
