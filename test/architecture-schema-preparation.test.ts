import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { architectureCheck, architectureCheckPasses, architectureProblemLines, renderViolationListOf } from '../scripts/check/architecture/check.js';
import { graphWriteViolations } from '../scripts/check/architecture/graph-writes.js';

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'madarch-schema-rule-'));
  for (const [file, text] of Object.entries({ '.architecture/violations.json': '[]', ...files })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const boundaries = {
  'src/adapters/prepare-store.ts': "import './schemas/graph.js'; import './schema-stamp.js';",
  'src/adapters/schema-stamp.ts': "export function createSchemaOnce() {}; const sql = 'CREATE TABLE stamp(id int)';",
  'src/adapters/schemas/graph.ts': "import '../schema-stamp.js'; import './queue.js'; const sql = 'CREATE TABLE node(id int)';",
  'src/adapters/schemas/queue.ts': "const sql = 'CREATE TABLE queue(id int)';",
  'src/adapters/schemas/graph-definition.ts': 'export const version = 1;',
};

const check = (root: string) => architectureCheck({ root, rules: ['schema-preparation-only'] });

describe('schema preparation boundary', () => {
  test('only preparation owns DDL, owners import preparation, runtime reads pure definitions and DML', async () => {
    const root = fixture({
      ...boundaries,
      'src/adapters/store-preparation-owner.ts': "import './prepare-store.js';",
      'src/product/daemon.ts': "import '../adapters/prepare-store.js';",
      'src/product/cli.ts': "import '../adapters/prepare-store.js';",
      'src/adapters/database-owner.ts': 'const sql = `CREATE DATABASE "product"; ALTER DATABASE product RENAME TO archived; DROP DATABASE archived`;',
      'src/adapters/runtime.ts': "import './schemas/graph-definition.js'; const sql = `UPDATE node SET id = 1; SELECT 'CREATE TABLE hidden(id int)'; -- DROP TABLE hidden\n/* ALTER TABLE hidden */`;// CREATE TABLE prose(id int)",
      'test/arbitrary.ts': "import '../src/adapters/prepare-store.js'; const sql = 'CREATE TABLE fixture(id int)';",
    });
    expect((await check(root)).found).toEqual([]);
  });

  test.each([
    ['CREATE TABLE x(id int)', 'CREATE TABLE'],
    ['CREATE /* comment */ UNIQUE INDEX ix ON x(id)', 'CREATE INDEX'],
    ['ALTER TABLE x ADD COLUMN name text', 'ALTER TABLE'],
    ['DROP SCHEMA x CASCADE', 'DROP SCHEMA'],
    ['CREATE EXTENSION vector', 'CREATE EXTENSION'],
    ['CREATE SEQUENCE ids', 'CREATE SEQUENCE'],
    ['CREATE OR REPLACE FUNCTION f() RETURNS int AS $$SELECT 1$$ LANGUAGE sql', 'CREATE FUNCTION'],
    ["CREATE TYPE state AS ENUM ('a')", 'CREATE TYPE'],
    ['CREATE VIEW v AS SELECT 1', 'CREATE VIEW'],
  ])('refuses runtime SQL %s with the full path and line', async (sql, symbol) => {
    const root = fixture({ 'src/adapters/runtime.ts': `// preface\nconst sql = ${JSON.stringify(sql)};` });
    const report = await check(root);
    expect(report.found).toEqual([{ rule: 'schema-preparation-only', file: 'src/adapters/runtime.ts', line: 2, symbol }]);
    expect(architectureProblemLines(report)[0]).toContain(`${join(root, 'src/adapters/runtime.ts')}:2: schema-preparation-only:`);
    expect(architectureCheckPasses(report)).toBe(false);
    expect(renderViolationListOf(report)).toBe('[]\n');
  });

  test('templates, multiple statements and database owner extensions are governed', async () => {
    const root = fixture({ 'src/adapters/database-owner.ts': 'const sql = `CREATE DATABASE product;\nCREATE EXTENSION vector;\nCREATE TABLE ${name}(id int)`;' });
    expect((await check(root)).found.map(({ line, symbol }) => ({ line, symbol }))).toEqual([
      { line: 2, symbol: 'CREATE EXTENSION' }, { line: 3, symbol: 'CREATE TABLE' },
    ]);
  });

  test.each([
    "import './schemas/graph.js';",
    "export * from './schemas/graph.js';",
    "const schema = await import('./schemas/graph.js');",
    "const schema = require('./schemas/graph.js');",
    "const schema = load('src/adapters/prepare-store.ts');",
    "import './schema-stamp.js';",
    "import './prepare-store.js';",
    "import { createSchemaOnce as make } from './other.js';",
    'createSchemaOnce(owner, 1);',
    'schema.createSchemaOnce(owner, 1);',
  ])('refuses runtime preparation access %s', async (plant) => {
    const root = fixture({ ...boundaries, 'src/adapters/other.ts': 'export function createSchemaOnce() {}', 'src/adapters/runtime.ts': `// preface\n${plant}` });
    const report = await check(root);
    expect(report.found).toHaveLength(1);
    expect(report.found[0]?.line).toBe(2);
  });

  test('a baseline cannot excuse schema preparation in runtime code', async () => {
    const root = fixture({
      'src/runtime.ts': "const sql = 'DROP TABLE x';",
      '.architecture/violations.json': JSON.stringify([{ rule: 'schema-preparation-only', file: 'src/runtime.ts', symbol: 'DROP TABLE' }]),
    });
    expect(architectureCheckPasses(await check(root))).toBe(false);
    expect((await check(root)).noBaseline).toHaveLength(1);
  });

  test('runtime-visible graph definitions cannot import executable preparation', async () => {
    const root = fixture({ ...boundaries, 'src/adapters/schemas/graph-definition.ts': "import './graph.js';" });
    expect((await check(root)).found).toEqual([{ rule: 'schema-preparation-only', file: 'src/adapters/schemas/graph-definition.ts', line: 1, symbol: 'src/adapters/schemas/graph.ts' }]);
  });

  test('graph schema migration may write graph rows but another schema cannot', () => {
    const root = fixture({
      'src/adapters/schemas/graph-contract.ts': "const sql = 'INSERT INTO node(id) VALUES (1)';",
      'src/adapters/schemas/queue.ts': "const sql = 'INSERT INTO node(id) VALUES (1)';",
    });
    expect(graphWriteViolations(root).map(({ file }) => file)).toEqual(['src/adapters/schemas/queue.ts']);
  });
});
