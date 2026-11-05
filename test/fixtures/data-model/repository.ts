/**
 * The repository the data-model stages' focused test generates
 * (madarch-8bdc.2.4): one code repository of a handful of files the test writes
 * itself, and no outside checkout. It holds one database (`orders`) with two
 * migrations, an index, a foreign key and an `ALTER`, a seed script that writes
 * a table, a TypeScript file whose function reads one, a manifest that declares
 * a storage driver, and an environment file that names the connection.
 *
 * The expectations are the test's own, written from the fixture's bytes: which
 * migration carries which ordinal, which table holds which column, and which
 * file owns which record.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The repository's name in the product, and the unit its manifest declares. */
export const REPOSITORY = 'shop';
export const UNIT = 'orders';

/** The files the fixture writes, by path. */
export const FIRST_MIGRATION = 'migrations/0001_init.sql';
export const SECOND_MIGRATION = 'migrations/0002_add_status.sql';
export const SEED = 'scripts/seed.sql';
export const STORE = 'src/store.ts';
export const MANIFEST = 'package.json';
export const ENVIRONMENT = '.env.example';

const FILES: readonly { readonly path: string; readonly text: string }[] = [
  {
    path: MANIFEST,
    text: JSON.stringify({ name: UNIT, dependencies: { pg: '^8.11.0' } }, null, 2) + '\n',
  },
  { path: ENVIRONMENT, text: 'DATABASE_URL=postgres://localhost/orders\n' },
  {
    path: FIRST_MIGRATION,
    text: [
      '-- The database of the shop.',
      'CREATE TABLE customers (',
      '  id TEXT PRIMARY KEY,',
      '  email TEXT NOT NULL UNIQUE',
      ');',
      '',
      'CREATE TABLE orders (',
      '  id TEXT PRIMARY KEY,',
      '  customer_id TEXT NOT NULL,',
      '  total_cents BIGINT NOT NULL DEFAULT 0 CHECK (total_cents >= 0)',
      ');',
      '',
      'CREATE INDEX orders_customer_idx ON orders (customer_id);',
      '',
    ].join('\n'),
  },
  {
    path: SECOND_MIGRATION,
    text: [
      'ALTER TABLE orders ADD COLUMN status TEXT NOT NULL DEFAULT \'new\';',
      "CREATE UNIQUE INDEX orders_status_idx ON orders (status) WHERE status <> '';",
      'ALTER TABLE orders ADD CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE ON UPDATE CASCADE;',
      '',
    ].join('\n'),
  },
  { path: SEED, text: "INSERT INTO orders (id, customer_id) VALUES ('o1', 'c1');\n" },
  {
    path: STORE,
    text: [
      'export interface Client {',
      '  query(sql: string, values: readonly unknown[]): Promise<{ rows: unknown[] }>;',
      '}',
      '',
      'export async function findOrder(client: Client, id: string): Promise<unknown> {',
      '  const result = await client.query(`SELECT id FROM orders WHERE id = $1`, [id]);',
      '  return result.rows[0];',
      '}',
      '',
    ].join('\n'),
  },
  { path: 'README.md', text: '# Shop\n\nThe orders service.\n' },
];

/** One git call in the generated repository, with the fixed identity and date every commit of it carries. */
function git(folder: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: folder,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Data Model Fixture',
      GIT_AUTHOR_EMAIL: 'data-model@example.invalid',
      GIT_COMMITTER_NAME: 'Data Model Fixture',
      GIT_COMMITTER_EMAIL: 'data-model@example.invalid',
      GIT_AUTHOR_DATE: '2024-04-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2024-04-01T00:00:00Z',
    },
  }).trim();
}

/** Writes the fixture repository into `folder` and commits it. */
export function writeRepository(folder: string): string {
  mkdirSync(folder, { recursive: true });
  git(folder, ['init', '-q', '-b', 'main']);
  git(folder, ['config', 'user.name', 'Data Model Fixture']);
  git(folder, ['config', 'user.email', 'data-model@example.invalid']);
  for (const file of FILES) {
    mkdirSync(join(folder, file.path, '..'), { recursive: true });
    writeFileSync(join(folder, file.path), file.text);
  }
  git(folder, ['add', '-A']);
  git(folder, ['commit', '-qm', 'the repository of the data model']);
  return git(folder, ['rev-parse', 'HEAD']);
}

/** The product the fill runs on: one code repository connected under `repos/`, and the product repository itself. */
export function writeProduct(root: string): { readonly product: string; readonly repository: string } {
  const product = join(root, 'product');
  const repository = join(root, REPOSITORY);
  writeRepository(repository);
  mkdirSync(join(product, 'repos'), { recursive: true });
  symlinkSync(repository, join(product, 'repos', REPOSITORY), 'dir');
  writeFileSync(join(product, 'workspace.yaml'), [
    'schemaVersion: 1',
    'id: 3f6a2b18-9c05-4d7e-8a11-2b9e6c4d0f77',
    'name: shop-product',
    'repos:',
    `  - name: ${REPOSITORY}`,
    '    url: file:///shop',
    '',
  ].join('\n'));
  git(product, ['init', '-q', '-b', 'main']);
  git(product, ['config', 'user.name', 'Data Model Fixture']);
  git(product, ['config', 'user.email', 'data-model@example.invalid']);
  git(product, ['add', '-A']);
  git(product, ['commit', '-qm', 'the product of the shop']);
  return { product, repository };
}
