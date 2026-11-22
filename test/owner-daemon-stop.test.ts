/** Live-daemon stop/restart connection hypothesis, without the full owner-path catalogue. */
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDaemon } from '../src/product/daemon.js';
import { createDraft } from '../src/product/draft.js';
import { SAMPLE_IDENTITY, commitProduct } from './knowledge-fixture.js';
import { gitEnv } from './git-env.js';
import { writeFolderManifest } from './catalog-folder-fixture.js';

const CLI = join(import.meta.dir, '../scripts/madarch.ts');

for (const restart of ['daemon', 'serve'] as const) test(`live daemon stop then ${restart} reads GraphQL on a new server`, async () => {
  const base = mkdtempSync(join(tmpdir(), 'owner-live-daemon-'));
  const home = join(base, 'products');
  const app = join(base, 'app');
  mkdirSync(join(app, 'dist'), { recursive: true });
  await Bun.write(join(app, 'dist', 'index.html'), '<!doctype html><title>Built</title>');
  const made = createDraft({ home, name: 'shop', template: 'none', gitEnv: gitEnv(SAMPLE_IDENTITY) });
  if (made.outcome !== 'created') throw new Error(JSON.stringify(made));
  mkdirSync(join(made.folder, 'madarch'), { recursive: true });
  writeFolderManifest(made.folder, 'kinds:\n  note: { source: graph, origin: person }\n');
  commitProduct(made.folder, 'declare a minimal catalogue');
  const env = { ...process.env, MADARCH_HOME: base, MADARCH_OWN_WIKI: 'off', MADARCH_APP: app, PGAPPNAME: 'owner-live-client' };
  const cli = (args: string[], check = true) => {
    const result = Bun.spawnSync(['bun', CLI, ...args, '--home', home], { env, stdout: 'pipe', stderr: 'pipe' });
    if (check) expect(result.exitCode).toBe(0);
  };
  let standalone: ReturnType<typeof Bun.spawn< 'ignore', 'pipe', 'pipe'>> | undefined;
  const start = async (mode: 'daemon' | 'serve' = 'daemon') => {
    if (mode === 'serve') {
      standalone = Bun.spawn(['bun', CLI, 'serve', '--product', made.folder, '--port', '0', '--no-open'], { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
      let output = '';
      const reader = standalone.stdout.getReader();
      void (async () => { for (;;) { const next = await reader.read(); if (next.done) return; output += new TextDecoder().decode(next.value); } })();
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const url = output.match(/(?:The wiki is running at |Wiki: )(https?:\/\/\S+)/)?.[1];
        if (url !== undefined) return url;
        await Bun.sleep(100);
      }
      throw new Error(`serve printed no address: ${output}`);
    }
    const answer = await ensureDaemon({ home, port: 0, appFolder: app, env, print: () => {} });
    if (!answer.ok) throw new Error(answer.message);
    const url = `${answer.url}/products/shop`;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const response = await fetch(`${url}/api/status`);
      const status = await response.json() as { publication?: string };
      if (response.ok && status.publication === 'done') return url;
      await Bun.sleep(100);
    }
    throw new Error('the minimal catalogue was not published within 30000 ms');
  };
  const read = async (url: string) => {
    const response = await fetch(`${url}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'query { bootstrap { catalogueTemplate } navigation { kinds { kind count } } }' }) });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(body).errors).toBeUndefined();
  };
  try {
    const first = await start();
    await read(first);
    const knowledge = join(home, '.madarch', 'knowledge');
    const id = readdirSync(knowledge).find(name => existsSync(join(knowledge, name, 'graph', 'pgdata')))!;
    const store = join(knowledge, id, 'graph');
    const beforePid = readFileSync(join(store, 'pgdata', 'postmaster.pid'), 'utf8').split('\n')[0];
    cli(['stop']);
    expect(existsSync(join(store, 'pgdata', 'postmaster.pid'))).toBe(false);
    expect(readFileSync(join(store, 'postgres.log'), 'utf8')).toContain('received fast shutdown request');
    const second = await start(restart);
    await read(second);
    const afterPid = readFileSync(join(store, 'pgdata', 'postmaster.pid'), 'utf8').split('\n')[0];
    expect(afterPid).not.toBe(beforePid);
  } finally {
    if (standalone !== undefined) { standalone.kill('SIGTERM'); await standalone.exited; }
    cli(['stop'], false);
  }
}, 120_000);
