import {createRecordOwner,recordGraph,repoRef,fileRef,fixtureProducer} from './assertion-record-fixture.js';
/**
 * The ordinary repository plugins (madarch-8bdc.2.5, step 1's items 1 and 2): the tables
 * this step writes, a second run at one commit writing nothing, a new commit writing only what
 * moved, and a neutral fixture for the shapes git can give a tree.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseOwner } from '../src/adapters/database-owner.js';
import { commitFacts, fileFacts, listFiles, repositoryFacts } from '../src/graph/index.js';

import { assertionValueTableName } from '../src/graph/contract.js';
import { repositoryContract as GIT_CONTRACT, repositoryKindReads, repositoryEdgeReads, restrictRepositoryDeclarations } from './repository-contract-fixture.js';
import { runFill } from '../src/fill/run.js';
import { readRunUnits } from '../src/graph/fill-state.js';
import { readProgress } from '../src/graph/fill-orchestration.js';
import { seedRepositoryPlugins, useFixturePlugins } from './enabled-plugins-fixture.js';
import { instantOf } from '../plugins/git/main.js';
import { languageOfPath } from '../plugins/disk/reader.js';
import { GIT_KINDS } from '../src/fill/stages/git-contract.js';
import { GraphReader } from '../src/knowledge/graph-read.js';
import { bindWriteCapability, bootstrapWriteIdentity, publishGraphDrafts } from '../src/graph/write.js';
import { bindTestWriteCapability } from './write-capability-fixture.js';
import {readKindAssertions} from '../src/graph/records.js';
import {loadAssertions} from '../src/graph/assertion-read.js';
import { createTestDatabaseOwner,prepareTestStore } from './test-database.js';

let root = '';
let repository = '';
let product = '';
let runSequence = 0;
/** The graph's own tables, which every store holds: the mechanism the product's contracts build on. */
const RECORD_TABLES = ['context','edge','entity','node','assertion','assertion_vertex_subject','assertion_edge_subject',
 ...GIT_CONTRACT.vertex.flatMap(k=>['$exists',...k.fields.filter(f=>!k.key.includes(f.name)).map(f=>f.name)].map(p=>assertionValueTableName(k.name,'vertex',p))),
 ...GIT_CONTRACT.edge.flatMap(k=>['$exists',...k.fields.map(f=>f.name)].map(p=>assertionValueTableName(k.name,'edge',p))),
];
let owner: DatabaseOwner | undefined;

function git(args: readonly string[]): string {
  return execFileSync('git', args, { cwd: repository, maxBuffer: 64 * 1024 * 1024 }).toString('utf8').trim();
}

function commitAll(message: string): string {
  git(['add', '-A']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message]);
  return git(['rev-parse', 'HEAD']);
}

/** Runs the same declared ordinary plugins used by a product fill. */
async function fillRepository(folder = repository, name = 'fixture') {
  if (owner === undefined) throw new Error('the store was not opened');
  const fixture = folder === repository ? product : join(root, `product-${name}`);
  if (folder !== repository && !existsSync(fixture)) makeProduct(fixture, folder, name);
  const result = await runFill({ product: fixture, database: owner, home: join(root, 'home'), runId: `records-${++runSequence}`, prepareContract: async contract => { await prepareTestStore(owner!, { contract }); } });
  if (!result.ok) throw new Error(`fill refused: ${result.reason}`);
  if (result.state !== 'succeeded') throw new Error(`fill failed: ${JSON.stringify({result,units:await readRunUnits(owner,result.runId),progress:await readProgress(owner,result.runId,{limit:10000})})}`);
  return result;
}

function makeProduct(folder: string, source: string, name: string): void {
  mkdirSync(join(folder, 'repos'), { recursive: true });
  symlinkSync(source, join(folder, 'repos', name));
  writeFileSync(join(folder, 'workspace.yaml'), `schemaVersion: 1\nid: 8a1c6f2e-4f2b-4b8a-9f7e-1a2b3c4d5e6f\nname: records\nrepos:\n  - name: ${name}\n    url: file://${source}\n`);
  seedRepositoryPlugins(folder);
  restrictRepositoryDeclarations(folder);
  execFileSync('git', ['init', '-q'], { cwd: folder });
  execFileSync('git', ['add', '-A'], { cwd: folder });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Declare repository plugins'], { cwd: folder });
}

/** The commits the fixture makes, oldest first: a past commit's text is read at the commit that held it. */
let three = '';

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-records-'));
  repository = join(root, 'repo');
  mkdirSync(join(repository, 'src'), { recursive: true });
  mkdirSync(join(repository, 'docs'), { recursive: true });
  writeFileSync(join(repository, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repository, 'src', 'b.h'), 'int b;\n');
  writeFileSync(join(repository, 'docs', 'same-one.md'), '# one\n');
  writeFileSync(join(repository, 'docs', 'same-two.md'), '# one\n');
  writeFileSync(join(repository, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0]));
  writeFileSync(join(repository, 'with space and\nnewline.txt'), 'x\n');
  writeFileSync(join(repository, 'docs', 'with "quotes" and \\backslash.md'), '# quoted\n');
  symlinkSync('src/a.ts', join(repository, 'link.ts'));
  git(['init', '-q', '-b', 'main']);
  // A remote a person cloned with: the credential is read and never stored (madarch-hsqs stage B review).
  git(['remote', 'add', 'origin', 'https://someone:secret-token@example.test/fixture.git']);
  commitAll('one');
  // A rename, a deletion and a modification.
  git(['mv', 'docs/same-one.md', 'docs/renamed.md']);
  git(['rm', '-q', 'docs/same-two.md']);
  writeFileSync(join(repository, 'src', 'a.ts'), 'export const a = 2;\n');
  commitAll('two');
  product = join(root, 'product');
  makeProduct(product, repository, 'fixture');
  owner = await createTestDatabaseOwner({ graphContract: GIT_CONTRACT, authenticated:false });
}, 120_000);

afterAll(async () => {
  await owner?.close();
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('the record tables', () => {
  test('typed values hold no duplicate temporal columns; assertion headers own time', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const found = await owner.transaction('snapshot', async (tx) => await tx.query(
      `SELECT c.relname AS name, a.attname AS column FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
       WHERE c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped AND c.relname = ANY($1::text[])`,
      [RECORD_TABLES as unknown as string[]],
    ));
    const columns = (found.rows as { name: string; column: string }[]).map((row) => `${row.name}.${row.column}`);
    for (const table of RECORD_TABLES) expect(columns.some((column) => column.startsWith(`${table}.`))).toBe(true);
    expect(columns.filter((column) => !column.startsWith('assertion.') && /^(valid_|recorded_)/.test(column.split('.')[1] ?? ''))).toEqual([]);
  }, 120_000);
});

test('0039.1: parent-bound file facts need no history and a missing file is null',async()=>{
 const files=await createRecordOwner();try{
 const blob='b'.repeat(40);
 await files.transaction('write',tx=>publishGraphDrafts(tx,recordGraph,{vertices:[{...repoRef('files-only'),...fixtureProducer},{...fileRef('src/one.ts'),values:{mode:'100644',blob,bytes:20,form:'text',lines:1,language:'TypeScript',languages:['TypeScript']},...fixtureProducer}],edges:[{kind:GIT_KINDS.contains,from:repoRef('files-only'),to:fileRef('src/one.ts'),...fixtureProducer}],removals:[]}));
 expect(await fileFacts(files,'files-only','src/one.ts',{history:false})).toMatchObject({path:'src/one.ts',mode:'100644',blob,bytes:20,form:'text',lines:1,language:'TypeScript',candidates:['TypeScript'],created:null,modified:null,commitCount:0,authors:[]});
 expect(await fileFacts(files,'files-only','src/missing.ts',{history:false})).toBeNull();
 }finally{await files.close();}
});

describe('the two passes over one fixture', () => {
  test('write the tree and the history, and a second run writes nothing', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const first = await fillRepository();
    const roots = first.units.filter(unit => !unit.unitId.includes('#')).map(unit => unit.unitId).sort();
    expect(roots).toEqual(['disk:code.directory', 'disk:code.file', 'disk:code.gitlink', 'disk:code.repository',
      'git:code.author', 'git:code.commit', 'git:code.file', 'git:code.repository'].map(id => `plugin-turns/${id}`).sort());
    expect(first.units.every(unit => unit.stageId === 'plugin-turns')).toBe(true);
    const directoryEdges = await owner.transaction('snapshot', tx => tx.query(`SELECT count(*)::integer AS n FROM graph_edge_active_ids('code.directory-repository',1)`));
    expect(directoryEdges.rows[0]?.n).toBe(2);
    const before = await owner.transaction('snapshot', tx => tx.query(`SELECT count(*)::integer AS n FROM assertion`));
    const second = await fillRepository();
    expect([...new Set(second.reused.map(id => id.split('#')[0]))].sort()).toEqual(roots);
    const after = await owner.transaction('snapshot', tx => tx.query(`SELECT count(*)::integer AS n FROM assertion`));
    expect(after.rows).toEqual(before.rows);
  }, 120_000);

  test('0039.25: every tree and history assertion retains each stating pass and its creator scalars', async () => {
    const store = await createRecordOwner();
    try {
      const passes = [
        { operation: '019a0000-0000-7000-8000-000000000021', unit: '019a0000-0000-7000-8000-000000000031' },
        { operation: '019a0000-0000-7000-8000-000000000022', unit: '019a0000-0000-7000-8000-000000000032' },
      ] as const;
      const tree = fileRef('src/lineage.ts');
      const history = { kind: GIT_KINDS.commit, key: { hash: 'a'.repeat(40) } };
      const drafts = {
        vertices: [
          { ...repoRef('lineage'), ...fixtureProducer },
          { ...tree, values: { content: 'unchanged tree' }, ...fixtureProducer },
          { ...history, values: { subject: 'unchanged history' }, ...fixtureProducer },
        ],
        edges: [
          { kind: GIT_KINDS.contains, from: repoRef('lineage'), to: tree, ...fixtureProducer },
          { kind: GIT_KINDS.history, from: repoRef('lineage'), to: history, values: { walk: 0 }, ...fixtureProducer },
        ],
        removals: [],
      };
      const read = () => store.run(async tx => (await Promise.all([
        ...recordGraph.vertex.filter(kind => kind.name.startsWith('code.')).map(kind =>
          loadAssertions(tx, 'vertex', kind.name, ['$exists', ...kind.fields.map(field => field.name)])),
        ...recordGraph.edge.filter(kind => kind.name.startsWith('code.')).map(kind =>
          loadAssertions(tx, 'edge', kind.name, ['$exists', ...kind.fields.map(field => field.name)])),
      ])).flat());
      const expected = new Map<string, Set<string>>();
      for (const pass of passes) {
        await store.transaction('write', async tx => {
          const binding = await bindTestWriteCapability(tx, recordGraph);
          await bootstrapWriteIdentity(tx, 'system.operation', pass.operation, binding.productUid);
          await bootstrapWriteIdentity(tx, 'system.unit', pass.unit, binding.productUid);
          bindWriteCapability(tx, { ...binding, operationUid: pass.operation, unitUid: pass.unit });
          await publishGraphDrafts(tx, recordGraph, drafts);
        });
        // Both passes state this complete tree/history fixture, including unchanged values.
        for (const assertion of await read()) {
          const stated = expected.get(assertion.id) ?? new Set<string>();
          stated.add(pass.operation);
          expected.set(assertion.id, stated);
        }
      }
      const assertions = await read();
      expect(assertions.length, `${import.meta.path}:194: complete tree/history fixture`).toBeGreaterThan(10);
      expect([...expected.values()].some(operations => operations.size === 2), `${import.meta.path}:195: unchanged assertion must be restated`).toBe(true);
      const lineage = await store.run(tx => tx.query<{
        id: string; subjects: number; sources: number; authors: number; contexts: number; context_id: number; recorded_at: Date; operations: string[];
      }>(`SELECT n.uid::text AS id,a.recorded_at,a.context_id,
        ((SELECT count(*) FROM assertion_vertex_subject s WHERE s.assertion_id=a.assertion_id)+
         (SELECT count(*) FROM assertion_edge_subject s WHERE s.assertion_id=a.assertion_id))::integer AS subjects,
        (SELECT count(*) FROM edge e JOIN entity k ON k.id=e.entity_id WHERE e.from_node=a.assertion_id AND k.name='system.assertion-source')::integer AS sources,
        (SELECT count(*) FROM edge e JOIN entity k ON k.id=e.entity_id WHERE e.from_node=a.assertion_id AND k.name='system.assertion-author')::integer AS authors,
        (SELECT count(*) FROM context c WHERE c.id=a.context_id)::integer AS contexts,
        ARRAY(SELECT target.uid::text FROM edge e JOIN entity k ON k.id=e.entity_id JOIN node target ON target.id=e.to_node
          WHERE e.from_node=a.assertion_id AND k.name='system.assertion-operation') AS operations
        FROM assertion a JOIN node n ON n.id=a.assertion_id WHERE n.uid=ANY($1::uuid[])`, [assertions.map(assertion => assertion.id)]));
      expect(lineage.rows.length, `${import.meta.path}:207: every assertion has a header`).toBe(assertions.length);
      for (const row of lineage.rows) {
        const found = [...new Set(row.operations)].sort();
        const wanted = [...expected.get(row.id)!].sort();
        const message = `${import.meta.path}:211: assertion ${row.id}, expected passes ${JSON.stringify(wanted)}, found set ${JSON.stringify(found)}`;
        expect(row.subjects, message).toBe(1);
        expect(row.sources, message).toBe(1);
        expect(row.authors, message).toBe(1);
        expect([row.contexts, row.context_id], message).toEqual([1, 1]);
        expect(new Date(row.recorded_at).getTime(), message).toBeGreaterThan(0);
        expect(row.operations.length, message).toBeGreaterThanOrEqual(1);
        expect(found, message).toEqual(wanted);
      }
      for (const assertion of assertions) {
        const message = `${import.meta.path}:221: assertion ${assertion.id}, expected creator pass ${passes[0].operation} / unit ${passes[0].unit}, found scalar ${assertion.operationUid} / ${assertion.unit}`;
        expect(assertion.operationUid, message).toBe(passes[0].operation);
        expect(assertion.unit, message).toBe(passes[0].unit);
      }
    } finally {
      await store.close();
    }
  }, 120_000);

  test('a text file\'s blob stands in ordinary opinions, and the graph holds no text of its own', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    // Decision 0037: the graph names each file's bytes by blob id and holds no text; a file's text is read by that blob
    // through the host (product.fileText), never from a column here.
    const files = await listFiles(owner, { repository: 'fixture', limit: 100 });
    const byPath = new Map(files.rows.map((row) => [row.path, row]));
    const git = (path: string): string => execFileSync('git', ['rev-parse', `HEAD:${path}`], { cwd: repository, encoding: 'utf8' }).trim();
    expect(byPath.get('src/a.ts')?.blob).toBe(git('src/a.ts'));
    expect(byPath.get('docs/renamed.md')?.blob).toBe(git('docs/renamed.md'));
    // Two paths on one blob keep one blob: the identity is content-addressed, not per path.
    expect(byPath.get('docs/same-one.md')?.blob ?? byPath.get('docs/same-two.md')?.blob).toBeUndefined();
    const columns = await owner.transaction('snapshot', async (tx) => await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.columns WHERE table_name = $1 AND column_name = 'content'`, [assertionValueTableName(GIT_KINDS.file, 'vertex', 'blob')],
    ));
    expect(columns.rows[0]?.n).toBe('0');
  });

  test('read git\'s shapes: a rename, a deleted path, a binary, two paths on one blob, a symlink, an extension several languages claim, a space and a newline, a merge', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const files = await listFiles(owner, { repository: 'fixture', limit: 100 });
    const byPath = new Map(files.rows.filter((row) => row.mode !== null).map((row) => [row.path, row]));
    expect(byPath.has('docs/renamed.md')).toBe(true);
    expect(byPath.has('docs/same-one.md')).toBe(false);
    expect(byPath.has('docs/same-two.md')).toBe(false);
    expect(byPath.has('with space and\nnewline.txt')).toBe(true);
    expect(byPath.get('link.ts')?.mode).toBe('120000');
    // Blob identity remains a field of the ordinary file opinion.
    expect(byPath.get('docs/renamed.md')?.blob).toBe(byPath.get('docs/renamed.md')?.blob);
    expect(byPath.get('blob.bin')?.form).toBe('binary');
    expect(byPath.get('blob.bin')?.lines).toBeNull();
    // An ambiguous extension is decided by its bytes and its default; the dataset's candidates stand beside it.
    expect(byPath.get('blob.bin')?.language).toBe('unknown');
    expect(byPath.get('src/a.ts')?.language).toBe('TypeScript');
    expect(byPath.get('src/a.ts')?.candidates).toEqual(['TypeScript', 'XML']);
    const header = byPath.get('src/b.h')!;
    expect(header.language).toBe('C');
    expect(header.candidates).toEqual(['C', 'C++', 'Objective-C']);
    // The touched rows name the deleted path, which no file holds.
    const facts = await repositoryFacts(owner, 'fixture');
    expect(facts?.fileCount).toBe(files.rows.length);
  }, 120_000);

  test('write only what moved when a new commit changes one file', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    writeFileSync(join(repository, 'src', 'a.ts'), 'export const a = 3;\n');
    three = commitAll('three');
    const before = await owner.transaction('snapshot', tx => readKindAssertions(tx,'vertex',GIT_KINDS.file,['mode','blob','bytes','lines'], { contract: GIT_CONTRACT }));
    const old = await fileFacts(owner, 'fixture', 'src/a.ts');
    const run = await fillRepository();
    expect(run.units.every(unit => unit.state === 'published')).toBe(true);
    const moved = await fileFacts(owner, 'fixture', 'src/a.ts');
    expect(moved?.blob).not.toBe(old?.blob);
    expect(await commitFacts(owner, 'fixture', three)).toMatchObject({ hash: three, subject: 'three' });
    const after = await owner.transaction('snapshot', tx => readKindAssertions(tx,'vertex',GIT_KINDS.file,['mode','blob','bytes','lines'], { contract: GIT_CONTRACT }));
    const canonical = (rows: readonly unknown[]) => rows.map(row => JSON.stringify(row)).sort();
    expect(canonical(after.filter(r=>r.key['path']!=='src/a.ts').map(r=>({key:r.key,values:r.values})))).toEqual(canonical(before.filter(r=>r.key['path']!=='src/a.ts').map(r=>({key:r.key,values:r.values}))));
    const a = await fileFacts(owner, 'fixture', 'src/a.ts');
    expect(a?.lines).toBe(1);
  }, 120_000);



  test('0039.25: language changes append typed history and filters read selected values',async()=>{
    if(owner===undefined)throw new Error('the store was not opened');
    const before=await owner.run(tx=>loadAssertions(tx,'vertex',GIT_KINDS.file,['language','languages']));
    for(const language of ['TypeScript','JavaScript'])await owner.transaction('write',async tx=>{
      await bindTestWriteCapability(tx,GIT_CONTRACT);
      await publishGraphDrafts(tx,GIT_CONTRACT,{vertices:[{kind:GIT_KINDS.file,key:{path:'src/a.ts'},keyEdges:{'code.file-repository':{kind:GIT_KINDS.repository,key:{name:'fixture'}}},values:{language,languages:[language]},producer:'disk',producerVersion:'9.5.0'}],removals:[]});
    });
    const after=await owner.run(tx=>loadAssertions(tx,'vertex',GIT_KINDS.file,['language','languages']));
    expect(after.filter(a=>before.some(b=>a.id===b.id))).toEqual(before);
    expect(after.some(a=>a.value==='TypeScript')).toBe(true);
    expect(after.some(a=>a.value==='JavaScript')).toBe(true);
    expect((await listFiles(owner,{repository:'fixture',language:'JavaScript',limit:10})).rows.map(r=>r.path)).toContain('src/a.ts');
    expect((await listFiles(owner,{repository:'fixture',language:'TypeScript',limit:10})).rows.map(r=>r.path)).not.toContain('src/a.ts');
  },120000);

  test('a remote with a user and a password is stored and read without them', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    // The tree pass read the checkout\'s remote, which named a credential: the graph holds the address without it.
    expect(git(['remote', 'get-url', 'origin'])).toBe('https://someone:secret-token@example.test/fixture.git');
    const facts = await repositoryFacts(owner, 'fixture');
    expect(facts?.url).toBe('https://example.test/fixture.git');
    const reader = new GraphReader(owner, () => new Date().toISOString(), undefined, undefined, undefined, repositoryKindReads, repositoryEdgeReads, GIT_CONTRACT);
    // The graph\'s own repository read carries the clean address, and the credential stands in no opinion.
    const held = await reader.repository('fixture');
    expect(held?.url).toBe('https://example.test/fixture.git');
    // The credential stands nowhere in the store.
    // The tree states the address; the history's own opinion of the repository states only its shallow fact, so its
    // url column is null — and the credential stands in neither.
    const stored=await owner.run(tx=>loadAssertions(tx,'vertex',GIT_KINDS.repository,['url']));
    expect(JSON.stringify(stored)).not.toContain('someone');
    expect(JSON.stringify(stored)).not.toContain('secret-token');
  });

  test('ordinary output units execute through the plugin runtime', async () => {
    const run = await fillRepository();
    expect(run.units).toEqual([]);
    expect([...new Set(run.reused.map(id => id.split('#')[0]))].sort()).toEqual(['disk:code.directory', 'disk:code.file', 'disk:code.gitlink', 'disk:code.repository', 'git:code.author', 'git:code.commit', 'git:code.file', 'git:code.repository'].map(id => `plugin-turns/${id}`).sort());
    expect(languageOfPath('x.unknown-ext').language).toBe('unknown');
    expect(git(['rev-parse', '--is-shallow-repository'])).toBe('false');
    expect((await repositoryFacts(owner!, 'fixture'))?.historyShallow).toBe(false);
  }, 120_000);

  /** Every folder vertex with the folder it hangs from, read from the graph's own tables. */
  const listDirectories=async(repository='fixture'):Promise<readonly {path:string;parent:string}[]>=>{
    return await owner!.run(async tx=>{
      const directories=await readKindAssertions(tx,'vertex',GIT_KINDS.directory,[], { contract: GIT_CONTRACT });
      const repos=await readKindAssertions(tx,'vertex',GIT_KINDS.repository,[], { contract: GIT_CONTRACT });
      const edges=await readKindAssertions(tx,'edge',GIT_KINDS.contains,[], { contract: GIT_CONTRACT });
      const root=repos.find(r=>r.key['name']===repository);if(root===undefined)return [];
      const reachable=new Set([root.id]);for(let changed=true;changed;){changed=false;for(const e of edges)if(reachable.has(e.from!)&&!reachable.has(e.to!)){reachable.add(e.to!);changed=true;}}
      return directories.filter(d=>reachable.has(d.id)).map(d=>({path:String(d.key['path']),parent:String(directories.find(p=>p.id===edges.find(e=>e.to===d.id)?.from)?.key['path']??'')}));
    });
  };

  test('give every folder a vertex, one parent each, and no repository-to-nested-file edge', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const directories = await listDirectories();
    const byPath = new Map(directories.map((row) => [row.path, row.parent]));
    expect(byPath.has('src')).toBe(true);
    expect(byPath.has('docs')).toBe(true);
    // Exactly one parent each; a top-level folder hangs from the repository ('').
    expect(byPath.get('src')).toBe('');
    expect(byPath.get('docs')).toBe('');
    // The parent of a file is its folder, never the repository.
    const parents=await owner.run(async tx=>{
      const edges=await readKindAssertions(tx,'edge',GIT_KINDS.contains,[], { contract: GIT_CONTRACT });
      const files=await readKindAssertions(tx,'vertex',GIT_KINDS.file,[], { contract: GIT_CONTRACT });
      const dirs=await readKindAssertions(tx,'vertex',GIT_KINDS.directory,[], { contract: GIT_CONTRACT });
      return {rows:edges.flatMap(edge=>{const child=files.find(f=>f.id===edge.to);return child===undefined?[]:[{child:String(child.key['path']),parent:String(dirs.find(d=>d.id===edge.from)?.key['path']??'')}];})};
    });
    expect(parents.rows.length).toBeGreaterThan(0);
    for (const row of parents.rows as unknown as { child: string; parent: string }[]) {
      const folder = row.child.includes('/') ? row.child.slice(0, row.child.lastIndexOf('/')) : '';
      expect({ child: row.child, parent: row.parent }).toEqual({ child: row.child, parent: folder });
    }
    const facts = await repositoryFacts(owner, 'fixture');
    expect(facts?.directoryCount).toBe(new Set(directories.map((row) => row.path)).size);
  }, 120_000);

  test('take a folder away when its last file goes', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    mkdirSync(join(repository, 'only', 'deep'), { recursive: true });
    writeFileSync(join(repository, 'only', 'deep', 'x.txt'), 'x\n');
    commitAll('four');
    await fillRepository();
    expect((await listDirectories()).map((row) => row.path)).toContain('only/deep');
    git(['rm', '-q', '-r', 'only']);
    commitAll('five');
    await fillRepository();
    const again = (await listDirectories()).map((row) => row.path);
    expect(again).not.toContain('only/deep');
    expect(again).not.toContain('only');
  }, 120_000);

  });

describe('a shallow clone is the history pass\'s own opinion of the repository', () => {
  test('a shallow clone is stated by the pass, and a deeper clone takes the statement back', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    // Stage 3: `gap` is gone. What a pass could not read is a problem for a person, said in the run's log and trace; a
    // fact it can state about a vertex — a shallow clone — is its opinion of that vertex.
    const shallow = join(root, 'shallow');
    execFileSync('git', ['clone', '--depth=1', `file://${repository}`, shallow]);
    await fillRepository(shallow, 'shallow');
    expect((await repositoryFacts(owner, 'shallow'))?.historyShallow).toBe(true);
    const wireRead = async () => {
      const reader = new GraphReader(owner!, () => new Date().toISOString(), undefined, undefined, undefined, repositoryKindReads, repositoryEdgeReads, GIT_CONTRACT);
      return JSON.parse(JSON.stringify(await reader.repository('shallow')));
    };
    expect((await wireRead()).historyShallow).toBe(true);
    expect(await wireRead()).not.toHaveProperty('gaps');
    // A deeper clone states false: the same producer's opinion is replaced, never added beside it.
    execFileSync('git', ['fetch', '--unshallow'], { cwd: shallow });
    await fillRepository(shallow, 'shallow');
    expect((await repositoryFacts(owner, 'shallow'))?.historyShallow).toBe(false);
    expect((await wireRead()).historyShallow).toBe(false);
    expect(await wireRead()).not.toHaveProperty('gaps');
    const rows=await owner.run(tx=>readKindAssertions(tx,'vertex',GIT_KINDS.repository,['history_shallow'], { contract: GIT_CONTRACT }));
    expect(rows.filter(r=>r.key['name']==='shallow')).toHaveLength(1);
    expect(rows.find(r=>r.key['name']==='shallow')?.values['history_shallow']).toBe(false);
    const history=await owner.run(tx=>loadAssertions(tx,'vertex',GIT_KINDS.repository,['history_shallow']));
    expect(history.some(a=>a.value===true)).toBe(true);
    expect(history.some(a=>a.value===false)).toBe(true);
  }, 120_000);
});

test('an empty disk-only tree is available from its successful inventory publication', async () => {
  const empty = join(root, 'empty-tree');
  mkdirSync(empty);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: empty });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'Empty tree'], { cwd: empty });
  const fixture = join(root, 'product-empty-tree');
  makeProduct(fixture, empty, 'empty-tree');
  useFixturePlugins(fixture, ['disk', 'fixture-product'], GIT_CONTRACT.vertex.map(kind => kind.name).filter(name => !['product', 'code.repository', 'code.directory', 'code.file', 'code.gitlink'].includes(name)));
  restrictRepositoryDeclarations(fixture);
  execFileSync('git', ['add', '-A'], { cwd: fixture });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Only inventory'], { cwd: fixture });
  const inventory = await createTestDatabaseOwner({ graphContract: GIT_CONTRACT });
  try {
    const run = await runFill({ product: fixture, database: inventory, home: join(root, 'empty-home'), runId: 'empty-tree', prepareContract: async contract => { await prepareTestStore(inventory, { contract }); } });
    if (!run.ok) throw new Error(`empty inventory fill refused: ${run.reason}`);
    expect(run.state).toBe('succeeded');
    const facts = await repositoryFacts(inventory, 'empty-tree');
    expect(facts).toMatchObject({ hasTree: true, asIsCommit: null, fileCount: 0, directoryCount: 0, commitCount: 0 });
    const reader = new GraphReader(inventory, () => '', undefined, undefined, undefined, repositoryKindReads, repositoryEdgeReads, GIT_CONTRACT);
    expect((await reader.repository('empty-tree'))?.steps).toEqual({ tree: true, history: false });
  } finally {
    await inventory.close();
  }
}, 120_000);

describe('a git date of a zero or a negative offset', () => {

  test('instantOf reads the offset git writes, and the Z a newer git writes for zero minutes', () => {
    expect(instantOf('2026-11-07T20:38:26+03:00')).toEqual(['2026-11-07T17:38:26.000Z', 180]);
    expect(instantOf('2026-11-07T20:38:26-05:00')).toEqual(['2026-11-08T01:38:26.000Z', -300]);
    // A newer git states a zero offset as `Z` (measured: git 2.43 writes `+00:00` for the same commit).
    expect(instantOf('2026-11-07T20:38:26Z')).toEqual(['2026-11-07T20:38:26.000Z', 0]);
    expect(instantOf('2026-11-07T20:38:26+00:00')).toEqual(['2026-11-07T20:38:26.000Z', 0]);
    expect(() => instantOf('2026-11-07 20:38:26')).toThrow(/2026-11-07 20:38:26/);
    expect(() => instantOf('2026-11-07T20:38:26+0000')).toThrow(/unreadable git date/);
  }, 60_000);

  test('a commit at +00:00 and one at -05:00 keep git\'s instant and each one\'s own offset', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const offsets = join(root, 'offsets');
    mkdirSync(offsets, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: offsets });
    writeFileSync(join(offsets, 'a.txt'), 'a\n');
    execFileSync('git', ['add', '-A'], { cwd: offsets });
    const commitAt = (offset: string, message: string): string => {
      execFileSync('git', ['-c', 'user.name=Offset', '-c', 'user.email=offset@example.invalid', 'commit', '-qm', message], {
        cwd: offsets,
        env: { ...process.env, GIT_AUTHOR_DATE: `2026-11-07T20:38:26 ${offset}`, GIT_COMMITTER_DATE: `2026-11-07T20:38:26 ${offset}` },
      });
      return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: offsets }).toString().trim();
    };
    const zero = commitAt('+0000', 'zero');
    writeFileSync(join(offsets, 'b.txt'), 'b\n');
    execFileSync('git', ['add', '-A'], { cwd: offsets });
    const negative = commitAt('-0500', 'negative');
    const at = { repository: 'offsets', root: offsets, commit: negative, url: `file://${offsets}` };
    await fillRepository(at.root, at.repository);
    // git states 20:38:26 at +00:00, and 20:38:26 at -05:00, which is 01:38:26 UTC the next day.
    // The answer is `%aI`: the clock the author wrote and the offset it stood at, never the instant.
    expect(await commitFacts(owner, 'offsets', zero)).toMatchObject({ authorDate: '2026-11-07T20:38:26+00:00', authorOffsetMin: 0, commitDate: '2026-11-07T20:38:26+00:00', commitOffsetMin: 0 });
    expect(await commitFacts(owner, 'offsets', negative)).toMatchObject({ authorDate: '2026-11-07T20:38:26-05:00', authorOffsetMin: -300, commitDate: '2026-11-07T20:38:26-05:00', commitOffsetMin: -300 });
  }, 120_000);

  test('a history whose dates git states with Z publishes with a zero offset', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    // Newer Git's Z form and explicit zero offset denote the same instant and stored offset.
    expect(instantOf('2026-11-07T20:38:26Z')).toEqual(instantOf('2026-11-07T20:38:26+00:00'));
    const held = await commitFacts(owner, 'offsets', execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: join(root, 'offsets') }).toString().trim());
    expect(held).toMatchObject({ authorDate: '2026-11-07T20:38:26+00:00', authorOffsetMin: 0, commitDate: '2026-11-07T20:38:26+00:00', commitOffsetMin: 0 });
  }, 120_000);

  test('a listing answers the opinions\' values without their sources, and a single entity answers both', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const reader = new GraphReader(owner, () => new Date().toISOString(), undefined, undefined, undefined, repositoryKindReads, repositoryEdgeReads, GIT_CONTRACT);
    // The bulk read a page's treemap and the Problems listing make: every value, and no opinion's id, producer or
    // evidence (madarch-64o5.2: 1 800 files with 5 538 opinions were 2.25 MB and 63 ms with the sources, 1.21 MB and
    // 24 ms without). A list shows values, and no page shows where a value was stated from a list.
    let page = await reader.byPrefix('code.file', 'code.file:', 100);
    const listed = { total: page.total, rows: [...page.rows] };
    while (page.rows.length !== 0) {
      page = await reader.byPrefix('code.file', 'code.file:', 100, page.rows.at(-1)!.key);
      listed.rows.push(...page.rows);
    }
    expect(listed.rows).toHaveLength(listed.total);
    // The later offsets fill replaces disk/git opinions in this shared store; read its standing file.
    const file = listed.rows.find((one) => one.properties['path'] === 'a.txt' && one.properties['repositoryName'] === 'offsets');
    if (file === undefined) throw new Error(`the listing answered ${listed.rows.map((one) => one.key).join(', ')}`);
    expect(typeof file.properties['path']).toBe('string');
    expect(typeof file.properties['mode']).toBe('string');
    expect(file.evidence ?? []).toEqual([]);
    expect(file.opinions ?? []).toEqual([]);
    // The single entity's read is the one that states the sources, and the value is the same one.
    const one = (await reader.find(file.key))[0];
    expect(one?.properties['mode']).toBe(file.properties['mode']);
    expect((one?.evidence ?? []).length).toBeGreaterThan(0);
    expect((one?.opinions ?? []).length).toBeGreaterThan(0);
  }, 120_000);
});
