/**
 * The pages a run of enrichments takes up, as a reader meets them (madarch-m38l.23): a passage's page carries the
 * passage's own title and the kind the manifest declares before its page stands, and a page links to its journal only
 * where a journal of this machine holds it. The product is a small factory fixture in a scratch folder; the agent is
 * scripted — it writes one rule's page, holds the unit open while the browser-facing status is read, and leaves the
 * other rule unanswered — so the run ends with one page written and one not.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { startServer, type StartedServer } from '../src/server/http.js';
import type { AgentFactory } from '../src/knowledge/product.js';
import { readDocEntities } from '../src/knowledge/doc-entities.js';
import { parseKinds } from '../src/knowledge/kinds.js';
import type { Journal } from '../src/writer/journal.js';
import type { ToolClient, UnitAgent, UnitRequest } from '../src/writer/index.js';
import { gitEnv } from './git-env.js';
import { makeProduct, recordKey, SAMPLE_IDENTITY } from './knowledge-fixture.js';

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' });

const A_TS = ['export function leaf(): number {', '  return 1;', '}', '', 'export function root(): number {', '  return leaf() + 1;', '}', ''].join('\n');
const FILE = recordKey('code.file', 'src/a.ts');
/** Two rules of a person's document: each is a passage the run enriches with a page of its own. */
const RULES = [
  '# Rules',
  '',
  '## BR-1 Refunds are checked',
  '',
  'A refund is checked before it is made.',
  '',
  '## BR-2 The ledger lists numbers',
  '',
  'Every number a completed calculation produced is listed.',
  '',
].join('\n');
const PRODUCT_PAGE = [
  '---', 'id: product:tiny', 'kind: product', 'title: Tiny product', 'relates:', `  - ${FILE}`, 'producer: agent', 'sources: []', '---', '',
  '## What the product is', '',
  'The tiny product counts numbers with a leaf function and a root function.[^1]', '',
  '## Domains', '',
  `- [Numbers](madarch:domain:numbers) are counted in [the source file](madarch:${FILE}).[^2]`, '',
  `[^1]: [a.ts](madarch:${FILE})`, `[^2]: [a.ts](madarch:${FILE})`,
].join('\n');
const DOMAIN_PAGE = [
  '---', 'id: domain:numbers', 'kind: domain', 'title: Numbers', 'relates:', `  - ${FILE}`, 'producer: agent', 'sources: []', '---', '',
  '## How the numbers are counted', '',
  'The root function adds one to what the leaf function returns, so it counts one more.[^1]', '',
  `[^1]: [a.ts](madarch:${FILE})`,
].join('\n');

let work: string;
let home: string;
let productFolder: string;
let repositoryFolder: string;
let server: StartedServer;
/** The holds the test queues: the agent's next held unit waits on one until the test opens it. */
const opens: (() => void)[] = [];
const waits: Promise<void>[] = [];
function hold(): void { let open!: () => void; waits.push(new Promise<void>((resolve) => { open = resolve; })); opens.push(open); }
function release(): void { opens.shift()?.(); }
function releaseAll(): void { for (const open of opens.splice(0)) open(); }
/** The unit the run writes the passage's page for; every other enrichment unit is left unanswered. */
let answered: string | null = null;
const seen: string[] = [];

type AgentWithClose = UnitAgent & { close(): Promise<void> };

/** The document entity behind an enrichment unit's id, read as the fill reads the repository's document. */
function entityOf(unit: string): { id: string; title: string; path: string; anchor: string } {
  const kindsFile = join(productFolder, 'madarch', 'kinds.yaml');
  const kinds = parseKinds(readFileSync(kindsFile, 'utf8'), kindsFile, productFolder);
  const text = readFileSync(join(repositoryFolder, 'docs', 'rules.md'), 'utf8');
  const found = readDocEntities([{ repo: 'tiny', path: 'docs/rules.md', text }], kinds).entities.find((entity) => `enrichment:${entity.id}` === unit);
  if (found === undefined) throw new Error(`no passage of the fixture's document is the unit ${unit}`);
  return { id: found.id, title: found.title, path: found.path, anchor: found.anchor };
}

const agent: AgentWithClose = {
  async run(request: UnitRequest): Promise<void> {
    seen.push(request.id);
    if (request.id.startsWith('enrichment:')) {
      // The first passage is held open, so the status is read while its page is being written and before it stands;
      // the other passages are left unanswered, and their pages do not stand when the run ends.
      if (answered !== null) return;
      answered = request.id;
      await (waits.shift() ?? Promise.resolve());
      const entity = entityOf(request.id);
      const written = await request.tools.call('write_enrichment', { statement: { text: 'A refund is checked before it is made.', grounds: [`doc:${entity.path}#${entity.anchor}`] } });
      if (written.isError) throw new Error(`the enrichment was refused: ${JSON.stringify(written.answer)}`);
      return;
    }
    if (request.id === 'product:tiny') {
      const written = await request.tools.call('write_page', {
        markdown: PRODUCT_PAGE,
        domains: [{ slug: 'numbers', title: 'Numbers', summary: 'The numbers are counted by the leaf and the root functions.', evidence: [FILE] }],
      });
      if (written.isError) throw new Error(`the product page was refused: ${JSON.stringify(written.answer)}`);
      return;
    }
    if (request.id === 'domain:numbers') {
      const written = await request.tools.call('write_page', { markdown: DOMAIN_PAGE });
      if (written.isError) throw new Error(`the domain page was refused: ${JSON.stringify(written.answer)}`);
    }
  },
  async close(): Promise<void> {},
};

/** The scripted agent with its calls written to the run's journal, as the agent layer writes a real agent's. */
function journaled(script: AgentWithClose, journal: Journal): AgentWithClose {
  return {
    async run(request: UnitRequest): Promise<void> {
      const context = { run: journal.run, unit: request.id, agent: 'claude-code', model: null, session: null };
      const tools: ToolClient = {
        definitions: request.tools.definitions,
        finished: () => request.tools.finished(),
        call: async (tool: string, argumentsValue: unknown) => {
          const startedAt = new Date();
          const answer = await request.tools.call(tool, argumentsValue);
          const reply = JSON.stringify(answer.answer ?? null);
          journal.record(context, { kind: 'tool-call', tool, arguments: argumentsValue, response: reply, isError: answer.isError, outcome: answer.isError ? 'refused' : 'ok', reason: answer.isError ? reply : null, startedAt, durationMs: Date.now() - startedAt.getTime() });
          return answer;
        },
      };
      await script.run({ ...request, tools });
    },
    close: () => script.close(),
  };
}

const agentFactory: AgentFactory = (_agentId: string, journal: Journal) => journaled(agent, journal);

const get = async (path: string): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${server.url}/products/tiny${path}`);
  return { status: response.status, body: await response.json() };
};
const post = async (path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${server.url}/products/tiny${path}`, { method: 'POST', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
};
async function until<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, tries = 600): Promise<T> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((rest) => setTimeout(rest, 250));
  }
  throw new Error(`gave up waiting for ${what}`);
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'madarch-enrichment-units-'));
  const repository = join(work, 'repo');
  repositoryFolder = repository;
  mkdirSync(join(repository, 'src'), { recursive: true });
  mkdirSync(join(repository, 'docs'), { recursive: true });
  writeFileSync(join(repository, 'docs', 'rules.md'), RULES);
  git(repository, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(join(repository, 'src', 'a.ts'), A_TS);
  writeFileSync(join(repository, 'package.json'), '{"name":"tiny","dependencies":{}}\n');
  git(repository, 'add', '.');
  git(repository, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Add the leaf and the root', '--date', '2026-03-01T10:00:00Z');
  home = join(work, 'home');
  mkdirSync(home);
  productFolder = makeProduct(home, 'tiny', repository, 'tiny');
  // The passage pages are a kind of the wiki too: a product shows them only when its manifest declares the kind.
  const kindsFile = join(productFolder, 'madarch', 'kinds.yaml');
  const kinds = parseDocument(readFileSync(kindsFile, 'utf8'));
  kinds.setIn(['kinds', 'enrichment'], { template: 'templates/product.md', source: 'markdown', folder: 'docs/enrichment', origin: 'agent', labels: { en: { one: 'Enrichment', many: 'Enrichments' } } });
  writeFileSync(kindsFile, kinds.toString());
  mkdirSync(join(productFolder, 'docs'), { recursive: true });
  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>app</title><div id="root"></div>');
  const bin = join(work, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude-agent-acp'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'claude-agent-acp'), 0o755);
  mkdirSync(join(work, 'user'));
  server = await startServer({
    productHome: home, appFolder: app, port: 0, knowledgeRoot: join(work, 'store'), log: () => undefined, errorLog: () => undefined,
    env: { ...process.env, HOME: join(work, 'user'), MADARCH_HOME: join(work, 'user', 'madarch'), PATH: bin },
    knowledgeAgentFactory: agentFactory,
  });
  await fetch(`${server.url}/products/tiny/api/k/status`);
}, 60_000);

afterAll(async () => {
  releaseAll();
  await server.stop();
  rmSync(work, { recursive: true, force: true });
});

describe('a passage’s page before it stands', () => {
  test('is named by the passage’s title and the manifest’s kind, and links to a journal only where one holds it', async () => {
    expect((await get('/api/k/status')).body.writer.units).toEqual([]);
    expect((await post('/api/k/agent', { agent: 'claude-code', install: false })).status).toBe(200);
    hold(); // the first passage the run takes up
    const started = post('/api/k/fill', { agent: 'claude-code' });
    const writing = await until('the first passage to be writing', async () => (await get('/api/k/status')).body, (body) => body.writer.units.some((unit: { unit: string; state: string }) => unit.unit.startsWith('enrichment:') && unit.state === 'writing'));
    const row = writing.writer.units.find((unit: { unit: string; state: string }) => unit.unit.startsWith('enrichment:') && unit.state === 'writing') as { unit: string; kind: string; title: string; page: string; path: string };
    const entity = entityOf(row.unit);
    // The reader's name for a page the run is writing now: the passage's own title, and the kind the manifest declares.
    // Never the writer's id for it, which names the work and not the page.
    expect(row.unit).toBe(`enrichment:${entity.id}`);
    expect(row.title).toBe(entity.title);
    expect(row.title.startsWith('BR-1')).toBe(true);
    expect(row.title).not.toContain('doc:');
    expect(row.kind).toBe('enrichment');
    expect(row.page).toBe(`enrichment:${entity.id}`);
    expect(row.path.startsWith('docs/enrichment/')).toBe(true);
    // The pages the run means to write: the product page, a page per passage of the document, and the two guides.
    expect(writing.writer.total).toBe(1 + 1 + 2 + 2);
    release();
    const done = await until('the writer to end', async () => (await get('/api/k/status')).body, (body) => body.writer.state === 'done' || body.writer.state === 'failed');
    expect((await started).status).toBe(202);
    // The passage the test held is the one the agent answered.
    expect(answered).toBe(row.unit);
    expect(done.writer.state).toBe('failed');
    const rows = done.writer.units as { unit: string; state: string; journal?: boolean }[];
    const page = rows.find((unit) => unit.unit === row.unit)!;
    // The page the run wrote: written, and its journal is this run's.
    expect([page.state, page.journal]).toEqual(['written', true]);
    // The passage the agent left unanswered: no page, and no journal to link to — the row says nothing of one.
    const silent = rows.filter((unit) => unit.unit.startsWith('enrichment:') && unit.unit !== row.unit);
    expect(silent.length).toBe(1);
    // The unit the agent answered with nothing: the writer says it wrote no page rather than that it failed.
    expect(['failed', 'not-written']).toContain(silent[0]!.state);
    expect(silent[0]!.journal === true).toBe(false);
    // The product page this run wrote holds a journal too.
    expect(rows.filter((unit) => unit.unit === 'product:tiny').map((unit) => [unit.state, unit.journal])).toEqual([['written', true]]);
    // The journal the page links to is the run's own: the record of the one call that wrote it.
    const journal = await get(`/api/k/journal?id=${encodeURIComponent(row.unit)}`);
    expect(journal.status).toBe(200);
    expect(journal.body.records.map((record: { tool: string }) => record.tool)).toEqual(['write_enrichment']);
  }, 300_000);
});
