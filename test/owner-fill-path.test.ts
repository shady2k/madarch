/**
 * The owner's path on a fresh product (madarch-64o5.71, PR #303): `madarch init`, a small code repository linked, `madarch
 * serve`, the catalogue and the fill press, and the graph the fill leaves. Every step goes over the server's HTTP and
 * GraphQL addresses; no product code is called directly.
 */
import { afterAll, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { excludedPath } from '../plugins/disk/reader.js';
import { readKinds } from '../src/product/manifest/kinds.js';

const CLI = fileURLToPath(new URL('../scripts/madarch.ts', import.meta.url));
const IDENTITY = { GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.test', GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.test' };
const root = mkdtempSync(join(tmpdir(), 'madarch-owner-fill-'));
const home = join(root, 'products');
const app = join(root, 'app');
const code = join(root, 'code');
let serve: ReturnType<typeof Bun.spawn> | undefined;
const failures: string[] = [];

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...IDENTITY, MADARCH_HOME: home, MADARCH_OWN_WIKI: 'off', MADARCH_APP: app, ...overrides };
}

function run(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bun', [CLI, ...args], { encoding: 'utf8', timeout: 180_000, cwd: options.cwd ?? root, env: env(options.env) });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function git(folder: string, args: string[]): string {
  return execFileSync('git', args, { cwd: folder, encoding: 'utf8', env: { ...process.env, ...IDENTITY } });
}

function freePort(): Promise<number> {
  return new Promise((resolvePort) => { const listener = createServer(); listener.listen(0, '127.0.0.1', () => { const address = listener.address(); const port = typeof address === 'object' && address ? address.port : 0; listener.close(() => resolvePort(port)); }); });
}

async function step(name: string, work: () => Promise<void>): Promise<void> {
  try { await work(); } catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
}

async function graphql(query: string, variables: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const answer = await fetch(`${address}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  const body = (await answer.json()) as { data?: Record<string, any>; errors?: { message: string }[] };
  if (answer.status !== 200 || (body.errors?.length ?? 0) > 0) throw new Error(`the graph answered ${String(answer.status)}: ${(body.errors ?? []).map((one) => one.message).join('; ') || JSON.stringify(body)}`);
  return body.data ?? {};
}

let address = '';
let folder = '';
let runId = '';

afterAll(async () => {
  try { serve?.kill(); } catch { /* already gone */ }
  try { run(['stop']); } catch { /* no daemon */ }
  rmSync(root, { recursive: true, force: true });
});

test('the owner starts a fresh product, serves it, plans and runs the code fill, and reads the result', async () => {
  // The small code repository the product will read: two folders and three files.
  mkdirSync(join(code, 'src', 'lib'), { recursive: true });
  writeFileSync(join(code, 'README.md'), '# Code\n');
  writeFileSync(join(code, 'src', 'main.ts'), 'export const main = 1;\n');
  writeFileSync(join(code, 'src', 'lib', 'util.ts'), 'export const util = 2;\n');
  git(code, ['init', '--quiet', '--initial-branch=main']);
  git(code, ['add', '-A']);
  git(code, ['commit', '--quiet', '-m', 'The code']);
  mkdirSync(join(app, 'dist'), { recursive: true });
  writeFileSync(join(app, 'dist', 'index.html'), '<!doctype html><title>Built</title>');
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', private: true, scripts: { build: 'true' } }));
  mkdirSync(home, { recursive: true });

  await step('1 init makes the code repository itself a fresh product', async () => {
    const made = run(['init', code, '--template', 'everything', '--no-open', '--json', '--port', String(await freePort())]);
    if (made.status !== 0) throw new Error(`init exited ${String(made.status)}: ${made.stderr || made.stdout}`);
    const facts = JSON.parse(made.stdout.trim().split('\n').at(-1)!) as { folder?: string; url?: string; linked?: string };
    if (facts.folder === undefined) throw new Error(`init printed no folder: ${made.stdout}`);
    folder = facts.folder;
    if (facts.linked === undefined) throw new Error(`init did not keep the code repository as the product's source: ${made.stdout}`);
  });
  if (folder === '') { expect(failures).toEqual([]); return; }

  await step('2 madarch serve answers', async () => {
    run(['stop']);
    serve = Bun.spawn(['bun', CLI, 'serve', '--product', folder, '--port', '0', '--no-open'], { cwd: root, env: env(), stdout: 'pipe', stderr: 'pipe' });
    let stdout = '';
    const reader = (serve.stdout as ReadableStream).getReader();
    void (async () => { for (;;) { const { done, value } = await reader.read(); if (done) break; stdout += new TextDecoder().decode(value); } })();
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      const line = stdout.split('\n').find((one) => one.startsWith('The wiki is running at ') || one.startsWith('Wiki: '));
      address = line?.match(/(https?:\/\/\S+)/)?.[1] ?? '';
      if (address !== '') { try { if ((await fetch(`${address}/api/status`)).status !== 0) break; } catch { /* not listening yet */ } }
      await Bun.sleep(100);
    }
    if (address === '') throw new Error(`serve printed no address; stdout was ${JSON.stringify(stdout)}`);
  });
  if (address === '') { expect(failures).toEqual([]); return; }

  await step('2 the wiki home answers 200', async () => {
    const answer = await fetch(`${address}/`);
    if (answer.status !== 200) throw new Error(`GET / answered ${String(answer.status)}: ${await answer.text()}`);
  });
  await step('2 the catalogue page answers 200', async () => {
    const answer = await fetch(`${address}/p/catalogue`);
    if (answer.status !== 200) throw new Error(`GET /p/catalogue answered ${String(answer.status)}: ${await answer.text()}`);
  });
  await step('2 the home and catalogue GraphQL reads answer without errors', async () => {
    const data = await graphql(`query { bootstrap { catalogueTemplate } navigation { kinds { kind count } } allCatalogueEntity(first: 1) { totalCount } }`);
    if (data['bootstrap'] === undefined || data['navigation'] === undefined) throw new Error('the graph answered no bootstrap or navigation');
  });

  await step('3 the plugins-only fill plan leaves no field of the code kinds to the agent', async () => {
    const planned = await fetch(`${address}/api/fill-plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selected: ['code.repository', 'code.directory', 'code.file'], pluginsOnly: true }) });
    const view = (await planned.json()) as { plan?: { needsAgent?: { kind: string; fields: string[] }[]; pluginsOnly?: boolean } };
    if (planned.status !== 200) throw new Error(`POST /api/fill-plan answered ${String(planned.status)}: ${JSON.stringify(view)}`);
    if (view.plan?.pluginsOnly !== true) throw new Error(`the plan is not plugins-only: ${JSON.stringify(view)}`);
    // Every field of the three code kinds is a producer's: the state machines are a kind of their own (madarch-64o5.114).
    const named = view.plan?.needsAgent?.find((need) => need.kind === 'code.file')?.fields ?? [];
    if (named.length !== 0) throw new Error(`the plan leaves code.file fields to the agent: ${JSON.stringify(named)}`);
    if ((view.plan?.needsAgent ?? []).some((need) => ['code.repository', 'code.directory', 'code.file'].includes(need.kind))) throw new Error(`the plan names an agent need among the code kinds: ${JSON.stringify(view.plan?.needsAgent)}`);
  });

  await step('3 the fill plan names the code kinds only, with plugin units and no agent', async () => {
    const answer = await fetch(`${address}/api/fill-selected`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selected: ['code.repository', 'code.directory', 'code.file'], agent: null, tokenCap: null, pluginsOnly: true }) });
    const body = (await answer.json()) as { runId?: string; order?: string[]; plan?: { needsAgent?: { kind: string; fields: string[] }[] }; error?: { message?: string } };
    if (answer.status !== 202) throw new Error(`POST /api/fill-selected answered ${String(answer.status)}: ${body.error?.message ?? JSON.stringify(body)}`);
    if (body.runId === undefined) throw new Error('the fill press answered no run id');
    const left = body.plan?.needsAgent?.find((need) => need.kind === 'code.file')?.fields ?? [];
    if (left.length !== 0) throw new Error(`the press leaves code.file fields to the agent: ${JSON.stringify(left)}`);
    runId = body.runId;
    const order = [...(body.order ?? [])].sort();
    if (JSON.stringify(order) !== JSON.stringify(['code.directory', 'code.file', 'code.repository'])) throw new Error(`the plan is ${JSON.stringify(order)}, not the three code kinds`);
    // The units the run planned: the plugin stage only, and a producer on every group.
    const start = Date.now();
    let detail: any;
    while (Date.now() - start < 30_000) {
      detail = ((await (await fetch(`${address}/api/fill-runs?run=${encodeURIComponent(runId)}`)).json()) as any).run;
      if ((detail?.units?.length ?? 0) > 0 || ['succeeded', 'completed_partial', 'failed', 'blocked', 'cancelled'].includes(detail?.state)) break;
      await Bun.sleep(100);
    }
    if ((detail?.units?.length ?? 0) === 0) throw new Error(`the run planned no units: ${JSON.stringify(detail)}`);
    const stages = new Set((detail.units as { stage: string }[]).map((unit) => unit.stage));
    if (JSON.stringify([...stages]) !== JSON.stringify(['plugin-turns'])) throw new Error(`the plan's stages are ${JSON.stringify([...stages])}, not plugin-turns alone`);
    if ((detail.groups ?? []).some((group: { plugin: string | null }) => group.plugin === null)) throw new Error(`a plan group has no plugin: ${JSON.stringify(detail.groups)}`);
  });

  await step('4 the fill runs to its end, completed', async () => {
    const start = Date.now();
    let detail: any;
    while (Date.now() - start < 180_000) {
      detail = ((await (await fetch(`${address}/api/fill-runs?run=${encodeURIComponent(runId)}`)).json()) as any).run;
      if (['succeeded', 'completed_partial', 'failed', 'blocked', 'cancelled'].includes(detail?.state)) break;
      await Bun.sleep(250);
    }
    if (detail?.state !== 'succeeded') throw new Error(`the fill ended ${String(detail?.state)}: ${JSON.stringify(detail?.summary?.error ?? detail?.error ?? detail?.events?.slice(-2) ?? detail)}`);
  });

  await step('5 the code-kind counts are the repository tree', async () => {
    const data = await graphql(`query { navigation { kinds { kind count } } allCodeFile(first: 1) { totalCount edges { node { id path } } } }`);
    const counts = new Map((data['navigation'].kinds as { kind: string; count: number }[]).map((one) => [one.kind, one.count] as const));
    // The paths the product's own kinds leave out are no part of its knowledge: its declaration is the rule, and the
    // plugin's matcher reads it here as the fill did (madarch-64o5.83).
    const declared = readKinds(folder);
    if (!declared.present) throw new Error('the product holds no manifest');
    const patterns = [...new Set([...(declared.manifest.kinds.get('code.file')?.exclude ?? []), ...(declared.manifest.kinds.get('code.directory')?.exclude ?? [])])];
    const listed = (repo: string): string[] => git(repo, ['ls-files']).split('\n').filter(Boolean).filter((path) => !excludedPath(path, patterns));
    const files = listed(folder).concat(listed(code));
    // Every folder a file lies in, and every folder above it: the plugin makes one directory entity for each.
    const directories = new Set<string>();
    for (const path of files) {
      let folderPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      while (folderPath !== '') { directories.add(folderPath); const at = folderPath.lastIndexOf('/'); folderPath = at < 0 ? '' : folderPath.slice(0, at); }
    }
    const expected = { 'code.repository': 2, 'code.directory': directories.size, 'code.file': files.length };
    for (const [kind, count] of Object.entries(expected)) {
      if (counts.get(kind) !== count) throw new Error(`${kind} counts ${String(counts.get(kind))}, and the repositories hold ${String(count)}`);
    }
    const all = data['allCodeFile'] as { totalCount: number; edges: { node: { id: string; path: string } }[] };
    if (all.totalCount === 0) throw new Error('the graph holds no code file');
    const file = all.edges[0]!.node;
    if (!files.includes(file.path)) throw new Error(`the file ${file.path} is no file of the repositories`);
    const one = await graphql(`query ($id: ID!) { entity(id: $id) { kind label ... on KindCodeFile { path } } }`, { id: file.id });
    if (one['entity']?.path !== file.path) throw new Error(`the file page answered ${JSON.stringify(one['entity'])}, not the path ${file.path}`);
    const page = await fetch(`${address}/e/code.file/${encodeURIComponent(file.id)}`);
    if (page.status !== 200) throw new Error(`the file page answered ${String(page.status)}: ${await page.text()}`);
  });

  expect(failures).toEqual([]);
}, 300_000);
