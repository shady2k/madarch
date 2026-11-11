/**
 * The glossary's path end to end (decisions 0034 item 14 and 0035 items 6, 15, 16, 17, 18): a product's manifest
 * declares the term kind's fields as bindings to a plugin's fields, the plugin's own contract states their types, and
 * a fill runs the plugin over the glossary documents the kind names. The terms become graph claims the wiki reads —
 * the listing and the term's page read only the graph — and a second fill follows the document: an edited definition
 * changes, a deleted term disappears, and a kind taken out of the manifest takes its table with it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { createDraft } from '../src/product/draft.js';
import { manifestWithRepo } from '../src/product/manifest.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { checkCgroupDelegation, cgroupParent } from '../src/plugin/cgroup.js';
import { sandboxSetupProblem } from '../src/plugin/sandbox.js';
import type { Block, PageModel } from '../src/knowledge/model.js';
import { gitEnv } from './git-env.js';
import { createTestDatabaseOwner } from './test-database.js';
import { productStoreFolder } from '../src/product/store.js';

const IDENTITY = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };

/** The glossary the product holds: two terms, each on its own lines, with a synonym and a code name. */
const GLOSSARY = `# Glossary

- **Fill** — the one run that reads a product's repositories and writes its graph.
  A second fill finds what the first published and writes only what moved.
  Also called: body fill
  In code: fillRun
- **Claim** — one producer's statement about a field, kept beside every other producer's.
  Also called: assertion
`;

/** The reason this machine cannot run a plugin, when it cannot: the cases that fill are skipped with it, never passed. */
const sandboxProblem: string | undefined = await (async (): Promise<string | undefined> => {
  if (process.env['MADARCH_PLUGIN_SANDBOX'] === 'off') return undefined;
  const parent = cgroupParent();
  const delegation = checkCgroupDelegation(parent);
  if (delegation !== undefined) return delegation.message;
  const problem = await sandboxSetupProblem({ cgroupParent: parent });
  return problem?.message;
})();

let work: string;
let folder: string;
let product: KnowledgeProduct;

/** One git command in the product's repository. */
const git = (...args: string[]): string => execFileSync('git', args, { cwd: folder, encoding: 'utf8', env: gitEnv(IDENTITY) });

/** Commits the product's working tree, so a fill reads the state the case wrote. */
function commit(message: string): void {
  git('add', '-A');
  git('commit', '--quiet', '-m', message);
}

/** Runs one fill of the product and waits for it: a refusal or a failure names what went wrong. */
async function refill(): Promise<void> {
  const started = await product.startFill();
  if (!('started' in started) || started.started !== true) throw new Error(`the fill did not start: ${JSON.stringify(started)}`);
  await product.settled();
  const state = product.fillState();
  if (state.state !== 'done') throw new Error(`the fill did not finish: ${JSON.stringify(state)}`);
}

/** The term block of a term's page. */
const termBlock = (page: PageModel): Extract<Block, { type: 'term' }> => {
  const block = page.blocks.find((entry) => entry.type === 'term');
  if (block === undefined || block.type !== 'term') throw new Error(`the page ${page.id} holds no term block: ${JSON.stringify(page.blocks.map((entry) => entry.type))}`);
  return block;
};

describe.skipIf(sandboxProblem !== undefined)('a product glossary, filled through its plugin', () => {
  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'madarch-glossary-path-'));
    const draft = createDraft({ home: join(work, 'home'), name: 'glossary-shop', gitEnv: gitEnv(IDENTITY) });
    // `createDraft` answers an outcome: a refusal or a failure names what the home could not hold.
    if (draft.outcome !== 'created') throw new Error(`the draft product was not made: ${JSON.stringify(draft)}`);
    folder = draft.folder;
    // A fill starts on a product that declares a code repository (the product's own repository is read beside it), and
    // the glossary stands in the product's own documents.
    const code = join(folder, 'repos', 'app');
    mkdirSync(code, { recursive: true });
    writeFileSync(join(code, 'README.md'), '# App\n');
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: code, env: gitEnv(IDENTITY) });
    execFileSync('git', ['add', 'README.md'], { cwd: code, env: gitEnv(IDENTITY) });
    execFileSync('git', ['commit', '--quiet', '-m', 'First commit'], { cwd: code, env: gitEnv(IDENTITY) });
    const manifest = join(folder, 'workspace.yaml');
    writeFileSync(manifest, manifestWithRepo(readFileSync(manifest, 'utf8'), { name: 'app', linked: true }));
    // The debug journal keeps every request the plugin makes, its reads included (stage 2).
    const kindsFile = join(folder, 'madarch', 'kinds.yaml');
    writeFileSync(kindsFile, `${readFileSync(kindsFile, 'utf8')}\njournal:\n  debug: true\n`);
  });

  afterAll(async () => {
    await product?.close();
    rmSync(work, { recursive: true, force: true });
  });

  test('the first fill publishes the terms the glossary states, and the listing and the page read only the graph', async () => {
    writeFileSync(join(folder, 'docs', 'glossary.md'), GLOSSARY);
    commit('Add the glossary');
    product = new KnowledgeProduct({ productFolder: folder, storeRoot: join(work, 'store') });
    await refill();

    const listed = await product.glossary();
    expect(listed.terms.map((term) => term.title)).toEqual(['Claim', 'Fill']);
    expect(listed.terms.find((term) => term.title === 'Fill')?.definition).toBe('the one run that reads a product\'s repositories and writes its graph.\nA second fill finds what the first published and writes only what moved.');
    expect(listed.terms.find((term) => term.title === 'Fill')?.synonyms).toEqual(['body fill']);
    expect(listed.terms.find((term) => term.title === 'Fill')?.code).toEqual(['fillRun']);
    expect(listed.terms.find((term) => term.title === 'Fill')?.definedIn).toContain('docs/glossary.md:3');

    const page = await product.page('doc.term:Fill');
    if (!page.ok) throw new Error(page.message);
    const block = termBlock(page.page);
    expect(block.definition).toContain('the one run that reads');
    // The page links to the lines the definition stands on: the file, and the first line of the item.
    expect(block.definedIn).toContain('docs/glossary.md:3');
    expect(block.definedIn).toContain('/src?path=docs%2Fglossary.md&line=3');
    expect(page.page.findings).toEqual([]);
    // One journal entry for the plugin's turn, authored by the plugin and its version, naming the term vertices it
    // declared, the opinions it opened and the requests it made (the debug setting is on).
    const storeOwner = await createTestDatabaseOwner({ store: join(productStoreFolder(folder, join(work, 'store')), 'graph'), btreeGist: true });
    const journal = await storeOwner.transaction('snapshot', async (tx) => await tx.query<{ author: string; change: { vertices: { entity: string }[]; opinions: { state: string }[]; reads?: { method: string; size: number; outcome?: string }[] } }>('SELECT author, change FROM operation ORDER BY seq'));
    await storeOwner.close();
    const plugin = journal.rows.filter((one) => one.author === 'glossary@1.0.0');
    expect(plugin).toHaveLength(1);
    expect(plugin[0]?.change.vertices.map((one) => one.entity)).toEqual(['doc.term', 'doc.term']);
    expect(plugin[0]?.change.opinions.every((one) => one.state === 'opened')).toBe(true);
    // Every request the plugin made is recorded where the host received it — its introduction too — with what came of
    // it and the size of its answer, never an argument or a text.
    expect(plugin[0]?.change.reads?.slice(0, 3).map((one) => one.method)).toEqual(['introduce', 'graph.files', 'graph.files']);
    expect(plugin[0]?.change.reads?.every((one) => one.outcome === 'answered')).toBe(true);
    expect(plugin[0]?.change.reads?.slice(1, 3).every((one) => one.size > 0)).toBe(true);
  }, 300_000);

  test('mentions added and removed outside the glossary move the next fill and never read the working tree', async () => {
    const file = join(folder, 'docs', 'mentions.md');
    writeFileSync(file, 'Fill fillRun body fill. refill fillRunExtra.\n');
    commit('Mention the fill');
    await refill();
    let listed = await product.glossary();
    const used = listed.terms.find((term) => term.title === 'Fill')!;
    const mention = used.usages.find((one) => one.location.includes('docs/mentions.md:1'));
    expect(mention?.count).toBe(3);
    expect(mention?.location).toContain('/src?path=docs%2Fmentions.md&line=1');
    expect(used.usageCount).toBe(used.usages.reduce((total, one) => total + one.count, 0));
    writeFileSync(file, 'No mentions remain.\n');
    // A read keeps the graph's published result until the edited file is committed and filled.
    listed = await product.glossary();
    expect(listed.terms.find((term) => term.title === 'Fill')?.usages).toEqual(used.usages);
    commit('Remove the mention');
    await refill();
    listed = await product.glossary();
    expect(listed.terms.find((term) => term.title === 'Fill')?.usages.some((one) => one.location.includes('docs/mentions.md'))).toBe(false);
  }, 300_000);

  test('an edited definition is the one the next fill shows, and the old value stays a claim of its own', async () => {
    writeFileSync(join(folder, 'docs', 'glossary.md'), GLOSSARY.replace('the one run that reads a product\'s repositories and writes its graph.', 'the one run that fills a product\'s graph from its repositories.'));
    commit('Reword the fill');
    await refill();
    const listed = await product.glossary();
    expect(listed.terms.find((term) => term.title === 'Fill')?.definition).toContain('fills a product\'s graph');
  }, 300_000);

  test('a term the document no longer states does not stand after the next fill', async () => {
    writeFileSync(join(folder, 'docs', 'glossary.md'), GLOSSARY.replace('- **Claim** — one producer\'s statement about a field, kept beside every other producer\'s.\n  Also called: assertion\n', ''));
    commit('Drop the claim term');
    await refill();
    const listed = await product.glossary();
    expect(listed.terms.map((term) => term.title)).toEqual(['Fill']);
    const gone = await product.page('doc.term:Claim');
    expect(gone.ok).toBe(false);
  }, 300_000);

  test('a kind the manifest no longer declares loses its table', async () => {
    const file = join(folder, 'madarch', 'kinds.yaml');
    const manifest = parseDocument(readFileSync(file, 'utf8'));
    manifest.deleteIn(['kinds', 'doc.term']);
    writeFileSync(file, manifest.toString());
    commit('Take the term kind out');
    await refill();
    expect(await product.hasGraphTable('doc.term')).toBe(false);
    const listed = await product.glossary();
    expect(listed.terms).toEqual([]);
  }, 300_000);
});
