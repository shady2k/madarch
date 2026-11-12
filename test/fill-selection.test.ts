/** The fill page's press uses the same target resolution and engine as the CLI, without saving a draft selection. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCgroupDelegation, cgroupParent } from '../src/plugin/cgroup.js';
import { createDraft } from '../src/product/draft.js';
import { manifestWithRepo } from '../src/product/manifest.js';
import { sandboxSetupProblem } from '../src/plugin/sandbox.js';
import type { StartedServer } from '../src/server/http.js';
import { startPreparedServer } from './prepared-server.js';
import { createKnowledgePart } from '../src/server/knowledge.js';
import type { KnowledgeProduct } from '../src/knowledge/product.js';
import { gitEnv } from './git-env.js';
import { useExtractedGlossary } from './extracted-glossary-fixture.js';

const IDENTITY = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };

/** The glossary the product holds. */
const GLOSSARY = `# Glossary

- **Fill** — the one run that reads a product's repositories and writes its graph.
`;

/** The reason this machine cannot run a plugin, when it cannot: the cases are skipped with it, never passed. */
const sandboxProblem: string | undefined = await (async (): Promise<string | undefined> => {
  if (process.env['MADARCH_PLUGIN_SANDBOX'] === 'off') return undefined;
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
  }, { folder: join(tmpdir(), 'madarch-fill-selection-settings') } as KnowledgeProduct, () => []);

  for (const [field, value] of [['agent', 42], ['tokenCap', -1]] as const) {
    test(`refuses invalid ${field} instead of silently ignoring it`, async () => {
      const answer = await part.fillSelected(new Request('http://wiki.test/api/fill-selected', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ selected: ['doc.term'], [field]: value }),
      }));
      expect(answer.response.status).toBe(400);
      expect((await answer.response.json()).error).toMatchObject({ field });
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
    useExtractedGlossary(folder);
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
    server = await startPreparedServer({ productHome: home, appFolder, port: 0, knowledgeRoot: join(home, '.madarch', 'knowledge'), log: () => undefined, errorLog: () => undefined });
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

  test('a selected kind requiring the enabled general agent refuses explicit no-agent before accepting work', async () => {
    const pressed = await call('/api/fill-selected', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selected: ['doc.term'], agent: null, tokenCap: null }) });
    expect(pressed.status).toBe(409);
    expect(JSON.stringify(pressed.body)).toMatch(/plugin\.json:\d+/);
    expect(JSON.stringify(pressed.body)).toContain('requested an agent but none is selected');
  });

});
