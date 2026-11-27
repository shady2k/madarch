import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeProduct, commitProduct } from './knowledge-fixture.js';
import { useFixturePlugins } from './enabled-plugins-fixture.js';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { createTestDatabaseOwner, prepareTestStore } from './test-database.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { runFill } from '../src/fill/run.js';
import { readKindAssertions } from '../src/graph/records.js';
import { readProgress } from '../src/graph/fill-orchestration.js';
import { readProducerOutcomes } from '../src/graph/producer-outcomes.js';
import { advanceUnitIn, edgeRowsIn, readRunNodeIn, readUnitsIn } from '../src/graph/fill-state.js';
import { byCodePoint } from '../src/model/order.js';

type Retraction = { kind: string; fromKind: string; fromKey: Record<string, unknown>; toKind: string; toKey: Record<string, unknown> };

async function fixture(work: (held: {
  fill: (id: string) => Promise<void>;
  counts: (id: string, after?: string) => Promise<{ unit: string; kind: string; operations: number; retractions: number; edgeRetractions: number; edges: Retraction[] }[]>;
  retained: () => Promise<() => void>;
  sequence: () => Promise<string>;
  invalidate: () => Promise<void>;
  change: () => void;
  about: () => Promise<Retraction[]>;
}) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'madarch-disk-support-'));
  const owner = await createTestDatabaseOwner({ btreeGist: true });
  try {
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'README.md'), '# Fixture\n');
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'src/b.ts'), 'export const b = 2;\n');
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Files without gitlinks');
    const home = join(root, 'home');
    mkdirSync(home);
    const product = makeProduct(home, 'disk-support', repo, 'repo');
    seedStarterSet(product);
    // The product kind stays with the repository producers: the product is the source of its repository reference
    // (0039, item 1), and a fixture that drops it has no vertex for the edge to start at.
    useFixturePlugins(product, ['disk'], ['product']);
    commitProduct(product, 'Use the real scripted disk plugin');
    const contract = await readPinnedGraphContract(product);
    await prepareTestStore(owner, { contract });
    const fill = async (id: string) => {
      const result = await runFill({ product, database: owner, home, runId: id,
        steps: ['plugin-turns'],
        targets: { kinds: ['code.repository', 'code.directory', 'code.file', 'code.gitlink'], pluginsOnly: true },
        prepareContract: async contract => { await prepareTestStore(owner, { contract }); },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`${import.meta.path}:51:1: ${JSON.stringify(result)}`);
      if (result.state !== 'succeeded') throw new Error(`${import.meta.path}:52:1: ${JSON.stringify({ result, progress: await readProgress(owner, id) })}`);
      expect(result.state).toBe('succeeded');
    };
    const sequence = async () => await owner.run(async tx => (await tx.query<{ sequence: string }>(
      'SELECT coalesce(max(recorded_sequence),0)::text AS sequence FROM assertion',
    )).rows[0]!.sequence);
    const counts = async (id: string, after = '0') => {
      const outcomes = (await readProducerOutcomes(owner, { runId: id })).filter(one => one.plugin === 'disk');
      expect([...new Set(outcomes.map(one => one.kind))].sort(byCodePoint)).toEqual(
        ['code.directory', 'code.file', 'code.gitlink', 'code.repository'].sort(byCodePoint),
      );
      return await owner.run(async tx => {
        const run = await readRunNodeIn(tx, id);
        expect(run).toBeDefined();
        const memberIds = new Set([
          ...(await edgeRowsIn(tx, 'system.unit-run', 'to', [run!.id])).map(edge => edge.from),
          ...(await edgeRowsIn(tx, 'system.run-inherited-unit', 'from', [run!.id])).map(edge => edge.to),
        ]);
        // Partition children have their own graph identities; an outcome can instead name an inherited generation.
        for (;;) {
          const children = await edgeRowsIn(tx, 'system.unit-parent', 'to', [...memberIds]);
          const before = memberIds.size;
          for (const child of children) memberIds.add(child.from);
          if (memberIds.size === before) break;
        }
        const units = (await readUnitsIn(tx, [...memberIds])).filter(unit =>
          String(unit.values['unit_name']).includes('disk:code.') || unit.values['producer'] === 'disk');
        const result = [];
        for (const unit of units) {
          const name = String(unit.values['unit_name']);
          const kind = String(unit.values['produced_kind'] ?? name.match(/disk:(code\.[^#:/]+)/)?.[1]);
          // Attribute every assertion through its operation host, not an outcome's possibly inherited generation.
          const row = (await tx.query<{ operations: string; retractions: string; edge_retractions: string }>(`
            SELECT count(DISTINCT op.uid)::text AS operations,
              count(*) FILTER (WHERE a.operation='retract')::text AS retractions,
              count(*) FILTER (WHERE a.operation='retract' AND aes.edge_id IS NOT NULL)::text AS edge_retractions
            FROM node op
            JOIN edge ou ON ou.from_node=op.id
            JOIN entity ouk ON ouk.id=ou.entity_id AND ouk.name='system.operation-unit'
            JOIN node u ON u.id=ou.to_node AND u.uid=$1::uuid
            LEFT JOIN edge ao ON ao.to_node=op.id AND ao.entity_id=(SELECT id FROM entity WHERE name='system.assertion-operation')
            LEFT JOIN assertion a ON a.assertion_id=ao.from_node AND a.recorded_sequence>$2::bigint
            LEFT JOIN assertion_edge_subject aes ON aes.assertion_id=a.assertion_id
            WHERE a.assertion_id IS NOT NULL`, [unit.uid, after])).rows[0]!;
          const edges = (await tx.query<Retraction>(`
            SELECT ek.name AS kind, fk.name AS "fromKind", fn.key AS "fromKey", tk.name AS "toKind", tn.key AS "toKey"
            FROM assertion a
            JOIN edge ao ON ao.from_node=a.assertion_id AND ao.entity_id=(SELECT id FROM entity WHERE name='system.assertion-operation')
            JOIN edge ou ON ou.from_node=ao.to_node AND ou.entity_id=(SELECT id FROM entity WHERE name='system.operation-unit')
            JOIN node u ON u.id=ou.to_node AND u.uid=$1::uuid
            JOIN assertion_edge_subject aes ON aes.assertion_id=a.assertion_id
            JOIN edge e ON e.id=aes.edge_id JOIN entity ek ON ek.id=e.entity_id
            JOIN node fn ON fn.id=e.from_node JOIN entity fk ON fk.id=fn.entity_id
            JOIN node tn ON tn.id=e.to_node JOIN entity tk ON tk.id=tn.entity_id
            WHERE a.operation='retract' AND a.recorded_sequence>$2::bigint
            ORDER BY a.recorded_sequence`, [unit.uid, after])).rows;
          result.push({ unit: name, kind, edges, operations: Number(row.operations),
            retractions: Number(row.retractions), edgeRetractions: Number(row.edge_retractions) });
        }
        expect([...new Set(result.map(row => row.kind))].sort(byCodePoint)).toEqual(
          ['code.directory', 'code.file', 'code.gitlink', 'code.repository'].sort(byCodePoint),
        );
        return result.sort((a, b) => byCodePoint(a.unit, b.unit));
      });
    };
    const retained = async () => {
      const files = await owner.run(tx => readKindAssertions(tx, 'vertex', 'code.file', ['path'], { contract }));
      const gitlinks = await owner.run(tx => readKindAssertions(tx, 'vertex', 'code.gitlink', [], { contract }));
      const about = await owner.run(tx => readKindAssertions(tx, 'edge', 'code.blob-about', [], { contract }));
      const blobs = await owner.run(tx => readKindAssertions(tx, 'vertex', 'code.blob', ['digest', 'content'], { contract }));
      const uses = await owner.run(async tx => {
        const edges = await readKindAssertions(tx, 'edge', 'product.uses-repository', [], { contract });
        const held: { fromKind: string; fromKey: Record<string, unknown>; toKind: string; toKey: Record<string, unknown> }[] = [];
        for (const edge of edges) {
          const ends = (await tx.query<{ id: string; kind: string; key: Record<string, unknown> }>(
            'SELECT n.id::text AS id,k.name AS kind,n.key FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.id=ANY($1::bigint[])', [[edge.from!, edge.to!]])).rows;
          const from = ends.find(end => Number(end.id) === edge.from)!;
          const to = ends.find(end => Number(end.id) === edge.to)!;
          held.push({ fromKind: from.kind, fromKey: from.key, toKind: to.kind, toKey: to.key });
        }
        return held;
      });
      const fileIds = new Set(files.map(file => file.id));
      const blobIds = new Set(blobs.map(blob => blob.id));
      const repositoryAbout = about.filter(edge => !fileIds.has(edge.to!));
      const fileAbout = about.filter(edge => fileIds.has(edge.to!));
      console.log('disk support retained', JSON.stringify({ files: files.length, fileBlobAbout: fileAbout.length, gitlinks: gitlinks.length }));
      return () => {
        expect(repositoryAbout).toHaveLength(2);
        expect(new Set(repositoryAbout.map(edge => edge.to)).size).toBe(2);
        expect(gitlinks).toHaveLength(0);
        // The product that connected the repository stands as the source of its reference (0039, item 1). Its own
        // checkout is pinned under its own id and is no repository it uses, so one edge names the linked repository.
        expect(uses).toHaveLength(1);
        expect(uses[0]!.fromKind).toBe('product');
        expect(Object.values(uses[0]!.fromKey)).toContain('disk-support');
        expect(uses[0]!.toKind).toBe('code.repository');
        expect(uses[0]!.toKey).toEqual({ name: 'repo' });
        expect(files.length).toBeGreaterThanOrEqual(3);
        expect(fileAbout).toHaveLength(files.length);
        for (const file of files) {
          const supports = fileAbout.filter(edge => edge.to === file.id);
          expect(supports).toHaveLength(1);
          expect(blobIds.has(supports[0]!.from!)).toBe(true);
        }
        expect(files.map(file => String(file.key['path']))).toEqual(expect.arrayContaining(['README.md', 'src/a.ts', 'src/b.ts']));
      };
    };
    const invalidate = async () => {
      await owner.transaction('write', async tx => {
        const units = (await readUnitsIn(tx)).filter(unit => unit.values['producer'] === 'disk' || String(unit.values['unit_name']).includes('disk:code.'));
        expect(units.length).toBeGreaterThanOrEqual(4);
        for (const unit of units) {
          if (unit.values['state'] !== 'published') continue;
          const result = await advanceUnitIn(tx, { unitId: String(unit.values['unit_name']), event: {
            type: 'invalidate', at: Date.now(), replacement: Number(unit.values['generation']) + 1, cause: 'force active repeat fill',
          } });
          expect(result.ok).toBe(true);
        }
      });
    };
    const change = () => {
      writeFileSync(join(repo, 'src/a.ts'), 'export const a = 3;\n');
      git('add', '-A');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Change a');
    };
    const about = async () => await owner.run(async tx => {
      const edges = await readKindAssertions(tx, 'edge', 'code.blob-about', [], { contract });
      const result: Retraction[] = [];
      for (const edge of edges) {
        const ends = (await tx.query<{ id: string; kind: string; key: Record<string, unknown> }>(
          'SELECT n.id::text AS id,k.name AS kind,n.key FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.id=ANY($1::bigint[])', [[edge.from!, edge.to!]])).rows;
        const from = ends.find(end => Number(end.id) === edge.from)!;
        const to = ends.find(end => Number(end.id) === edge.to)!;
        result.push({ kind: 'code.blob-about', fromKind: from.kind, fromKey: from.key, toKind: to.kind, toKey: to.key });
      }
      return result;
    });
    await work({ fill, counts, retained, sequence, invalidate, change, about });
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('a real disk fill without gitlinks retains every file blob-about and the gitlink unit retracts no edge', async () => {
  await fixture(async held => {
    await held.fill('disk-support-first');
    const counts = await held.counts('disk-support-first');
    console.log('disk first-fill graph operations', JSON.stringify(counts));
    const assertRetained = await held.retained();
    const gitlink = counts.filter(row => row.kind === 'code.gitlink');
    expect(gitlink).toHaveLength(1);
    expect(gitlink[0]!.operations).toBeGreaterThan(0);
    expect(gitlink[0]!.retractions).toBe(0);
    expect(gitlink[0]!.edgeRetractions).toBe(0);
    assertRetained();
  });
}, 300_000);

test('an unchanged second real disk fill retracts nothing in every disk unit', async () => {
  await fixture(async held => {
    await held.fill('disk-support-before');
    const after = await held.sequence();
    await held.invalidate();
    await held.fill('disk-support-unchanged');
    const counts = await held.counts('disk-support-unchanged', after);
    console.log('disk unchanged-fill graph operations', JSON.stringify(counts));
    const assertRetained = await held.retained();
    expect(counts.length).toBeGreaterThanOrEqual(4);
    for (const kind of ['code.repository', 'code.directory', 'code.file', 'code.gitlink']) {
      expect(counts.filter(row => row.kind === kind).reduce((sum, row) => sum + row.operations, 0)).toBeGreaterThan(0);
    }
    for (const row of counts) {
      expect(row.retractions).toBe(0);
      expect(row.edgeRetractions).toBe(0);
    }
    assertRetained();
  });
}, 300_000);

test('an edited committed file retracts exactly its old file and repository inventory blob-about pairs', async () => {
  await fixture(async held => {
    await held.fill('disk-support-edit-before');
    const before = await held.about();
    const after = await held.sequence();
    held.change();
    await held.invalidate();
    await held.fill('disk-support-edit-after');
    const counts = await held.counts('disk-support-edit-after', after);
    console.log('disk edited-fill graph operations', JSON.stringify(counts));
    expect(counts.filter(row => row.kind === 'code.file').reduce((sum, row) => sum + row.retractions, 0)).toBe(1);
    expect(counts.filter(row => row.kind === 'code.file').reduce((sum, row) => sum + row.edgeRetractions, 0)).toBe(1);
    const fileEdges = counts.filter(row => row.kind === 'code.file').flatMap(row => row.edges);
    expect(fileEdges).toEqual([before.find(edge => edge.toKind === 'code.file' && edge.toKey['path'] === 'src/a.ts')!]);
    const repositories = counts.filter(row => row.kind === 'code.repository');
    expect(repositories.reduce((sum, row) => sum + row.retractions, 0)).toBe(1);
    const repositoryEdges = repositories.flatMap(row => row.edges);
    expect(repositoryEdges).toHaveLength(1);
    expect(repositoryEdges[0]!.kind).toBe('code.blob-about');
    expect(repositoryEdges[0]!.fromKind).toBe('code.blob');
    expect(repositoryEdges[0]!.toKind).toBe('code.repository');
    expect(before).toContainEqual(repositoryEdges[0]!);
    for (const row of counts.filter(row => row.kind === 'code.directory' || row.kind === 'code.gitlink')) expect(row.retractions).toBe(0);
    const activeRepositoryEdges = (await held.about()).filter(edge => edge.toKind === 'code.repository');
    expect(activeRepositoryEdges).toHaveLength(2);
    expect(new Set(activeRepositoryEdges.map(edge => edge.toKey['name'])).size).toBe(2);
    (await held.retained())();
  });
}, 300_000);
