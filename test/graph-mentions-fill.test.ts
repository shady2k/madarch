/**
 * Decision 0039 items 5, 29 and 31, the boundary of `madarch-47vw.9`: a mention token is authored graph text.
 *
 * One repository-owned confined plugins-only fill publishes a document that quotes the mention grammar verbatim,
 * keeps its exact bytes and digest, and the fill goes on: a named later stage, `db-schema:code.table`, publishes the
 * table of a separate SQL source whose manifest reads `code.file`. No model is called.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { commitProduct, makeProduct } from './knowledge-fixture.js';
import { useFixturePlugins } from './enabled-plugins-fixture.js';
import { parseDocument } from 'yaml';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { createTestDatabaseOwner, prepareTestStore } from './test-database.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { runFill } from '../src/fill/run.js';
import { readKindAssertions } from '../src/graph/records.js';
import { readProducerOutcomes } from '../src/graph/producer-outcomes.js';
import { readUnitsIn } from '../src/graph/fill-state.js';
import type { GraphContract } from '../src/graph/contract.js';

/** One kind's records, read in a transaction of the case's own: the writer's rows answer the reader that follows. */
const records = async (
  owner: Awaited<ReturnType<typeof createTestDatabaseOwner>>, contract: GraphContract,
  sort: 'vertex' | 'edge', kind: string, fields: readonly string[],
) => await owner.run(async tx => await readKindAssertions(tx, sort, kind, fields, { contract }));

/** The refusal grammar states its expectation in a reserved token no rule accepts, as decision 0039 quotes it. */
const RESERVED = '[[uid:<lowercase hyphenated UUID>]]';
const EXAMPLE = `# Writing a mention\n\nA token is written \`${RESERVED}\` and resolved to the uid it names.\n\nThe example above names [[uid:12345678-1234-5678-9abc-123456789abc]].\n`;
/** The SQL source the later stage reads: a separate file, so its table proves the file kind was published first. */
const SCHEMA = 'export const schema = sql`CREATE TABLE users (id integer PRIMARY KEY, name text NOT NULL);`;\n';
/** The sources the schema plugin reads: its kinds name the patterns, as a product that reads TypeScript declares them. */
function declareSchemaSources(folder: string): void {
  for (const name of ['code.database', 'code.table', 'code.column', 'code.index']) {
    for (const file of kindFiles(join(folder, 'madarch', 'kinds'))) {
      if (file.split('/').at(-1) !== `${name}.yaml`) continue;
      const kind = parseDocument(readFileSync(file, 'utf8'));
      kind.set('terms', ['**/*.ts']);
      writeFileSync(file, kind.toString());
    }
  }
}

/** Every kind file of a product's folder, at any depth. */
function kindFiles(folder: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...kindFiles(path));
    else if (entry.name.endsWith('.yaml')) found.push(path);
  }
  return found;
}

/** The repository facts the disk plugin declares; the fill asks for these and the table db-schema fills. */
const KINDS = ['code.repository', 'code.directory', 'code.file', 'code.gitlink', 'code.database', 'code.table'] as const;

/**
 * A repository-bound product whose named plugins are the only producers, filled through the confined plugins-only
 * plan: the plan runs its stages in dependency order, so the db-schema turn proves the fill went on after disk.
 */
async function repositoryFixture(
  plugins: readonly string[],
  kinds: readonly string[],
  files: Readonly<Record<string, string>>,
  work: (held: {
    readonly owner: Awaited<ReturnType<typeof createTestDatabaseOwner>>;
    readonly contract: GraphContract;
    readonly fill: (runId: string) => Promise<Awaited<ReturnType<typeof runFill>>>;
    readonly units: () => Promise<readonly { readonly name: string; readonly state: string }[]>;
  }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'madarch-mention-fill-'));
  const owner = await createTestDatabaseOwner();
  try {
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'README.md'), '# Fixture\n');
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), content);
    }
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'A repository that documents the mention syntax');
    const home = join(root, 'home');
    mkdirSync(home);
    const product = makeProduct(home, 'mention-fill', repo, 'repo');
    seedStarterSet(product);
    declareSchemaSources(product);
    useFixturePlugins(product, [...plugins], ['product', 'code.commit']);
    commitProduct(product, 'Keep the repository producers of this fixture');
    const contract = await readPinnedGraphContract(product);
    await prepareTestStore(owner, { contract });
    const fill = async (runId: string) => await runFill({
      product, database: owner, home, runId,
      steps: ['plugin-turns'],
      targets: { kinds: [...kinds], pluginsOnly: true },
      prepareContract: async contract => { await prepareTestStore(owner, { contract }); },
    });
    const units = async () => await owner.run(async tx => (await readUnitsIn(tx)).map(unit => ({ name: String(unit.values['unit_name']), state: String(unit.values['state']) })));
    await work({ owner, contract, fill, units });
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe('decision 0039 items 5, 29 and 31: the mention boundary in a confined plugins-only fill', () => {
  test('a committed literal mention example keeps its exact bytes and digest, and a later plugin publishes its table', async () => {
    await repositoryFixture(['disk', 'db-schema'], [...KINDS], {
      'docs/mention-syntax.md': EXAMPLE,
      'src/schema.ts': SCHEMA,
    }, async ({ owner, contract, fill, units }) => {
      const result = await fill('mention-downstream');
      if (!result.ok) throw new Error(`${import.meta.path}:112:1: ${result.code} ${result.reason}`);
      expect(result.state).toBe('succeeded');
      // The literal example stops at the blob it is; the plan goes on to the db-schema turn, which reads the
      // `code.file` records disk published and states the table of the separate SQL source.
      const filled = await units();
      expect(filled.map(unit => unit.name)).toEqual(expect.arrayContaining(['plugin-turns/disk:code.file', 'plugin-turns/db-schema:code.table']));
      expect(filled.filter(unit => unit.state !== 'published')).toEqual([]);
      const outcomes = await readProducerOutcomes(owner, { runId: 'mention-downstream' });
      expect(outcomes).toEqual(expect.arrayContaining([
        expect.objectContaining({ plugin: 'disk', kind: 'code.file', outcome: 'completed' }),
        expect.objectContaining({ plugin: 'db-schema', kind: 'code.table' }),
      ]));
      // The named downstream result, and the input it stands on: the table of src/schema.ts, which db-schema could only
      // read once disk had published that file and its blob.
      const tables = await records(owner, contract, 'vertex', 'code.table', ['name']);
      expect(tables.map(table => table.values['name'])).toEqual(['users']);
      const files = await records(owner, contract, 'vertex', 'code.file', ['path']);
      expect(files.map(file => file.key['path'])).toContain('src/schema.ts');
      // No model ran: a plugins-only plan of these two producers admits no agent turn.
      expect(outcomes.some(outcome => outcome.plugin === 'agent-fill')).toBe(false);
      const digest = createHash('sha256').update(EXAMPLE, 'utf8').digest('hex');
      const blobs = await records(owner, contract, 'vertex', 'code.blob', ['content']);
      const blob = blobs.find(record => record.key['digest'] === digest);
      expect(blob).toBeDefined();
      // Verbatim means byte for byte: the digest the blob is keyed by still hashes the content the write stored.
      expect(blob!.values['content']).toBe(EXAMPLE);
      expect(createHash('sha256').update(String(blob!.values['content']), 'utf8').digest('hex')).toBe(digest);
    });
  }, 600_000);
});
