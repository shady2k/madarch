/**
 * The fill role a server starts is served again after it ends by itself (madarch-47vw.7): a pressed fill waits in the
 * store's queue, the role claims it, and a role that ends while the server still serves must not leave the press waiting
 * for a daemon restart. This case ends only the host's own role, finds a distinct replacement without restarting the
 * server, and then presses a queued, confined, plugins-only fill whose end reaches `done` through that replacement; the
 * stop that follows leaves no role and no replacement behind.
 *
 * It is a slow-file entry of its own (`test/slow-files.json`): one real fill of a fixture costs about 19 s on a runner
 * (the note there), and the case pays the store's preparation, the fill and both ends of the role on a two-vCPU box. The
 * supervision itself — the ladder, the healthy-uptime reset, a refused start, a stop cancelling a pending replacement — is
 * checked in milliseconds by `test/fill-role-supervision.test.ts`, which runs in the blocking shards.
 */
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { knowledgeRootOf } from '../src/product/store.js';
import { startPreparedServer } from './prepared-server.js';
import { gitEnv } from './git-env.js';
import { makeProduct, SAMPLE_IDENTITY, withRepositoryPluginsOnly } from './knowledge-fixture.js';

const work = mkdtempSync(join(tmpdir(), 'madarch-fill-service-'));
const home = join(work, 'home');
let url = '';
let server: { stop(): Promise<void> } | undefined;
const said: string[] = [];

afterAll(async () => {
  await server?.stop().catch(() => undefined);
  rmSync(work, { recursive: true, force: true });
});

interface Row {
  readonly pid: number;
  readonly stat: string;
  readonly command: string;
}

/** The process table, as `ps` prints it: this file's roles are found by the home the server gives them. */
function processes(): Row[] {
  const listed = spawnSync('ps', ['-A', '-o', 'pid=,stat=,command='], { encoding: 'utf8' });
  return (listed.stdout ?? '').split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return match === null ? [] : [{ pid: Number(match[1]), stat: match[2]!, command: match[3]! }];
  });
}

/** The fill roles running for this file's home: a zombie is not a role that runs. */
function fillRoles(): Row[] {
  return processes().filter((row) => !row.stat.startsWith('Z') && row.command.includes('--role fill') && row.command.includes(`--home ${home}`));
}

/** Waits for the answer the case needs, saying what was missing when it never comes. */
async function waitFor<T>(what: string, within: number, found: () => T | undefined): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const answer = found();
    if (answer !== undefined) return answer;
    if (Date.now() - startedAt >= within) throw new Error(`${what} within ${String(within)} ms; the fill roles of ${home} are ${fillRoles().map((row) => String(row.pid)).join(',') || 'none'}`);
    await Bun.sleep(20);
  }
}

/** The pressed fill's state, as the server reports it. */
async function fillState(): Promise<string> {
  const answer = await fetch(`${url}/api/status`);
  expect(answer.status).toBe(200);
  return ((await answer.json()) as { fill?: { state?: string } }).fill?.state ?? '';
}

test('the role replaced by the server serves a queued confined fill to its end, and the stop leaves nothing behind', async () => {
  const t0 = Date.now();
  const env = gitEnv(SAMPLE_IDENTITY);
  const repository = join(work, 'repo');
  mkdirSync(join(repository, 'src'), { recursive: true });
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repository, env });
  writeFileSync(join(repository, 'src', 'a.ts'), 'export const price = 10;\n');
  execFileSync('git', ['add', '-A'], { cwd: repository, env });
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'one'], { cwd: repository, env });
  mkdirSync(home, { recursive: true });
  const folder = makeProduct(home, 'shop', repository, 'shop-code');
  // The deterministic repository plugins only: the fill runs under the normal confinement and no plugin of this product
  // asks a model, so the run makes no model call.
  withRepositoryPluginsOnly(folder);
  const plugins = (parse(readFileSync(join(folder, 'madarch', 'catalog.yaml'), 'utf8')) as { plugins?: { id: string }[] }).plugins?.map((plugin) => plugin.id) ?? [];
  expect(plugins).toEqual(['disk', 'git']);
  const app = join(work, 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>service fixture</title>');
  const started = await startPreparedServer({
    productFolder: folder,
    knowledgeRoot: knowledgeRootOf(home),
    appFolder: app,
    port: 0,
    log: (line) => said.push(line),
    errorLog: (line) => said.push(line),
  });
  server = started;
  url = started.url;
  console.log(`fixture and server: ${String(Date.now() - t0)} ms`);

  // Only the host's own role is ended: the server keeps serving, and nothing else is signalled.
  const first = await waitFor('a fill role of the started server', 30_000, () => fillRoles()[0]);
  process.kill(first.pid, 'SIGKILL');
  const second = await waitFor(`a fill role of ${home} other than ${String(first.pid)}`, 20_000, () => fillRoles().find((row) => row.pid !== first.pid));
  expect(second.pid).not.toBe(first.pid);
  console.log(`role ${String(first.pid)} ended; ${String(second.pid)} stood in its place; no server was restarted`);

  // The queue the daemon serves is taken again: the press reaches the replacement, which claims it and runs it.
  const pressedAt = Date.now();
  const pressed = await fetch(`${url}/api/fill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: null }) });
  expect(pressed.status).toBe(202);
  let state = '';
  const finishedBy = Date.now() + 300_000;
  while (state !== 'done' && state !== 'failed' && Date.now() < finishedBy) {
    state = await fillState();
    if (state !== 'done' && state !== 'failed') await Bun.sleep(250);
  }
  console.log(`the queued confined fill ended ${state} after ${String(Date.now() - pressedAt)} ms through role ${String(second.pid)}`);
  expect(state, 'the queued fill did not end through the role that replaced the ended one').toBe('done');
  // The graph the finished fill wrote is read through the same daemon: no restart, no manual repair.
  expect((await fillState())).toBe('done');

  // A stop ends the role it has, and the replacement it would have waited for starts nothing.
  await started.stop();
  server = undefined;
  await Bun.sleep(2_000);
  expect(fillRoles().map((row) => row.pid), `a fill role of ${home} still ran after the server stopped`).toEqual([]);
}, 400_000);
