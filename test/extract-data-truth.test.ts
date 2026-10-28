import {expect, test} from 'bun:test';
import {extractDataModel} from '../src/extract/data-model/extract.js';
import type {TreeReader} from '../src/extract/records.js';

function tree(files: Record<string, string>): TreeReader {
  return {paths: Object.keys(files).sort(), read(path) {
    if (!(path in files)) throw new Error(`fixture: ${path}:1: no such source file`);
    return new TextEncoder().encode(files[path]!);
  }};
}

test('service-without-storage: code and non-storage config create no database', async () => {
  const result = await extractDataModel(tree({
    'services/checkout/src/main.ts': 'export function run() { return 1; }\n',
    'services/checkout/src/config.ts': 'export const ORDERS_URL = "http://orders:8080";\n',
    'services/checkout/package.json': '{"dependencies":{"express":"5.0.0"}}',
  }));
  expect(result.nodes.filter((node) => node.kind === 'code.database')).toEqual([]);
});

test('positive storage evidence retains connection and driver sources without fabricating tables', async () => {
  const result = await extractDataModel(tree({
    'services/ledger/package.json': '{"name":"ledger"}',
    'services/ledger/src/main.ts': 'import pg from "pg";\nexport const db = pg;\n',
    'services/ledger/src/config.ts': 'export const url = process.env.DATABASE_URL;\n',
  }));
  const database = result.nodes.find((node) => node.kind === 'code.database');
  expect(database?.key).toBe('code.database:ledger');
  expect(database?.span?.path).toBe('services/ledger/src/config.ts');
  expect(database?.properties['evidence']).toEqual([
    {kind: 'connection-setting', path: 'services/ledger/src/config.ts', line: 1},
    {kind: 'driver', path: 'services/ledger/src/main.ts', line: 1},
  ]);
  expect(result.nodes.filter((node) => node.kind === 'code.table')).toEqual([]);
});

test('deployment connection belongs only to the named service; no sibling database', async () => {
  const result = await extractDataModel(tree({
    'docker-compose.yml': 'services:\n  ledger:\n    environment:\n      DATABASE_URL: postgres://db/ledger\n  checkout:\n    environment:\n      ORDERS_URL: http://orders:8080\n',
    'services/ledger/package.json': '{"name":"ledger"}',
    'services/checkout/package.json': '{"name":"checkout"}',
    'services/ledger/src/main.ts': 'export const name = "ledger";\n',
    'services/checkout/src/main.ts': 'export const name = "checkout";\n',
  }));
  const databases = result.nodes.filter((node) => node.kind === 'code.database');
  expect(databases.map((node) => node.key)).toEqual(['code.database:ledger']);
  expect(databases[0]?.span?.lineStart).toBe(4);
  expect(databases[0]?.properties['evidenceKind']).toBe('deployment-connection');
});

test('a code-created table is positive storage evidence, with its own declaration location', async () => {
  const result = await extractDataModel(tree({
    'services/ledger/go.mod': 'module example.test/ledger\n\ngo 1.22\n',
    'services/ledger/db.go': 'package ledger\nfunc Migrate() { q := `CREATE TABLE entries (id integer PRIMARY KEY);`; _ = q }\n',
  }));
  expect(result.nodes.find((node) => node.kind === 'code.database')?.span?.path).toBe('services/ledger/db.go');
  expect(result.nodes.find((node) => node.kind === 'code.table')?.label).toBe('entries');
});

test('comments-and-prose-are-not-storage: driver mentions, local variable names and disabled configuration create no database', async () => {
  const result = await extractDataModel(tree({
    'services/checkout/src/main.ts': `// import pg from "pg";
/* import other from "postgres";
process.env.DATABASE_URL;
*/
const DATABASE_URL = "example";
const note = 'import pg from "pg"; process.env.DATABASE_URL';
export function run() { return note; }
`,
    'services/checkout/.env.example': '# DATABASE_URL=postgres://disabled\nORDERS_URL=http://orders:8080\n',
  }));
  expect(result.nodes.filter((node) => node.kind === 'code.database')).toEqual([]);
});


test('sibling table is not caller storage without connection evidence; own table remains positive', async () => {
 const foreign = await extractDataModel(tree({
  'services/a/go.mod': 'module example.test/a\n\ngo 1.22\n',
  'services/b/go.mod': 'module example.test/b\n\ngo 1.22\n',
  'services/a/db.go': 'package a\nfunc Migrate() { q := `CREATE TABLE entries (id integer PRIMARY KEY);`; _ = q }\n',
  'services/b/read.go': 'package b\nfunc Read() { q := `SELECT id FROM entries`; _ = q }\n',
 }));
 expect(foreign.edges.some((edge) => edge.from.startsWith('code.symbol:services/b/') && edge.to === 'code.table:a/public.entries')).toBe(false);
 expect(foreign.gaps.some((gap) => gap.path === 'services/b/read.go' && gap.reason.includes('entries'))).toBe(true);
 const own = await extractDataModel(tree({
  'services/b/go.mod': 'module example.test/b\n\ngo 1.22\n',
  'services/b/db.go': 'package b\nfunc Migrate() { q := `CREATE TABLE entries (id integer PRIMARY KEY);`; _ = q }\n',
  'services/b/read.go': 'package b\nfunc Read() { q := `SELECT id FROM entries`; _ = q }\n',
 }));
 expect(own.edges.some((edge) => edge.from.startsWith('code.symbol:services/b/') && edge.to.includes('entries'))).toBe(true);
});
