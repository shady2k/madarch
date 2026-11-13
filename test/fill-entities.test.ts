/**
 * A fill of the entities a person names (madarch-stm0.6, decision 0035 items 11 and 31): `madarch fill --entity <kind>`
 * adds the kinds that entity's declaration depends on, names what it added, and runs them
 * in the dependency order the manifest declares; `--vertex <entity id>` rewrites exactly that entity. A fill with no
 * entity named is the whole fill it always was.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { readRunUnits } from '../src/fill/state-store.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { checkCgroupDelegation, cgroupParent } from '../src/plugin/cgroup.js';
import { createDraft } from '../src/product/draft.js';
import { manifestWithRepo } from '../src/product/manifest.js';
import { sandboxSetupProblem } from '../src/plugin/sandbox.js';
import { gitEnv } from './git-env.js';
import { prepareTestProduct } from './prepared-server.js';
import { useExtractedGlossary } from './extracted-glossary-fixture.js';

const IDENTITY = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };

/** The `madarch` command, run the way a person runs it. */
const CLI = join(import.meta.dir, '..', 'scripts', 'madarch.ts');

/** The glossary the product holds: two terms, each a paragraph of its own. */
const GLOSSARY = `# Glossary

- **Fill** — the one run that reads a product's repositories and writes its graph.
- **Claim** — one producer's statement about a field, kept beside every other producer's.
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
let closePreparation: (() => Promise<void>) | undefined;

/** One `madarch fill` of the product, as it answered: its exit code and both streams. */
async function fillCommand(...args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const answer = Bun.spawn(['bun', CLI, 'fill', '--product', folder, '--home', home, ...args], { env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([answer.exited, new Response(answer.stdout).text(), new Response(answer.stderr).text()]);
  return { code, stdout, stderr };
}

/** The terms the graph holds, as a page reads them through `/graphql`: each one's title and definition. */
async function terms(): Promise<Record<string, string>> {
  const product = new KnowledgeProduct({ productFolder: folder, storeRoot: join(home, '.madarch', 'knowledge') });
  try {
    const answer = await product.graphql({ query: '{ allDocTerm(first: 200) { edges { node { label definition } } } }' });
    const body = answer.body as { data?: { allDocTerm?: { edges: { node: { label: string; definition: string | null } }[] } }; errors?: unknown };
    if (body.data?.allDocTerm === undefined) throw new Error(`the graph refused the term listing: ${JSON.stringify(body.errors)}`);
    return Object.fromEntries(body.data.allDocTerm.edges.map(({ node }) => [node.label, node.definition ?? '']));
  } finally {
    await product.close();
  }
}

/** The units one run planned and executed, read from the store the command filled, by the run id the command printed. */
async function runUnits(stdout: string): Promise<string[]> {
  const named = /^Fill (\S+):/mu.exec(stdout);
  if (named === null) throw new Error(`the command printed no run: ${stdout}`);
  const storeRoot = join(home, '.madarch', 'knowledge');
  const owner = await createDatabaseOwner({ store: storeDatabasePath(productStoreFolder(folder, storeRoot)), btreeGist: true });
  try {
    return (await readRunUnits(owner, named[1]!)).map((unit) => unit.unitId).sort();
  } finally {
    await owner.close();
  }
}

/** Commits the product's working tree, so a fill reads the state the case wrote. */
function commit(message: string): void {
  execFileSync('git', ['add', '-A'], { cwd: folder, env: gitEnv(IDENTITY) });
  execFileSync('git', ['commit', '--quiet', '-m', message], { cwd: folder, env: gitEnv(IDENTITY) });
}

describe.skipIf(sandboxProblem !== undefined)('a fill of the entities a person names', () => {
  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'madarch-fill-entities-'));
    home = join(work, 'home');
    const draft = createDraft({ home, name: 'entities-shop', gitEnv: gitEnv(IDENTITY) });
    if (draft.outcome !== 'created') throw new Error(`the draft product was not made: ${JSON.stringify(draft)}`);
    folder = draft.folder;
    useExtractedGlossary(folder);
    const code = join(folder, 'repos', 'app');
    mkdirSync(code, { recursive: true });
    writeFileSync(join(code, 'README.md'), '# App\n');
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: code, env: gitEnv(IDENTITY) });
    execFileSync('git', ['add', 'README.md'], { cwd: code, env: gitEnv(IDENTITY) });
    execFileSync('git', ['commit', '--quiet', '-m', 'First commit'], { cwd: code, env: gitEnv(IDENTITY) });
    const manifest = join(folder, 'workspace.yaml');
    writeFileSync(manifest, manifestWithRepo(readFileSync(manifest, 'utf8'), { name: 'app', linked: true }));
    writeFileSync(join(folder, 'docs', 'glossary.md'), GLOSSARY);
    commit('The glossary');
    closePreparation = await prepareTestProduct(folder, home);
  }, 120_000);

  afterAll(async () => { await closePreparation?.(); rmSync(work, { recursive: true, force: true }); });

  test('the kind a person names is filled with the kinds it declares it needs, and the run says what it added', async () => {
    const answer = await fillCommand('--entity', 'doc.term');
    expect(answer.code).toBe(0);
    // What the request added, and the order the manifest declares: the term kind needs the files, so code.file runs first.
    expect(answer.stdout).toContain('Also filling code.file, needed by doc.term.');
    // The kinds the term kind needs, and the kinds those need, come first: the dependency closure of the request.
    expect(answer.stdout).toContain('Filling in dependency order: code.repository, code.directory, code.file, doc.term.');
    // Ordinary repository producers cover the prerequisites; no unrelated producer is selected.
    expect([...new Set((await runUnits(answer.stdout)).map((unit) => unit.split('#')[0]))].sort()).toEqual([
      'plugin-turns/disk:code.directory', 'plugin-turns/disk:code.file', 'plugin-turns/disk:code.repository',
      'plugin-turns/git:code.file', 'plugin-turns/git:code.repository', 'plugin-turns/glossary:doc.term',
    ]);
    expect(Object.keys(await terms()).sort()).toEqual(['Claim', 'Fill']);
  }, 600_000);

  test('an author fill selects ordinary history producers and their prerequisites only', async () => {
    // Authors need commits and repository files; unrelated downstream consumers stay out.
    const answer = await fillCommand('--entity', 'code.author');
    expect(answer.code).toBe(0);
    expect(answer.stdout).toContain('Also filling code.commit, needed by code.author.');
    expect(answer.stdout).toContain('Also filling code.repository, needed by code.commit.');
    expect(answer.stdout).toContain('Filling in dependency order: code.repository, code.directory, code.file, code.commit, code.author.');
    const units = (await runUnits(answer.stdout)).map((unit) => unit.split('#')[0]!);
    expect(units).toContain('plugin-turns/git:code.author');
    expect(units).toContain('plugin-turns/git:code.commit');
    expect(units.every((unit) => /^plugin-turns\/(disk|git):code\./u.test(unit))).toBe(true);
    expect(answer.stdout).toContain('Units:');
  }, 600_000);

  test('a file fill excludes downstream consumers and preserves their graph opinions', async () => {
    const before = await terms();
    const answer = await fillCommand('--entity', 'code.file');
    expect(answer.code).toBe(0);
    expect(answer.stdout).not.toContain('Also filling doc.term');
    expect(answer.stdout).toContain('Filling in dependency order: code.repository, code.directory, code.file.');
    expect((await runUnits(answer.stdout)).every((unit) => /^plugin-turns\/(disk|git):code\./u.test(unit))).toBe(true);
    expect(await terms()).toEqual(before);
  }, 600_000);

  test('a vertex fill rewrites exactly the entity it names and nothing else', async () => {
    // Both terms change in the document: a vertex fill of one must leave the other as the graph holds it.
    writeFileSync(join(folder, 'docs', 'glossary.md'), GLOSSARY
      .replace('the one run that reads a product\'s repositories and writes its graph.', 'the one run that fills a product\'s graph.')
      .replace('one producer\'s statement about a field, kept beside every other producer\'s.', 'a producer\'s statement the graph keeps beside the others.'));
    commit('Reword both terms');
    const answer = await fillCommand('--vertex', 'doc.term:Fill');
    expect(answer.code, answer.stderr).toBe(0);
    expect(answer.stdout).toContain('Rewriting only doc.term:Fill, and nothing else.');
    const read = await terms();
    expect(read['Fill']).toBe('the one run that fills a product\'s graph.');
    // The other term was not rewritten: the graph holds what the earlier fill stated.
    expect(read['Claim']).toBe('one producer\'s statement about a field, kept beside every other producer\'s.');
  }, 600_000);

  test('a whole fill takes every kind, as it always did', async () => {
    const answer = await fillCommand();
    expect(answer.code).toBe(0);
    expect(answer.stdout).not.toContain('Also filling');
    // The vertex fill published its one entity in a unit of its own, so the kind's whole turn still runs here and the
    // term the vertex fill left alone takes the document's new words.
    expect(await runUnits(answer.stdout)).toContain('plugin-turns/glossary:doc.term');
    const read = await terms();
    expect(read['Fill']).toBe('the one run that fills a product\'s graph.');
    expect(read['Claim']).toBe('a producer\'s statement the graph keeps beside the others.');
  }, 600_000);

  test('an entity the manifest does not declare is refused by name, with the kinds it declares', async () => {
    const answer = await fillCommand('--entity', 'doc.term2');
    expect(answer.code).not.toBe(0);
    expect(answer.stderr).toContain('the product\'s manifest declares no such kind');
    expect(answer.stderr).toContain('doc.term2');
    expect(answer.stderr).toContain('doc.term');
  }, 120_000);
});
