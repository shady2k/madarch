import {describe, expect, test} from 'bun:test';
import {extractDataModel} from '../src/extract/data-model/extract.js';
import {fileKey, tableKey} from '../src/extract/data-model/keys.js';
import type {ExtractedEdge, Extraction, SourceSpan, TreeReader} from '../src/extract/records.js';

const scriptPath = 'scripts/fill.sql';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const migrationPath = (service: string): string => `services/${service}/migrations/0001.sql`;

async function extract(script: string, declarations: Record<string, string> = {
  [migrationPath('alpha')]: 'CREATE TABLE public.entries (id TEXT);',
}): Promise<Extraction> {
  const files: Record<string, string> = {...declarations, [scriptPath]: script};
  const tree: TreeReader = {
    paths: Object.keys(files),
    read(path) {
      const text = files[path];
      if (text === undefined) throw new Error(`missing fixture ${path}`);
      return encoder.encode(text);
    },
  };
  // This lane tests SQL scripts, not a second code-facts extraction.
  return await extractDataModel(tree, {producer: 'code.extract.code', nodes: [], edges: [], gaps: []});
}

function writes(extraction: Extraction): readonly ExtractedEdge[] {
  return extraction.edges.filter((edge) => edge.type === 'code.writes-table' && edge.from === fileKey(scriptPath));
}

function sites(edge: ExtractedEdge): readonly SourceSpan[] {
  return edge.properties['sites'] as unknown as readonly SourceSpan[];
}

function seedGaps(extraction: Extraction) {
  return extraction.gaps.filter((gap) => gap.path === scriptPath);
}

describe('seed PostgreSQL syntax boundary', () => {
  test('quoted Unicode targets and multi-statements retain full raw UTF-8 spans', async () => {
    const first = `-- café 😀: keep the leading comment
INSERT INTO "public"."réserves" (id) VALUES ('a;b')`;
    const second = `
/* résumé */ INSERT INTO "public"."réserves" (id) VALUES ($body$x;y$body$)`;
    const script = `${first};${second};`;
    const result = await extract(script, {
      'services/alpha/prisma/schema.prisma': `model Entry {
  id String @id
  @@map("réserves")
}
`,
    });
    expect(seedGaps(result)).toEqual([]);
    expect(writes(result)).toHaveLength(2);
    expect(writes(result).map((edge) => edge.to)).toEqual([
      tableKey('alpha', 'réserves', 'public'), tableKey('alpha', 'réserves', 'public'),
    ]);
    const spans = writes(result).flatMap((edge) => sites(edge));
    expect(spans).toHaveLength(2);
    expect(spans[0]).toEqual({path: scriptPath, byteStart: 0, byteEnd: encoder.encode(first).length, lineStart: 1, lineEnd: 2});
    expect(spans[1]).toEqual({path: scriptPath, byteStart: encoder.encode(`${first};`).length, byteEnd: encoder.encode(`${first};${second}`).length, lineStart: 2, lineEnd: 3});
    expect(spans.map((span) => decoder.decode(encoder.encode(script).slice(span.byteStart, span.byteEnd)))).toEqual([first, second]);
  });

  test('an unterminated-by-semicolon final INSERT cites the full remaining statement', async () => {
    const script = `INSERT INTO entries (id) VALUES ('café')  -- trailing evidence
`;
    const result = await extract(script);
    expect(seedGaps(result)).toEqual([]);
    expect(sites(writes(result)[0]!)).toEqual([{path: scriptPath, byteStart: 0, byteEnd: encoder.encode(script).length, lineStart: 1, lineEnd: 2}]);
  });

  test('INSERT text in line and block comments is neither a write nor recognized SQL', async () => {
    const result = await extract(`-- INSERT INTO entries VALUES ('fake');
/* CREATE TABLE ghost (id int); INSERT INTO entries VALUES ('fake'); */`);
    expect(writes(result)).toEqual([]);
    expect(seedGaps(result)).toEqual([{path: scriptPath, reason: `${scriptPath}:1: no PostgreSQL statement could be read`}]);
  });

  test('INSERT text in ordinary and dollar-quoted literals is not a write', async () => {
    const result = await extract("SELECT 'INSERT INTO entries VALUES (1);', $$INSERT INTO entries VALUES (2);$$;");
    expect(writes(result)).toEqual([]);
    expect(seedGaps(result)).toEqual([]);
  });

  test('malformed SQL reports its full path and line without a partial write result', async () => {
    const result = await extract(`-- café 😀
INSERT INTO entries VALUES ('valid');
INSERT INTO entries VALUES (;`);
    expect(writes(result)).toEqual([]);
    expect(seedGaps(result)).toHaveLength(1);
    expect(seedGaps(result)[0]!.reason).toContain(`${scriptPath}:3: PostgreSQL parse failed:`);
    expect(seedGaps(result)[0]!.reason).toContain('syntax error');
  });

  test('CREATE and ALTER are recognized through the AST, not their text in a decoy', async () => {
    const result = await extract('CREATE TABLE staging (id int); ALTER TABLE staging ADD COLUMN note text;');
    expect(writes(result)).toEqual([]);
    expect(seedGaps(result)).toEqual([]);
    const decoy = await extract("'CREATE TABLE staging (id int)'");
    expect(writes(decoy)).toEqual([]);
    expect(seedGaps(decoy)[0]!.reason).toContain('PostgreSQL parse failed:');
  });

  test('explicit schemas resolve their own table, while an unqualified name is ambiguous', async () => {
    const declarations = {
      [migrationPath('alpha')]: 'CREATE TABLE accounting.entries (id TEXT);',
      [migrationPath('beta')]: 'CREATE TABLE reporting.entries (id TEXT);',
    };
    const qualified = await extract("INSERT INTO reporting.entries VALUES ('one');", declarations);
    expect(seedGaps(qualified)).toEqual([]);
    expect(writes(qualified).map((edge) => edge.to)).toEqual([tableKey('beta', 'entries', 'reporting')]);
    const ambiguous = await extract("INSERT INTO entries VALUES ('one');", declarations);
    expect(writes(ambiguous)).toEqual([]);
    expect(seedGaps(ambiguous)[0]!.reason).toContain('not declared by exactly one database');
    const absent = await extract("INSERT INTO other.entries VALUES ('one');", declarations);
    expect(writes(absent)).toEqual([]);
    expect(seedGaps(absent)[0]!.reason).toContain('other.entries');
  });

  test('catalog qualification is retained instead of resolving by the bare table name', async () => {
    const declarations = {
      [migrationPath('alpha')]: 'CREATE TABLE public.entries (id TEXT);',
      [migrationPath('beta')]: 'CREATE TABLE public.entries (id TEXT);',
    };
    const result = await extract("INSERT INTO beta.public.entries VALUES ('one');", declarations);
    expect(seedGaps(result)).toEqual([]);
    expect(writes(result).map((edge) => edge.to)).toEqual([tableKey('beta', 'entries', 'public')]);
    const absent = await extract("INSERT INTO missing.public.entries VALUES ('one');", declarations);
    expect(writes(absent)).toEqual([]);
    expect(seedGaps(absent)[0]!.reason).toContain('missing.public.entries');
  });

  test('collapsed same-database schema declarations produce a gap, not a guessed write', async () => {
    const result = await extract("INSERT INTO accounting.entries VALUES ('one');", {
      [migrationPath('alpha')]: 'CREATE TABLE accounting.entries (id TEXT); CREATE TABLE reporting.entries (id TEXT);',
    });
    expect(writes(result)).toEqual([]);
    expect(seedGaps(result)[0]!.reason).toContain('not declared by exactly one database');
  });
});
