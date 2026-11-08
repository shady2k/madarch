/**
 * The repository the resolution stage's acceptance tests generate: `count`
 * TypeScript files in a ring, each importing one other file's class and
 * function, extending the class, calling the function twice and mentioning the
 * class once. Nothing comes from an outside repository, the bytes are written
 * by this module, and the edges the file pass and the resolution stage must
 * publish are `expectedEdgesOf`'s own answer — the generator, not the code under
 * test, says what a resolution of these files is.
 *
 * The commits are pinned: a fixed author, a fixed committer and fixed dates, so
 * two runs of one count stand on one commit and a repository the test makes
 * twice is the same repository.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFirstFillWorkflow } from '../../fill-workflow-fixture.js';

/** One file the generator writes: its repository path and its bytes. */
export interface GeneratedFile {
  readonly path: string;
  readonly text: string;
}

/** One edge the resolution of a generated repository must publish, by the names a reader sees. */
export interface ExpectedEdge {
  readonly relation: 'code.calls' | 'code.inherits' | 'code.references';
  /** The file and the qualified name of the symbol the edge starts at. */
  readonly fromFile: string;
  readonly fromName: string;
  /** The file and the qualified name of the symbol the edge ends at. */
  readonly toFile: string;
  readonly toName: string;
}

/** The file one index of the ring stands in. */
export function fileOf(index: number): string {
  return `src/f${String(index)}.ts`;
}

/** The bytes of one file of the ring: its import of the next file, a class, a function, and the uses of both. */
function fileText(index: number, count: number): string {
  const next = (index + 1) % count;
  return [
    `import { make${String(next)}, Thing${String(next)} } from './f${String(next)}.js';`,
    '',
    `export class Thing${String(index)} extends Thing${String(next)} {`,
    '  run(): number {',
    `    return make${String(next)}(1);`,
    '  }',
    '}',
    '',
    `export function make${String(index)}(n: number): number {`,
    '  return n;',
    '}',
    '',
    `export const used${String(index)} = make${String(next)}(2);`,
    `export const ref${String(index)} = Thing${String(next)};`,
    '',
  ].join('\n');
}

/** Every file of a repository of `count` files, in code point order of their paths. */
export function filesOf(count: number): readonly GeneratedFile[] {
  if (!Number.isInteger(count) || count < 2) throw new Error(`the generated repository holds a ring of at least two files, and ${String(count)} is no count of them (test/fixtures/resolution-graph/repository.ts)`);
  const files: GeneratedFile[] = [];
  for (let index = 0; index < count; index += 1) files.push({ path: fileOf(index), text: fileText(index, count) });
  return files;
}

/** Every edge the resolution of a repository of `count` files must publish, in a stable order. */
export function expectedEdgesOf(count: number): readonly ExpectedEdge[] {
  const edges: ExpectedEdge[] = [];
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    const from = fileOf(index);
    const to = fileOf(next);
    edges.push({ relation: 'code.inherits', fromFile: from, fromName: `Thing${String(index)}`, toFile: to, toName: `Thing${String(next)}` });
    edges.push({ relation: 'code.calls', fromFile: from, fromName: `Thing${String(index)}.run`, toFile: to, toName: `make${String(next)}` });
    edges.push({ relation: 'code.calls', fromFile: from, fromName: `used${String(index)}`, toFile: to, toName: `make${String(next)}` });
    edges.push({ relation: 'code.references', fromFile: from, fromName: `ref${String(index)}`, toFile: to, toName: `Thing${String(next)}` });
  }
  return edges;
}

/** One git call in the generated repository, with the fixed identity and dates every commit of it carries. */
function git(folder: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: folder,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Resolution Fixture',
      GIT_AUTHOR_EMAIL: 'resolution@example.invalid',
      GIT_COMMITTER_NAME: 'Resolution Fixture',
      GIT_COMMITTER_EMAIL: 'resolution@example.invalid',
      GIT_AUTHOR_DATE: '2024-02-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2024-02-01T00:00:00Z',
    },
  }).trim();
}

/** Writes the repository of `count` files into `folder` and commits it, answering the commit it stands on. */
export function writeRepository(folder: string, count: number): string {
  mkdirSync(folder, { recursive: true });
  git(folder, ['init', '-q', '-b', 'main']);
  git(folder, ['config', 'user.name', 'Resolution Fixture']);
  git(folder, ['config', 'user.email', 'resolution@example.invalid']);
  for (const file of filesOf(count)) {
    mkdirSync(join(folder, file.path, '..'), { recursive: true });
    writeFileSync(join(folder, file.path), file.text);
  }
  git(folder, ['add', '-A']);
  git(folder, ['commit', '-qm', `the ring of ${String(count)} files`]);
  return git(folder, ['rev-parse', 'HEAD']);
}

/** The product the fill runs on: one code repository, connected under `repos/`, and the product repository itself. */
export function writeProduct(root: string, count: number): { readonly product: string; readonly repository: string } {
  const product = join(root, 'product');
  // The code repository stands beside the product and is connected under `repos/` by a link, which is
  // what `madarch repo add` makes: the product's own commit holds the link and not the tree.
  const repository = join(root, 'ring');
  writeRepository(repository, count);
  mkdirSync(join(product, 'repos'), { recursive: true });
  symlinkSync(repository, join(product, 'repos', 'ring'), 'dir');
  mkdirSync(product, { recursive: true });
  writeFileSync(join(product, 'workspace.yaml'), [
    'schemaVersion: 1',
    'id: 3f1d8a52-9c3e-4f7a-8b21-6d2e9c0a5b31',
    // The product repository and the code repository are two pins, and one run pins each once.
    'name: ring-product',
    'repos:',
    '  - name: ring',
    '    url: file:///ring',
    '',
  ].join('\n'));
  writeFirstFillWorkflow(product);
  git(product, ['init', '-q', '-b', 'main']);
  git(product, ['config', 'user.name', 'Resolution Fixture']);
  git(product, ['config', 'user.email', 'resolution@example.invalid']);
  git(product, ['add', '-A']);
  git(product, ['commit', '-qm', 'the product of the ring']);
  return { product, repository };
}
