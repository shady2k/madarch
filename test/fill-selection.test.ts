/** The fill page's press uses the same target resolution and engine as the CLI, without saving a draft selection. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { readRunUnits } from '../src/fill/state-store.js';
import { checkCgroupDelegation, cgroupParent } from '../src/plugin/cgroup.js';
import { createDraft } from '../src/product/draft.js';
import { manifestWithRepo } from '../src/product/manifest.js';
import { productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { sandboxSetupProblem } from '../src/plugin/sandbox.js';
import { startServer, type StartedServer } from '../src/server/http.js';
import { createKnowledgePart } from '../src/server/knowledge.js';
import type { KnowledgeProduct } from '../src/knowledge/product.js';
import { gitEnv } from './git-env.js';

const IDENTITY = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };

/** The glossary the product holds. */
const GLOSSARY = `# Glossary

- **Fill** — the one run that reads a product's repositories and writes its graph.
`;

/** The reason this machine cannot run a plugin, when it cannot: the cases are skipped with it, never passed. */
const sandboxProblem: string | undefined = await (async (): Promise<string | undefined> => {
  const parent = cgroupParent();
  const delegation = checkCgroupDelegation(parent);
  if (delegation !== undefined) return delegation.message;
  const problem = await sandboxSetupProblem({ cgroupParent: parent });
  return problem?.message;
})();

let work: string;
let home: string;
let folder: string;
let product: string;
let server: StartedServer;

/** The product's wiki address of one API path. */
const address = (path: string): string => `${server.url}/products/${product}${path}`;

/** One API answer, parsed. */
async function call(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(address(path), init);
  return { status: response.status, body: await response.json() };
}

describe('fill request settings', () => {
  const part = createKnowledgePart({
    json: (status, body) => Response.json(body, { status }),
    refused: (status, error) => ({ response: Response.json({ error }, { status }) }),
    errorLog: () => undefined,
  }, {} as KnowledgeProduct, () => []);

  for (const [field, value] of [['agent', 'codex'], ['tokenCap', 20_000]] as const) {
    test(`refuses unsupported ${field} instead of silently ignoring it`, async () => {
      const answer = await part.fillSelected(new Request('http://wiki.test/api/fill-selected', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ selected: ['doc.term'], [field]: value }),
      }));
      expect(answer.response.status).toBe(400);
      expect((await answer.response.json()).error).toMatchObject({ field, message: expect.stringContaining('not supported') });
    });
  }
});

describe.skipIf(sandboxProblem !== undefined)('the fill page request', () => {
  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'madarch-fill-selection-'));
    home = join(work, 'home');
    const draft = createDraft({ home, name: 'selection-shop', gitEnv: gitEnv(IDENTITY) });
    if (draft.outcome !== 'created') throw new Error(`the draft product was not made: ${JSON.stringify(draft)}`);
    folder = draft.folder;
    product = draft.name;
    const code = join(folder, 'repos', 'app');
    mkdirSync(code, { recursive: true });
    writeFileSync(join(code, 'README.md'), '# App\n');
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: code, env: gitEnv(IDENTITY) });
    execFileSync('git', ['add', 'README.md'], { cwd: code, env: gitEnv(IDENTITY) });
    execFileSync('git', ['commit', '--quiet', '-m', 'First commit'], { cwd: code, env: gitEnv(IDENTITY) });
    const manifest = join(folder, 'workspace.yaml');
    writeFileSync(manifest, manifestWithRepo(readFileSync(manifest, 'utf8'), { name: 'app', linked: true }));
    writeFileSync(join(folder, 'docs', 'glossary.md'), GLOSSARY);
    execFileSync('git', ['add', '-A'], { cwd: folder, env: gitEnv(IDENTITY) });
    execFileSync('git', ['commit', '--quiet', '-m', 'The glossary'], { cwd: folder, env: gitEnv(IDENTITY) });
    const appFolder = join(work, 'app');
    mkdirSync(appFolder, { recursive: true });
    writeFileSync(join(appFolder, 'index.html'), '<!doctype html><html><head><title>app</title></head><body><div id="root"></div></body></html>');
    server = await startServer({ productHome: home, appFolder, port: 0, knowledgeRoot: join(home, '.madarch', 'knowledge'), log: () => undefined, errorLog: () => undefined });
  }, 120_000);

  afterAll(async () => {
    await server?.stop();
    rmSync(work, { recursive: true, force: true });
  });

  test('a body the engine cannot honour is refused by name', async () => {
    const unknown = await call('/api/fill-selected', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selected: ['doc.term2'] }) });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.field).toBe('selected');
    expect(unknown.body.error.message).toContain('doc.term2');
    expect(unknown.body.error.message).toContain('doc.term');
    const cap = await call('/api/fill-selected', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selected: ['doc.term'], tokenCap: -5 }) });
    expect(cap.status).toBe(400);
    expect(cap.body.error.field).toBe('tokenCap');
    const notJson = await call('/api/fill-selected', { method: 'POST', body: 'selected=doc.term' });
    expect(notJson.status).toBe(415);
  }, 120_000);

  test('the fill page request fills exactly the selected kinds, with the kinds their dependencies add, and no agent', async () => {
    const pressed = await call('/api/fill-selected', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selected: ['doc.term'], agent: null, tokenCap: null }) });
    expect(pressed.status).toBe(202);
    // The order the engine runs them in: the kinds doc.term needs come first.
    expect(pressed.body.order).toEqual(['code.repository', 'code.directory', 'code.file', 'doc.term']);
    // The fill is the product's own: wait for its end, then read what it ran.
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const state = (await call('/api/status')).body.fill?.state as string;
      if (state !== 'running') break;
      await new Promise((rest) => setTimeout(rest, 500));
    }
    const status = await call('/api/status');
    expect(status.body.fill.state).toBe('done');
    const owner = await createDatabaseOwner({ store: storeDatabasePath(productStoreFolder(folder, join(home, '.madarch', 'knowledge'))), btreeGist: true });
    try {
      const rows = await owner.run(async (tx) => await tx.query<{ run_id: string }>('SELECT run_id FROM fill_unit_generation ORDER BY updated_at DESC LIMIT 1'));
      const runId = rows.rows[0]?.run_id;
      expect(runId).toBeString();
      const units = (await readRunUnits(owner, runId!)).map((unit) => unit.unitId).sort();
      expect(units.filter((unit) => unit.startsWith('plugin-turns/'))).toEqual(['plugin-turns/glossary:doc.term']);
    } finally {
      await owner.close();
    }
    // The catalogue says what stands: the term kind is filled, and the state comes from the graph and the turn.
    const catalogue = await call('/api/catalog');
    const counts = (rows: { kind: string; count: number }[]) => rows.map(({ kind, count }) => ({ kind, count }));
    expect(counts(status.body.kinds)).toEqual(counts(catalogue.body.kinds));
    const term = (catalogue.body.kinds as { kind: string; state: string; plugins?: string[]; dependsOn?: string[]; estimate?: { volume: number | null; tokensPerUnit: number | null; tokens: number | null } }[]).find((kind) => kind.kind === 'doc.term');
    expect(term?.state).toBe('filled');
    expect(term?.plugins).toEqual(['glossary']);
    expect(term?.dependsOn).toEqual(['code.file']);
    // No producer declares a per-unit figure: the row carries no estimate at all, and the page says the cost is unknown.
    expect(term?.estimate).toBeUndefined();
    // A kind with no table of its own carries no estimate either.
    const useCase = (catalogue.body.kinds as { kind: string; estimate?: { volume: number | null } }[]).find((kind) => kind.kind === 'doc.use-case');
    expect(useCase?.estimate).toBeUndefined();
  }, 600_000);

});
