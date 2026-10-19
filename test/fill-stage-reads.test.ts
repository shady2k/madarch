/**
 * The stage reads (madarch-tzte.21.8): the twelve named reads the eight
 * deterministic stages make of the product graph, answered from the fill's own
 * fact store, and the view a stage's own SQL reads through.
 *
 * The fixture writes the store's own rows — `fill_fact` and its holding — as a
 * publication leaves them (a publication's machine is test/fill-fact-store.test.ts's
 * subject, not this reader's), and every read is then checked by the consuming
 * stage's OWN row reader (`publishedTreeRows`, `publishedDocuments`,
 * `publishedImportRows`, `publishedGapRows`, `publishedReadRows`, `symbolRows`,
 * `indexRows`, `packageRows`, `fileRows`, `edgeRows`), because a row shape
 * invented here would prove nothing about the stages that read it. Where a
 * reader is the stage's own private one (the build and configuration stage's
 * `publishedManifests`), the row is checked against the interface that stage
 * declares, and the end-to-end test (test/fill-stages.test.ts) drives that stage
 * over it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import {
  makeEdgeFact, makeNodeFact, repositoryPath, type Fact, type FactLayer, type FactProvenance,
} from '../src/fill/facts.js';
import { createFactStoreSchema } from '../src/fill/fact-store.js';
import { readText } from '../src/fill/graph-reads.js';
import { parseStageRead, createStageReadReader, createStageReadSchema, READ_PAGE_ROWS, STAGE_READ_NAMES } from '../src/fill/stage-reads.js';
import { publishedTreeRead, publishedTreeRows } from '../src/fill/stages/inventory.js';
import { publishedManifestsRead } from '../src/fill/stages/build-configuration.js';
import { publishedDocuments, publishedDocumentsRead } from '../src/fill/stages/document-index.js';
import {
  compilerIndexRead, indexRows,
  publishedReadsRead, publishedReadRows, publishedSymbolsRead, symbolRows as resolutionSymbolRows,
} from '../src/fill/stages/semantic-resolution.js';
import { publishedGapRows, publishedGapsRead, publishedImportRows, publishedImportsRead } from '../src/fill/stages/syntax-specifiers.js';
import {
  edgeRows, fileRows, packageRows, publishedFilesRead, publishedPackagesRead, publishedSymbolsRead as moduleSymbolsRead,
  resolvedEdgesRead, symbolRows as moduleSymbolRows,
} from '../src/fill/stages/modules.js';
import { commitsHeldQuery, coverageHeldQuery, historyScope } from '../src/fill/stages/history.js';

const REPOSITORY = 'orders-api';
const OTHER = 'other-api';
const COMMIT = 'a'.repeat(40);
const BLOB = 'b'.repeat(40);
const BLOB_DOC = 'c'.repeat(40);

/** The source every fact of the fixture cites; the stage names the reads filter by are the `fill_fact_holding` ones. */
const SOURCE = { system: 'tree-sitter', version: '0.25.10' };

/** The place a fact stands at: one file and an ascending range. */
function place(file: string, line = 1): FactProvenance['place'] {
  const startLine = line;
  const endLine = line;
  return { file: repositoryPath(file), range: { startLine: startLine, startColumn: 0, endLine: Math.max(startLine, endLine), endColumn: 4 } };
}

/**
 * One fact with the fixture's provenance: a fact is read from the repository its
 * own value names, and a `coverage` is read by the reader its scope is a reading
 * of — two stages' coverages of one scope are two facts, so each names its own.
 */
function node(kind: string, value: Record<string, unknown>, file: string, layer: FactLayer = 'extracted', line = 1, reader = SOURCE): Fact {
  const repository = typeof value['repository'] === 'string' ? value['repository'] : REPOSITORY;
  return makeNodeFact({ kind: kind as never, value: value as never, provenance: { source: reader, repository: { id: repository, commit: COMMIT }, place: place(file, line) }, layer });
}

/** One edge fact with the fixture's provenance. */
function edge(kind: string, value: Record<string, unknown>, file: string): Fact {
  return makeEdgeFact({ kind: kind as never, value: value as never, provenance: { source: SOURCE, repository: { id: REPOSITORY, commit: COMMIT }, place: place(file) }, layer: 'extracted' });
}

/** The id of one of the fixture's files, as a file fact's identity digests it. */
function fileId(repository: string, path: string): string {
  return makeNodeFact({ kind: 'file', value: { repository, path: repositoryPath(path), roles: ['source'] } as never, provenance: { source: SOURCE, repository: { id: repository, commit: COMMIT }, place: place(path) }, layer: 'extracted' }).id;
}

let owner: DatabaseOwner;
let reader: { query(text: string): Promise<readonly unknown[]> };

/** One fact the fixture wrote, with the stage whose unit published it. */
const FACTS: { fact: Fact; stage: string }[] = [];

beforeAll(async () => {
  const cart = node('file', { repository: REPOSITORY, path: 'src/cart.ts', roles: ['source'], language: 'typescript', bytes: 120, blob: BLOB }, 'src/cart.ts');
  const total = node('file', { repository: REPOSITORY, path: 'src/total.ts', roles: ['source'], language: 'typescript', bytes: 40, blob: 'd'.repeat(40) }, 'src/total.ts');
  // A file whose value carries no blob: a row of the tree read must not answer a
  // blob key for it at all, because the reading stage refuses a blob that is null.
  const legacy = node('file', { repository: REPOSITORY, path: 'src/legacy.js', roles: ['source'], language: 'javascript', bytes: 20 }, 'src/legacy.js');
  const folder = node('directory', { repository: REPOSITORY, path: 'src' }, 'src/cart.ts');
  const other = node('file', { repository: OTHER, path: 'src/cart.ts', roles: ['source'], language: 'typescript', bytes: 10, blob: 'e'.repeat(40) }, 'src/cart.ts');
  const cartClass = node('symbol', { repository: REPOSITORY, file: 'src/cart.ts', qualifiedName: 'Cart', symbolKind: 'class' }, 'src/cart.ts', 'extracted', 2);
  const cartTotal = node('symbol', { repository: REPOSITORY, file: 'src/cart.ts', qualifiedName: 'Cart.total', symbolKind: 'method' }, 'src/cart.ts', 'extracted', 5);
  const otherSymbol = node('symbol', { repository: OTHER, file: 'src/cart.ts', qualifiedName: 'Cart', symbolKind: 'class' }, 'src/cart.ts');
  const manifestCoverage = node('coverage', { repository: REPOSITORY, scope: 'package.json', complete: true, read: ['package.json'], unread: [] }, 'package.json');
  const syntaxCoverage = node('coverage', {
    repository: REPOSITORY, scope: 'src/cart.ts', complete: false, read: ['src/cart.ts'],
    unread: [{ what: './missing.js', reason: 'unsupported' }],
  }, 'src/cart.ts');
  const resolutionCoverage = node('coverage', {
    repository: REPOSITORY, scope: 'src/cart.ts', complete: true, read: ['src/cart.ts', 'src/total.ts'], unread: [],
  }, 'src/cart.ts', 'extracted', 1, { system: 'madarch-resolution', version: '1' });
  // The history stage's own coverage of one repository at one commit: its scope
  // is that stage's own form, which is what its read filters by.
  const historyCoverage = node('coverage', {
    repository: REPOSITORY, scope: historyScope(REPOSITORY, COMMIT), complete: false,
    read: ['the pinned commit and its ancestry'], unread: [{ what: 'f'.repeat(40), reason: 'budget' }],
  }, 'src/cart.ts', 'extracted', 1, { system: 'git', version: '2.42.0' });
  const imported = edge('import', { from: fileId(REPOSITORY, 'src/cart.ts'), to: fileId(REPOSITORY, 'src/total.ts'), specifier: './total.js' }, 'src/cart.ts');
  // An import whose target the graph holds no fact for: the state a resumed run
  // finds when a deleted file's retraction published and its importers were not
  // read again. The read answers it (madarch-tzte.21.9), because a plan that
  // cannot see the edge cannot repair it.
  const importedVanished = edge('import', { from: fileId(REPOSITORY, 'src/cart.ts'), to: fileId(REPOSITORY, 'src/vanished.ts'), specifier: './vanished.js' }, 'src/cart.ts');
  // An import whose to end is no file at all — a package — which an `import`
  // edge never joins: the read answers it to nobody.
  const importedPackage = edge('import', { from: fileId(REPOSITORY, 'src/cart.ts'), to: node('package', { repository: REPOSITORY, name: 'chalk', form: 'package', manifest: 'package.json' }, 'package.json').id, specifier: 'chalk' }, 'src/cart.ts');
  const called = edge('call', { from: cartClass.id, to: cartTotal.id, count: 2, precision: 'syntactic' }, 'src/cart.ts');
  const packageFact = node('package', { repository: REPOSITORY, name: 'shop', form: 'package', manifest: 'package.json' }, 'package.json');
  const document = node('document', { repository: REPOSITORY, path: 'docs/readme.md', mediaType: 'text/markdown', title: 'Shop', bytes: 30, blob: BLOB_DOC }, 'docs/readme.md');
  // The two facts the history stage's own SQL reads.
  const snapshot = makeNodeFact({
    kind: 'snapshot',
    value: { repository: REPOSITORY, commit: COMMIT, tree: 'f'.repeat(40), fileCount: 4, byteCount: 210 },
    provenance: { source: { system: 'git', version: '2.42.0' }, repository: { id: REPOSITORY, commit: COMMIT } },
    layer: 'extracted',
  });
  const commit = makeNodeFact({
    kind: 'commit',
    value: {
      repository: REPOSITORY, commit: COMMIT,
      committedAt: '2026-10-18T10:00:00Z', authoredAt: '2026-10-18T09:00:00Z',
      subject: 'the cart', parents: [], files: [repositoryPath('src/cart.ts')],
    },
    provenance: { source: { system: 'git', version: '2.42.0' }, repository: { id: REPOSITORY, commit: COMMIT } },
    layer: 'extracted',
  });
  for (const entry of [
    { fact: snapshot, stage: 'snapshot' },
    { fact: cart, stage: 'inventory' }, { fact: total, stage: 'inventory' }, { fact: legacy, stage: 'inventory' },
    { fact: folder, stage: 'inventory' }, { fact: other, stage: 'inventory' },
    { fact: packageFact, stage: 'build-configuration' }, { fact: manifestCoverage, stage: 'build-configuration' },
    { fact: cartClass, stage: 'syntax' }, { fact: cartTotal, stage: 'syntax' }, { fact: otherSymbol, stage: 'syntax' },
    { fact: syntaxCoverage, stage: 'syntax' }, { fact: imported, stage: 'syntax' },
    { fact: importedVanished, stage: 'syntax' }, { fact: importedPackage, stage: 'syntax' },
    { fact: called, stage: 'semantic-resolution' }, { fact: resolutionCoverage, stage: 'semantic-resolution' },
    { fact: document, stage: 'document-index' }, { fact: commit, stage: 'history' }, { fact: historyCoverage, stage: 'history' },
  ]) FACTS.push(entry);

  owner = createPGliteDatabaseOwner();
  await createFactStoreSchema(owner);
  // The rows a publication leaves: the fact, and the holding that names the unit
  // and stage that published it (which is what a read filtering by stage reads).
  await owner.transaction('write', async (executor) => {
    for (const [index, entry] of FACTS.entries()) {
      await executor.query(
        'INSERT INTO fill_fact (id, kind, schema_version, provenance, layer, status, value) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb) ON CONFLICT (id) DO NOTHING',
        [entry.fact.id, entry.fact.kind, entry.fact.schemaVersion, JSON.stringify(entry.fact.provenance), entry.fact.layer, entry.fact.status, JSON.stringify(entry.fact.value)],
      );
      await executor.query(
        'INSERT INTO fill_fact_holding (id, unit_id, stage_id, generation, publication) VALUES ($1, $2, $3, 1, $4) ON CONFLICT (id, unit_id) DO NOTHING',
        [entry.fact.id, `${entry.stage}/fixture-${String(index)}`, entry.stage, `publication-${String(index)}`],
      );
    }
  });
  await createStageReadSchema(owner);
  reader = createStageReadReader({ database: owner, snapshot: { open: async () => { throw new Error('no stage read of this fixture reads a pinned tree'); } } });
}, 120_000);

afterAll(async () => {
  await owner?.close();
});

/** The rows one read answered, as the fixture's own reader. */
async function query(text: string): Promise<readonly Record<string, unknown>[]> {
  return (await reader.query(text)) as readonly Record<string, unknown>[];
}

describe('the read grammar', () => {
  test('every read name a stage writes is one this module answers', () => {
    expect([...STAGE_READ_NAMES].sort()).toEqual([
      'stage-1-published-tree', 'stage-2-published-manifests', 'stage-3-coverage-gaps', 'stage-3-published-symbols',
      'stage-4-compiler-index', 'stage-4-published-imports', 'stage-4-published-reads', 'stage-5-published-files',
      'stage-5-published-packages', 'stage-5-published-symbols', 'stage-5-resolved-edges', 'stage-6-published-documents',
    ]);
  });

  test('a stage read parses into what it names, and anything else is another reader\'s text', () => {
    expect(parseStageRead(publishedTreeRead(REPOSITORY))).toEqual({ read: 'stage-1-published-tree', repository: REPOSITORY });
    expect(parseStageRead(publishedSymbolsRead(REPOSITORY, 'src/cart.ts'))).toEqual({ read: 'stage-3-published-symbols', repository: REPOSITORY, path: 'src/cart.ts' });
    // A stage's own SQL and a read of the graph-read grammar are not this grammar.
    expect(parseStageRead('SELECT repository, commit FROM fact')).toBeNull();
    expect(parseStageRead(readText({ read: 'fact', id: FACTS[0]!.fact.id }))).toBeNull();
    // A JSON object that names a read this module does not answer is refused by
    // name, with the reads it does answer.
    expect(() => parseStageRead('{"read":"stage-9-invented","repository":"orders-api"}')).toThrow(/stage-9-invented/);
    expect(() => parseStageRead('{"read":"stage-9-invented","repository":"orders-api"}')).toThrow(/stage-1-published-tree/);
  });
});

describe('the published tree the inventory plans from', () => {
  test('files and folders answer the rows its own reader accepts, with no key a value does not hold', async () => {
    const rows = await query(publishedTreeRead(REPOSITORY));
    const tree = publishedTreeRows(rows, REPOSITORY, publishedTreeRead(REPOSITORY));
    expect([...tree.files.keys()].sort()).toEqual(['src/cart.ts', 'src/legacy.js', 'src/total.ts']);
    expect(tree.files.get('src/cart.ts')).toBe(BLOB);
    expect([...tree.directories]).toEqual(['src']);
    // A file whose value carries no blob answers no blob key: the reader refuses
    // a key held as null, and the answer is built from the fact's own value.
    const legacy = rows.find((row) => row['path'] === 'src/legacy.js');
    expect(Object.keys(legacy ?? {}).sort()).toEqual(['kind', 'path', 'repository']);
    const folder = rows.find((row) => row['kind'] === 'directory');
    expect(Object.keys(folder ?? {}).sort()).toEqual(['kind', 'path', 'repository']);
  });

  test('another repository is answered with its own facts and never this one\'s', async () => {
    const rows = await query(publishedTreeRead(OTHER));
    expect(rows.map((row) => [row['repository'], row['path']])).toEqual([[OTHER, 'src/cart.ts']]);
  });
});

describe('the manifests, documents, packages and symbols the stages plan and read from', () => {
  test('the manifests stage 2 digested are the coverage facts it published of a repository path', async () => {
    const rows = await query(publishedManifestsRead(REPOSITORY));
    expect(rows).toEqual([{ kind: 'manifest', repository: REPOSITORY, path: 'package.json' }]);
  });

  test('the documents answer the rows the document stage accepts', async () => {
    const rows = await query(publishedDocumentsRead(REPOSITORY));
    const documents = publishedDocuments(rows, REPOSITORY, publishedDocumentsRead(REPOSITORY));
    expect([...documents.entries()]).toEqual([['docs/readme.md', BLOB_DOC]]);
  });

  test('the packages answer the rows the modules stage clusters from', async () => {
    const rows = await query(publishedPackagesRead(REPOSITORY));
    expect(packageRows(rows, REPOSITORY, publishedPackagesRead(REPOSITORY))).toEqual([
      { kind: 'package', name: 'shop', form: 'package', manifest: 'package.json' },
    ]);
  });

  test('a file\'s symbols answer one file\'s declarations, with the range each stands at', async () => {
    const read = publishedSymbolsRead(REPOSITORY, 'src/cart.ts');
    const symbols = resolutionSymbolRows(await query(read), REPOSITORY, 'src/cart.ts', read);
    expect(symbols.map((symbol) => [symbol.qualifiedName, symbol.symbolKind, symbol.range.startLine, symbol.range.endLine])).toEqual([
      ['Cart', 'class', 2, 2],
      ['Cart.total', 'method', 5, 5],
    ]);
    expect(symbols[0]?.id.startsWith('symbol:')).toBe(true);
  });

  test('the file and symbol facts the modules stage ranks carry their whole value and their place', async () => {
    const filesRead = publishedFilesRead(REPOSITORY);
    const files = fileRows(await query(filesRead), REPOSITORY, filesRead);
    expect(files.map((file) => file.path).sort()).toEqual(['src/cart.ts', 'src/legacy.js', 'src/total.ts']);
    expect(files.find((file) => file.path === 'src/cart.ts')?.value.blob).toBe(BLOB);
    expect(files.every((file) => file.place.endLine >= file.place.startLine)).toBe(true);
    expect(files.every((file) => file.id === fileId(REPOSITORY, file.path))).toBe(true);
    const symbolsRead = moduleSymbolsRead(REPOSITORY);
    const symbols = moduleSymbolRows(await query(symbolsRead), REPOSITORY, symbolsRead);
    expect(symbols.map((symbol) => symbol.value.qualifiedName).sort()).toEqual(['Cart', 'Cart.total']);
    expect(symbols.every((symbol) => symbol.file === 'src/cart.ts')).toBe(true);
  });
});

describe('the resolution stage\'s reads', () => {
  test('the imports are the edges a repository\'s files wrote, a target the graph holds no file fact for included, and no edge whose target is no file', async () => {
    const read = publishedImportsRead(REPOSITORY);
    const imports = publishedImportRows(await query(read), REPOSITORY, read);
    // The edge to `src/vanished.ts` stands although no `file` fact of that path
    // is in the store, and its own id is the one `fileId` digests; the package's
    // edge is left out, since an `import` joins two files.
    const rows = imports.map((row) => [row.from.startsWith('file:'), row.to, row.specifier] as [boolean, string, string]);
    const expected: [boolean, string, string][] = [
      [true, fileId(REPOSITORY, 'src/total.ts'), './total.js'],
      [true, fileId(REPOSITORY, 'src/vanished.ts'), './vanished.js'],
    ];
    // A comparator of the test's own, over the specifier each edge wrote, so the
    // order is asserted in code point order and not by the engine's own default.
    const bySpecifier = (left: [boolean, string, string], right: [boolean, string, string]): number =>
      left[2] < right[2] ? -1 : left[2] > right[2] ? 1 : 0;
    expect(rows.sort(bySpecifier)).toEqual(expected.sort(bySpecifier));
  });

  test('the gaps are the syntax stage\'s own, one row per gap, in the file it stands in', async () => {
    const read = publishedGapsRead(REPOSITORY);
    expect(publishedGapRows(await query(read), REPOSITORY, read)).toEqual([
      { kind: 'coverage', file: 'src/cart.ts', what: './missing.js' },
    ]);
  });

  test('the reads this stage\'s own last run made are its own coverage, with the files it read', async () => {
    const read = publishedReadsRead(REPOSITORY);
    expect(publishedReadRows(await query(read), REPOSITORY, read)).toEqual([
      { kind: 'coverage', file: 'src/cart.ts', read: ['src/cart.ts', 'src/total.ts'] },
    ]);
  });

  test('a compiler index this build wires asks for nothing, which is what the stage\'s words say a wiring without one answers', async () => {
    expect(await query(compilerIndexRead(REPOSITORY, 'src/cart.ts'))).toEqual([]);
    expect(indexRows([], REPOSITORY, 'src/cart.ts', compilerIndexRead(REPOSITORY, 'src/cart.ts')).size).toBe(0);
  });
});

describe('the resolved edges the modules stage ranks', () => {
  test('an import between two files and a call between two symbols, with the count the edge holds', async () => {
    const read = resolvedEdgesRead(REPOSITORY);
    const edges = edgeRows(await query(read), REPOSITORY, read);
    expect(edges.map((row) => [row.kind, row.from.split(':')[0], row.to.split(':')[0], row.weight])).toEqual([
      ['call', 'symbol', 'symbol', 2],
      ['import', 'file', 'file', 1],
    ]);
  });
});

describe('a stage\'s own SQL, through the view this module creates', () => {
  test('the history stage\'s own queries answer the facts the store holds', async () => {
    const commits = await query(commitsHeldQuery(REPOSITORY));
    expect(commits.map((row) => row['commit'])).toEqual([COMMIT]);
    expect((commits[0]?.['value'] as { subject: string }).subject).toBe('the cart');
    const coverage = await query(coverageHeldQuery(REPOSITORY, historyScope(REPOSITORY, COMMIT)));
    expect(coverage.length).toBe(1);
    expect((coverage[0]?.['value'] as { complete: boolean }).complete).toBe(false);
  });
});

describe('the reads this module hands on', () => {
  test('a read of the graph-read grammar is answered by that grammar\'s own reader', async () => {
    const id = FACTS.find((entry) => entry.fact.kind === 'symbol')!.fact.id;
    const rows = await query(readText({ read: 'fact', id }));
    expect(rows.map((row) => row['id'])).toEqual([id]);
  });

  test('a read a caller makes on its own transaction runs there', async () => {
    // The owner refuses a second transaction on one connection, so a read made
    // inside one has to answer on it: the fact the same transaction wrote is
    // answered by the read, which nothing outside the transaction can see yet.
    const extra = node('directory', { repository: REPOSITORY, path: 'lib' }, 'lib/cart.ts');
    const inside = await owner.transaction('write', async (executor) => {
      await executor.query(
        'INSERT INTO fill_fact (id, kind, schema_version, provenance, layer, status, value) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb)',
        [extra.id, extra.kind, extra.schemaVersion, JSON.stringify(extra.provenance), extra.layer, extra.status, JSON.stringify(extra.value)],
      );
      const reading = createStageReadReader({ database: owner, snapshot: { open: async () => { throw new Error('no stage read of this fixture reads a pinned tree'); } }, executor });
      return await reading.query(publishedTreeRead(REPOSITORY));
    });
    expect((inside as readonly Record<string, unknown>[]).filter((row) => row['kind'] === 'directory').map((row) => row['path']).sort()).toEqual(['lib', 'src']);
    // And once the transaction committed, the same read answers it from the store.
    expect((await query(publishedTreeRead(REPOSITORY))).filter((row) => row['kind'] === 'directory').map((row) => row['path']).sort()).toEqual(['lib', 'src']);
  });
});

describe('a stored fact this read cannot answer', () => {
  test('a path the store holds damaged stops the answer, naming the read, the fact and the path', async () => {
    // A row no writer of this schema would make — the schema refuses this path —
    // written straight into the store as a damaged row is, so the read is the
    // thing under test and not the schema that would have stopped it.
    const damaged = `directory:${'a'.repeat(64)}`;
    await owner.transaction('write', async (executor) => {
      await executor.query(
        "INSERT INTO fill_fact (id, kind, schema_version, provenance, layer, status, value) VALUES ($1, 'directory', 1, $2::jsonb, 'extracted', 'proposed', $3::jsonb)",
        [damaged, JSON.stringify({ source: SOURCE, repository: { id: REPOSITORY, commit: COMMIT } }), JSON.stringify({ repository: REPOSITORY, path: '../outside' })],
      );
    });
    await expect(query(publishedTreeRead(REPOSITORY))).rejects.toThrow(/\.\.\/outside/);
    await expect(query(publishedTreeRead(REPOSITORY))).rejects.toThrow(new RegExp(damaged));
    // It is this read's answer that is stopped; the facts of no other read move.
    expect((await query(publishedDocumentsRead(REPOSITORY))).length).toBe(1);
  });
});

describe('a read larger than one statement answers', () => {
  // madarch-tzte.21.11: the modules stage reads every symbol of a repository at once, and PGlite holds a
  // statement's whole answer in a buffer it grows and copies before the rows are parsed — the read of
  // 28 392 symbols was where the walk over the current madarch tree ran out of memory. A read is asked in
  // pages, so no statement answers more than one page; the answer is still every fact, once, in code point
  // order of the ids, each with the place the fact stands at.
  test('every fact is answered once, in id order, and no statement answers more than a page', async () => {
    const BIG = 'big-api';
    const count = READ_PAGE_ROWS * 2 + 1;
    const file = node('file', { repository: BIG, path: 'src/big.ts', roles: ['source'], language: 'typescript', bytes: 10, blob: BLOB }, 'src/big.ts');
    const symbols = Array.from({ length: count }, (_, at) => node('symbol', { repository: BIG, file: 'src/big.ts', qualifiedName: `f${String(at)}`, symbolKind: 'function' }, 'src/big.ts', 'extracted', at + 1));
    // A call from each symbol to the next: one page of edges and one more.
    const calls = symbols.slice(0, READ_PAGE_ROWS + 1).map((symbol, at) => edge('call', { from: symbol.id, to: symbols[at + 1]!.id, count: at + 1, precision: 'syntactic' }, 'src/big.ts'));
    const big = createPGliteDatabaseOwner();
    try {
      await createFactStoreSchema(big);
      await big.transaction('write', async (executor) => {
        for (const fact of [file, ...symbols, ...calls]) {
          await executor.query(
            'INSERT INTO fill_fact (id, kind, schema_version, provenance, layer, status, value) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb)',
            [fact.id, fact.kind, fact.schemaVersion, JSON.stringify(fact.provenance), fact.layer, fact.status, JSON.stringify(fact.value)],
          );
        }
      });
      await createStageReadSchema(big);
      // The owner the reader is lent, counting the rows each statement answered.
      const answered: number[] = [];
      const counting: Pick<DatabaseOwner, 'transaction'> = {
        transaction: async (kind, work) => await big.transaction(kind, async (executor) => await work({
          query: (async (sql: string, values?: readonly unknown[]) => {
            const result = await executor.query(sql, values);
            answered.push(result.rows.length);
            return result;
          }) as typeof executor.query,
        })),
      };
      const paged = createStageReadReader({ database: counting, snapshot: { open: async () => { throw new Error('no stage read of this fixture reads a pinned tree'); } } });

      const symbolsRead = moduleSymbolsRead(BIG);
      const rows = moduleSymbolRows(await paged.query(symbolsRead), BIG, symbolsRead);
      const expected = symbols.map((symbol) => symbol.id).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      expect(rows.length).toBe(count);
      expect(rows.map((row) => row.id)).toEqual(expected);
      // The place each row stands at is the fact's own: symbol fN is declared on line N + 1.
      expect(rows.every((row) => row.place.startLine === Number(row.value.qualifiedName.slice(1)) + 1)).toBe(true);
      expect(answered.length).toBeGreaterThanOrEqual(3);
      expect(Math.max(...answered)).toBeLessThanOrEqual(READ_PAGE_ROWS);

      answered.length = 0;
      const edgesRead = resolvedEdgesRead(BIG);
      const edges = edgeRows(await paged.query(edgesRead), BIG, edgesRead);
      expect(edges.length).toBe(READ_PAGE_ROWS + 1);
      expect(edges.map((row) => row.weight).sort((left, right) => left - right)).toEqual(calls.map((_, at) => at + 1));
      expect(answered.length).toBeGreaterThanOrEqual(2);
      expect(Math.max(...answered)).toBeLessThanOrEqual(READ_PAGE_ROWS);
    } finally {
      await big.close();
    }
  }, 120_000);
});
