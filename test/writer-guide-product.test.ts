/** Neutral held fixture: actual publication + default KnowledgeProduct read factory. No execution attestation is manufactured here. */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createGraphStore } from '../src/graph/index.js';
import { createDraft } from '../src/product/draft.js';
import { manifestWithRepo } from '../src/product/manifest.js';
import { createGitSnapshotSource } from '../src/fill/snapshot.js';
import { KnowledgeProduct, storeFolderOf } from '../src/knowledge/product.js';
import { createKnowledgePart } from '../src/server/knowledge.js';
import { createGuideWriter, guideProductPin } from '../src/writer/guides/writer.js';
import { firstGuideCursor, readGuidePageContext } from '../src/writer/guides/prepared.js';
import { GUIDE_OUTPUTS } from '../src/writer/guides/host-contract.js';
import { GUIDE_SCHEMA, type GuideGround } from '../src/writer/guides/model.js';
import { validateGuide } from '../src/writer/guides/validate.js';
import { renderGuideArtifact } from '../src/writer/guides/artifact.js';
import type { UnitAgent } from '../src/writer/run.js';
import type { PageModel } from '../src/knowledge/model.js';
import { gitEnv } from './git-env.js';

const env = gitEnv({ GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' });
const instruction = 'node -e "console.log(\'Ready\')"';
const observation = 'Ready';
const source = `# Status check\n\nRun \`${instruction}\` from the repository root in an isolated environment. Expected exit status: 0. Expected output: Ready.\n`;
const vision = `# Operator and reader\n\nBoth roles can read readiness. Run \`${instruction}\` from the repository root in an isolated environment. Expected exit status: 0. Expected output: Ready.\n`;
const valid = '2026-04-01T00:00:00Z';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const commit = (cwd: string, message: string) => { git(cwd, 'add', '.'); git(cwd, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', message); return git(cwd, 'rev-parse', 'HEAD'); };
const guideBlock = (page: PageModel) => {
  const block = page.blocks.find((entry) => entry.type === 'guide');
  if (block?.type !== 'guide') throw new Error(JSON.stringify(page.findings));
  return block;
};

test('default product reader uses real published proof, survives generated-only commits and refuses changed source', async () => {
  const work = mkdtempSync(join(tmpdir(), 'guide-product-'));
  let owner: DatabaseOwner | undefined;
  let product: KnowledgeProduct | undefined;
  try {
    const repository = join(work, 'code'); mkdirSync(repository);
    git(repository, 'init', '--quiet', '--initial-branch=main');
    writeFileSync(join(repository, 'README.md'), source);
    const codeCommit = commit(repository, 'Document readiness');
    const home = join(work, 'home'); mkdirSync(home);
    const draft = createDraft({ home, name: 'neutral-reader', gitEnv: env });
    if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
    const folder = draft.folder;
    const workspace = join(folder, 'workspace.yaml');
    writeFileSync(workspace, manifestWithRepo(readFileSync(workspace, 'utf8'), { name: 'sample', linked: true }));
    symlinkSync(repository, join(folder, 'repos', 'sample'));
    mkdirSync(join(folder, 'docs'), { recursive: true });
    writeFileSync(join(folder, 'docs', 'vision.md'), vision);
    commit(folder, 'Record product source');
    const storeRoot = join(work, 'stores');
    const graphPath = join(storeFolderOf(storeRoot, draft.id, workspace), 'graph');
    mkdirSync(graphPath, { recursive: true });
    owner = createPGliteDatabaseOwner({ path: graphPath, btreeGist: true }); await owner.ready;
    const store = createGraphStore(owner); await store.createSchema();
    const scope = await store.newNode();
    await store.openNode({ nodeId: scope, kind: 'code.repository', label: 'sample', properties: { path: repository }, validFrom: valid, owner: { producer: 'fixture', scope } });
    await store.openNode({ kind: 'code.file', label: 'README.md', properties: { recordKey: 'code.file:README.md', path: 'README.md' }, validFrom: valid, owner: { producer: 'fixture', scope } });
    await owner.run(async (tx) => {
      await tx.query(`CREATE TABLE knowledge_fill (repo text PRIMARY KEY, scope text NOT NULL, head text NOT NULL, commit_hash text NOT NULL, effective_time text NOT NULL, commits int NOT NULL, filled_commits int NOT NULL)`);
      await tx.query(`CREATE TABLE knowledge_history_landmarks (repo text PRIMARY KEY, scope text NOT NULL, head text NOT NULL, plan jsonb NOT NULL)`);
      await tx.query('INSERT INTO knowledge_fill VALUES ($1,$2,$3,$4,$5,1,1)', ['sample', scope, codeCommit, codeCommit, valid]);
    });
    // A scripted interpretation port is a deterministic test double, NOT live source/execution acceptance.
    // It approves only the held fixture's exact instruction + expected result + actually supplied pinned bytes.
    const semanticAgent: UnitAgent = { run: async (request) => {
      const payload = JSON.parse(request.prompt.split('\n\n').at(-1)!) as { identity: string; step: { instruction: { content: string }; expected: { status: number; observation: string } }; spans: { text: string }[] };
      const exact = payload.step.instruction.content === instruction && payload.step.expected.status === 0 && payload.step.expected.observation === observation && payload.spans.length === 2 && payload.spans.every((span) => span.text.includes(instruction) && span.text.includes('Expected exit status: 0') && span.text.includes('Expected output: Ready'));
      expect(exact).toBe(true);
      const result = await request.tools.call('verify_guide_step', { identity: payload.identity, instructionSupported: exact, expectedSupported: exact });
      expect(result.isError).toBe(false);
    } };
    const snapshots = createGitSnapshotSource([{ id: 'sample', form: 'code', root: repository, commit: codeCommit }, guideProductPin(folder, ['sample'])]);
    for (const kind of ['administrator-guide', 'user-guide'] as const) {
      const writer = await createGuideWriter({ owner, store, snapshots, output: folder, scope, valid, agent: semanticAgent });
      const prepared = await writer.prepare(kind, 'en');
      const header = JSON.parse(prepared.prompt) as { context: unknown; inputDigest: string; unitVersion: string };
      let cursor: string | null | undefined = firstGuideCursor(prepared);
      const grounds: GuideGround[] = [];
      while (cursor != null) {
        const page = readGuidePageContext(prepared, cursor); if (page === undefined) throw new Error('missing required context packet');
        for (const entry of page.entries) {
          const held = entry as { type: string; ground?: GuideGround; text?: string };
          if (held.type === 'source' && held.ground !== undefined && held.text?.includes(instruction)) grounds.push(held.ground);
        }
        cursor = page.next;
      }
      expect(grounds.map((ground) => ground.repository).sort()).toEqual(['product', 'sample']);
      const raw = { schema: GUIDE_SCHEMA, id: GUIDE_OUTPUTS[kind].id, kind, locale: 'en', title: `${kind} readiness`, context: header.context, inputDigest: header.inputDigest, unitVersion: header.unitVersion, prerequisites: [], gaps: ['Only readiness is established by this fixture.'], procedures: [{ id: 'readiness', title: 'Read readiness', goal: 'Read readiness', role: 'Reader', prerequisites: [], steps: [{ id: 'status', title: 'Read status', cwd: '.', environment: 'isolated', inputs: [], instruction: { kind: 'command', content: instruction }, expected: { status: 0, observation }, grounds }] }] };
      const checked = await validateGuide(raw, prepared.validation);
      if (!checked.ok) throw new Error(JSON.stringify(checked.diagnostics));
      const published = await prepared.publishChecked({ guide: checked.guide, artifact: renderGuideArtifact(checked.guide), expectedContext: prepared.validation.expectedContext, expectedInputDigest: prepared.validation.expectedInputDigest, expectedUnitVersion: prepared.validation.expectedUnitVersion });
      expect(published.ok).toBe(true);
    }
    await owner.close(); owner = undefined; // Only one PGlite owner is live at a time; reads use the real remote owner.
    product = new KnowledgeProduct({ productFolder: folder, storeRoot }); // No guide authority injection.
    const currentPage = async (id: string) => { const result = await product!.page(id); if (!result.ok) throw new Error(result.message); return result.page; };
    for (const kind of ['administrator-guide', 'user-guide'] as const) {
      const block = guideBlock(await currentPage(GUIDE_OUTPUTS[kind].id));
      expect(block.data.coverage).toBe('procedures'); expect(block.data.walk.status).toBe('not-walked');
      expect(block.data.sourceViewWarning).toContain('not an immutable snapshot');
      expect(block.data.markdown.startsWith('---')).toBe(false);
      const listing = await product.list(kind, { limit: 10 });
      expect(JSON.stringify(listing)).toContain(GUIDE_OUTPUTS[kind].id);
      expect((await product.documents()).documents.some((entry) => entry.path === GUIDE_OUTPUTS[kind].path)).toBe(true);
    }
    const api = createKnowledgePart({ json: (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }), refused: (status, value) => ({ response: new Response(JSON.stringify(value), { status }) }), errorLog: () => {} }, product, () => []);
    const request = (format = '') => new Request(`http://example.test/api/k/page?id=administrator-guide:main${format}`);
    const json = await api.page(request()); const page = await json.response.json() as PageModel;
    const markdown = await api.page(request('&format=markdown'));
    expect(await markdown.response.text()).toBe(guideBlock(page).data.markdown);
    expect(page.blocks).toHaveLength(1);
    const generatedHead = commit(folder, 'Keep generated guides');
    expect(generatedHead).not.toBe(guideBlock(page).data.guide.context.repositories.find((pin) => pin.name === 'product')?.commit);
    expect(guideBlock(await currentPage('administrator-guide:main')).data.walk.status).toBe('not-walked');
    writeFileSync(join(folder, 'docs', 'vision.md'), `${vision}\nA new unsupported workflow.\n`);
    const dirty = await currentPage('administrator-guide:main');
    expect(dirty.blocks.some((block) => block.type === 'guide')).toBe(false);
    expect(dirty.blocks.some((block) => block.type === 'problem')).toBe(true);
    commit(folder, 'Change relevant product source');
    const changed = await currentPage('user-guide:main');
    expect(changed.blocks.some((block) => block.type === 'guide')).toBe(false);
    expect(changed.findings.length).toBeGreaterThan(0);
  } finally {
    await product?.close(); await owner?.close(); rmSync(work, { recursive: true, force: true });
  }
}, 20_000);
