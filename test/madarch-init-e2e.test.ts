/**
 * A newcomer's first vertical, end to end (decision 0029; madarch-m38l.3):
 * a clean products home, the generated training repository as "my repository",
 * `madarch init` in it, the wiki the command prints, the reader's choice of the
 * agent and the one press that fills the graph and flows into the writer. The
 * agent is the hand-written fake ACP agent behind an adapter executable on the
 * PATH, which is exactly the way a real adapter is found: the production path
 * runs, no model does. Nothing here names a script of the checkout besides the
 * `madarch` entry the test runs as the command.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, SAMPLE_IDENTITY, generateTrainingRepository } from './knowledge-fixture.js';
import { agentScript } from './knowledge-agent-script.js';

const FAKE_AGENT = join(ROOT, 'test', 'fixtures', 'acp-fake-agent', 'acp-fake-agent.ts');

let work: string;
let home: string;
let repository: string;
let env: Record<string, string>;
let url = '';
let initOutput = '';

const madarch = (args: string[], cwd: string) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'madarch.ts'), ...args], { cwd, env, encoding: 'utf8', timeout: 120_000 });
const get = async (path: string): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${url}${path}`);
  return { status: response.status, body: await response.json() };
};
const post = async (path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${url}${path}`, { method: 'POST', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
};
const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const listener = createServer();
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', () => { const port = (listener.address() as { port: number }).port; listener.close(() => resolve(port)); });
});

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'madarch-init-e2e-'));
  // "My repository": the training repository, in a folder named like a product.
  repository = generateTrainingRepository(join(work, 'training-shop'));
  home = join(work, 'products');
  const bin = join(work, 'bin');
  mkdirSync(bin);
  mkdirSync(join(work, 'user'));
  const app = join(work, 'app');
  mkdirSync(join(app, 'dist'), { recursive: true });
  writeFileSync(join(app, 'dist', 'index.html'), '<!doctype html><title>app</title><div id="root"></div>');
  writeFileSync(join(work, 'script.json'), JSON.stringify(agentScript()));
  // The adapter the wiki finds by its name, as it finds a real one.
  writeFileSync(join(bin, 'claude-agent-acp'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_AGENT)} --scenario script --script ${JSON.stringify(join(work, 'script.json'))}\n`);
  chmodSync(join(bin, 'claude-agent-acp'), 0o755);
  env = { ...(process.env as Record<string, string>), ...SAMPLE_IDENTITY, HOME: join(work, 'user'), MADARCH_HOME: home, MADARCH_APP: app, PATH: `${bin}:${process.env.PATH ?? ''}`, DISPLAY: '', WAYLAND_DISPLAY: '' };
  delete env['SSH_CONNECTION'];
  delete env['SSH_TTY'];
  const port = await freePort();
  const init = madarch(['init', '--home', home, '--port', String(port), '--no-open'], repository);
  initOutput = `${init.stdout}${init.stderr}`;
  expect(init.status, initOutput).toBe(0);
  url = /The wiki is running at (\S+)/.exec(initOutput)?.[1] ?? '';
}, 180_000);

afterAll(async () => {
  if (work !== undefined) {
    madarch(['stop', '--home', home], work);
    rmSync(work, { recursive: true, force: true });
  }
}, 60_000);

describe('madarch init', () => {
  test('says what happened, where, how to open the wiki and what to do next, without a script of the checkout', () => {
    expect(initOutput).toContain('Created the product "training-shop"');
    expect(initOutput).toContain('Connected your repository');
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/products\/training-shop\/$/);
    expect(initOutput).toContain('Next:');
    expect(initOutput).toContain('Choose the agent');
    expect(initOutput).toContain('"Start the fill"');
    expect(initOutput).toContain('30 turns and 10 minutes');
    expect(initOutput).toContain('madarch stop');
    expect(initOutput).not.toMatch(/\bbun\b|\bnode\b|scripts\//);
    expect(existsSync(join(home, 'training-shop', 'madarch', 'kinds.yaml'))).toBe(true);
  });

  test('the wiki it opens is empty, offers the agents and has run none', async () => {
    const status = await get('api/k/status');
    expect(status.body).toMatchObject({ manifest: 'ok', filled: false, home: null, chosenAgent: null, writer: { state: 'idle' }, repositories: [{ name: 'training-shop', filled: false }] });
    const agents = await get('api/k/agents');
    expect(agents.body.agents.map((offer: { id: string; installed: boolean }) => [offer.id, offer.installed])).toEqual([['claude-code', true], ['codex', false], ['opencode', false], ['omp', false]]);
  });
});

describe('the one press', () => {
  test('chooses the agent, fills the graph and the agent writes the product page and a page per domain, served with their grounds resolved', async () => {
    expect((await post('api/k/agent', { agent: 'claude-code', install: false })).status).toBe(200);
    expect((await post('api/k/fill')).status).toBe(202);
    let status: any = (await get('api/k/status')).body;
    for (let tries = 0; tries < 3600 && !['done', 'failed'].includes(status.writer.state) && status.fill.state !== 'failed'; tries += 1) {
      await new Promise((rest) => setTimeout(rest, 500));
      status = (await get('api/k/status')).body;
    }
    expect(status.fill.state, JSON.stringify(status.fill)).toBe('done');
    expect(status.writer, JSON.stringify(status.writer)).toMatchObject({ state: 'done', units: [{ unit: 'product:training-shop', state: 'written' }, { unit: 'domain:ordering', state: 'written' }, { unit: 'domain:payments', state: 'written' }] });
    expect(status.home).toBe('product:training-shop');

    const pageOf = async (id: string) => (await get(`api/k/page?id=${encodeURIComponent(id)}`));
    const homePage = await pageOf('product:training-shop');
    expect(homePage.status).toBe(200);
    const homeBody = homePage.body.blocks.find((block: { type: string }) => block.type === 'body');
    expect(homeBody.markdown).toContain('The training shop takes orders from shoppers');
    expect(homeBody.ungrounded).toEqual([]);
    const payments = await pageOf('domain:payments');
    expect(payments.status).toBe(200);
    const paymentsBody = payments.body.blocks.find((block: { type: string }) => block.type === 'body');
    expect(paymentsBody.markdown).toContain('Payments are charged through one of two providers chosen by configuration.');
    expect(paymentsBody.ungrounded).toEqual([]);
    for (const model of [homePage.body, payments.body, (await pageOf('domain:ordering')).body]) {
      const resolutions = Object.values(model.resolutions) as { state: string; reason?: string }[];
      expect(resolutions.length).toBeGreaterThan(0);
      for (const resolution of resolutions) expect(resolution.state, resolution.reason).toBe('ok');
    }
    // The pages are Markdown files of the product repository, and the repository's own history is the reader's to commit.
    for (const page of ['docs/product.md', 'docs/domains/ordering.md', 'docs/domains/payments.md']) expect(existsSync(join(home, 'training-shop', page))).toBe(true);
    expect(readFileSync(join(home, 'training-shop', 'docs', 'domains', 'payments.md'), 'utf8')).toContain('producer: agent');

    // The documents are pages of the same wiki: the written pages and the repository's own, and a ground opens the document at its section.
    const documents = (await get('api/k/documents')).body as { documents: { repo: string | null; path: string }[] };
    expect(documents.documents).toContainEqual({ repo: null, path: 'docs/product.md' });
    expect(documents.documents).toContainEqual({ repo: 'training-shop', path: 'docs/requirements.md' });
    const requirements = await get('api/k/document?repo=training-shop&path=docs/requirements.md');
    expect(requirements.status).toBe(200);
    expect(requirements.body.anchors['uc-2']).toBeGreaterThan(0);
    const ground = (homePage.body.resolutions as Record<string, { state: string; href: string | null }>)['madarch:doc:docs/requirements.md#uc-2'];
    expect(ground?.href).toBe('/k/doc?repo=training-shop&path=docs%2Frequirements.md#uc-2');

    // The same press with the language of the pages changed asks the agent in Russian and writes every page again.
    const russian = await post('api/k/fill', { agent: 'claude-code', language: 'ru' });
    expect(russian.status).toBe(202);
    let after: any = (await get('api/k/status')).body;
    for (let tries = 0; tries < 1800 && !(after.language === 'ru' && after.fill.state === 'done' && after.writer.state === 'done'); tries += 1) {
      await new Promise((rest) => setTimeout(rest, 500));
      after = (await get('api/k/status')).body;
    }
    expect(after.writer, JSON.stringify(after.writer)).toMatchObject({ state: 'done' });
    const paymentsRu = await pageOf('domain:payments');
    const paymentsRuBody = paymentsRu.body.blocks.find((block: { type: string }) => block.type === 'body');
    expect(paymentsRuBody.markdown).toContain('Платёж проходит через одного из двух провайдеров');
    expect(paymentsRuBody.ungrounded).toEqual([]);
    expect(paymentsRu.body.findings).toEqual([]);
  }, 1_800_000);
});
