/**
 * A kind's declaration is part of what its turn stands on (decision 0035, the Consequences: a changed declaration of a
 * kind, or a changed plugin closure, invalidates that kind's turn and its dependants, so the next fill reruns them and the
 * graph holds exactly what the new declaration produces). Found on narrowing doc.term's pattern from a glossary document in any folder
 * (`**` then `/glossary*.md`) to `docs/glossary*.md`: `madarch fill` printed "Units: 0" and the terms of the out-of-pattern file stayed, because the
 * kind's plugin turn was planned only for a kind whose documents the pattern still matched. A fill whose product did not
 * change plans nothing new, as before.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { createDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { runFill, type FillRunAnswer } from '../src/fill/run.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { checkCgroupDelegation, cgroupParent } from '../src/plugin/cgroup.js';
import { createDraft } from '../src/product/draft.js';
import { manifestWithRepo } from '../src/product/manifest.js';
import { productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { sandboxSetupProblem } from '../src/plugin/sandbox.js';
import { gitEnv } from './git-env.js';

const IDENTITY = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };

/** The glossary the kind's pattern names in the first fill, and no longer in the second. */
const GLOSSARY = `# Glossary of the notes

- **Fill** — the one run that reads a product's repositories and writes its graph.
- **Sweep** — a turn that reads every document again.
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
const opened: DatabaseOwner[] = [];

/** One draft product with a code repository and its glossary documents; answers its folder and its store root. */
function product(name: string): { folder: string; storeRoot: string } {
  const home = join(work, `${name}-home`);
  const draft = createDraft({ home, name, gitEnv: gitEnv(IDENTITY) });
  if (draft.outcome !== 'created') throw new Error(`the draft product was not made: ${JSON.stringify(draft)}`);
  const folder = draft.folder;
  const code = join(folder, 'repos', 'app');
  mkdirSync(code, { recursive: true });
  writeFileSync(join(code, 'README.md'), '# App\n');
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: code, env: gitEnv(IDENTITY) });
  execFileSync('git', ['add', 'README.md'], { cwd: code, env: gitEnv(IDENTITY) });
  execFileSync('git', ['commit', '--quiet', '-m', 'First commit'], { cwd: code, env: gitEnv(IDENTITY) });
  const manifest = join(folder, 'workspace.yaml');
  writeFileSync(manifest, manifestWithRepo(readFileSync(manifest, 'utf8'), { name: 'app', linked: true }));
  return { folder, storeRoot: join(home, 'knowledge') };
}

/** One git command in a product's repository. */
const git = (folder: string, ...args: string[]): void => { execFileSync('git', args, { cwd: folder, env: gitEnv(IDENTITY) }); };

/** Commits the product's working tree, so a fill reads the state the case wrote. */
function commit(folder: string, message: string): void {
  git(folder, 'add', '-A');
  git(folder, 'commit', '--quiet', '-m', message);
}

/** One fill of the product through the one runner, with its own owner on the product's store. */
async function fill(folder: string, storeRoot: string): Promise<FillRunAnswer & { ok: true }> {
  const owner = await createDatabaseOwner({ store: storeDatabasePath(productStoreFolder(folder, storeRoot)), btreeGist: true });
  opened.push(owner);
  const answer = await runFill({ product: folder, database: owner, home: storeRoot, store: storeRoot, workers: 4 });
  if (!answer.ok) throw new Error(`the fill was refused: ${answer.code}: ${answer.reason}`);
  return answer;
}

/** The terms the graph holds of the kind, as the wiki's glossary reads them and nothing else. */
async function terms(folder: string, storeRoot: string): Promise<string[]> {
  const wiki = new KnowledgeProduct({ productFolder: folder, storeRoot });
  try {
    return (await wiki.glossary()).terms.map((term) => term.title).sort();
  } finally {
    await wiki.close();
  }
}

describe.skipIf(sandboxProblem !== undefined)('a kind declaration that changes invalidates its turn', () => {
  beforeAll(() => { work = mkdtempSync(join(tmpdir(), 'madarch-plugin-declaration-')); });

  afterAll(async () => {
    for (const owner of opened) await owner.close().catch(() => undefined);
    rmSync(work, { recursive: true, force: true });
  });

  test('a narrowed pattern takes the terms of the out-of-pattern documents out of the graph', async () => {
    const { folder, storeRoot } = product('narrowed');
    mkdirSync(join(folder, 'docs', 'notes'), { recursive: true });
    writeFileSync(join(folder, 'docs', 'notes', 'glossary.md'), GLOSSARY);
    commit(folder, 'The glossary document');
    const first = await fill(folder, storeRoot);
    expect(first.state).toBe('succeeded');
    expect(await terms(folder, storeRoot)).toEqual(['Fill', 'Sweep']);
    // The kind's pattern narrows to another folder, and no document of the kind is left: the kind still has its turn,
    // and the plugin sees no document and retracts the terms it published before.
    const kinds = join(folder, 'madarch', 'kinds.yaml');
    const manifest = parseDocument(readFileSync(kinds, 'utf8'));
    manifest.setIn(['kinds', 'doc.term', 'terms'], ['docs/glossary*.md']);
    writeFileSync(kinds, manifest.toString());
    commit(folder, 'Narrow the term kind to the docs folder');
    const second = await fill(folder, storeRoot);
    expect(second.state).toBe('succeeded');
    expect(second.units.map((unit) => unit.unitId)).toContain('plugin-turns/glossary:doc.term');
    expect(await terms(folder, storeRoot)).toEqual([]);
  }, 600_000);

  test('a widened pattern publishes the terms of the documents it now names', async () => {
    const { folder, storeRoot } = product('widened');
    mkdirSync(join(folder, 'docs', 'notes'), { recursive: true });
    writeFileSync(join(folder, 'docs', 'notes', 'glossary.md'), GLOSSARY);
    commit(folder, 'The glossary document');
    expect((await fill(folder, storeRoot)).state).toBe('succeeded');
    expect(await terms(folder, storeRoot)).toEqual(['Fill', 'Sweep']);
    const kinds = join(folder, 'madarch', 'kinds.yaml');
    const manifest = parseDocument(readFileSync(kinds, 'utf8'));
    manifest.setIn(['kinds', 'doc.term', 'terms'], ['**/glossary*.md', 'docs/notes/*.md']);
    writeFileSync(kinds, manifest.toString());
    commit(folder, 'Let the term kind read the notes folder');
    const second = await fill(folder, storeRoot);
    expect(second.state).toBe('succeeded');
    expect(second.units.map((unit) => unit.unitId)).toContain('plugin-turns/glossary:doc.term');
    expect(await terms(folder, storeRoot)).toEqual(['Fill', 'Sweep']);
  }, 600_000);

  test('a fill whose product did not change runs no unit again', async () => {
    const { folder, storeRoot } = product('unchanged');
    mkdirSync(join(folder, 'docs', 'notes'), { recursive: true });
    writeFileSync(join(folder, 'docs', 'notes', 'glossary.md'), GLOSSARY);
    commit(folder, 'The glossary document');
    const first = await fill(folder, storeRoot);
    expect(first.units.length).toBeGreaterThan(0);
    expect(await terms(folder, storeRoot)).toEqual(['Fill', 'Sweep']);
    const second = await fill(folder, storeRoot);
    expect(second.state).toBe('succeeded');
    // Nothing moved: every unit of the second run is inherited, and none is executed.
    const executed = second.units.filter((unit) => !second.reused.includes(unit.unitId));
    expect(executed).toEqual([]);
    expect(await terms(folder, storeRoot)).toEqual(['Fill', 'Sweep']);
  }, 600_000);
});
