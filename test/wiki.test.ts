import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REFERENCE_SYSTEM } from '../scripts/render-views.js';
import { Repo } from './model-check-repo.js';

/**
 * The wiki command end to end (docs/changes/wiki/capabilities/wiki.md,
 * requirements engine and result): exit codes 0, 1 and 2, what each refuses
 * to write, and the engine choice from --engine, then MADARCH_WIKI_ENGINE,
 * then zensical. The engine's own build is faked by the fixtures under
 * test/fixtures/wiki/ so the regular suite never needs uv; the one real
 * Zensical build is gated at the bottom, because CI has no uv and the
 * owner has decided real engine builds run only under MADARCH_WIKI_E2E=1.
 */

const SCRIPT = fileURLToPath(new URL('../scripts/wiki.ts', import.meta.url));
const FAKE_BIN = fileURLToPath(new URL('./fixtures/wiki/fake-uvx', import.meta.url));
const FAILING_BIN = fileURLToPath(new URL('./fixtures/wiki/failing-uvx', import.meta.url));
const FAKE_LOG = join(FAKE_BIN, 'invocations.log');

function outFolder(): string {
  return join(mkdtempSync(join(tmpdir(), 'madarch-wiki-')), 'out');
}

/**
 * Runs the wiki script with `path` as the child's whole PATH. The fake
 * bins come first so they are the `uv`/`uvx` the script finds, with the
 * real system kept behind them for the fakes' own commands; a PATH of one
 * empty dir (the no-uv case) strips everything.
 */
function runWiki(args: readonly string[], path: string = `${FAKE_BIN}:${process.env.PATH ?? ''}`, extraEnv: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, PATH: path, ...extraEnv } });
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

function combined(run: { stdout: string; stderr: string }): string {
  return `${run.stdout}\n${run.stderr}`;
}

/** Every file under `root`, by path relative to it. */
function walkFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(full.slice(root.length + 1), readFileSync(full, 'utf8'));
    }
  };
  walk(root);
  return files;
}

describe('scripts/wiki.ts', () => {
  test('builds the reference system: exit 0, the site path printed, source and site written', () => {
    rmSync(FAKE_LOG, { force: true });
    const out = outFolder();
    const run = runWiki([REFERENCE_SYSTEM, '--out', out]);
    expect(run.status).toBe(0);
    const site = resolve(out, 'site');
    expect(run.stdout).toContain(site);
    expect(readFileSync(join(site, 'index.html'), 'utf8')).toContain('fake zensical site');

    const index = readFileSync(join(out, 'source', 'docs', 'index.md'), 'utf8');
    expect(index).toContain('# Home');
    expect(index).toContain('The model holds 70 elements, 51 interfaces and 109 relations.');
    expect(index).toContain('| broker | 1 |');
    expect(index).toContain('| domain | 6 |');
    expect(index).toContain('| external | 3 |');
    expect(index).toContain('| module | 4 |');
    expect(index).toContain('| person | 2 |');
    expect(index).toContain('| service | 29 |');
    expect(index).toContain('| store | 25 |');
    expect(index).toContain('| [Catalog](domains/catalog.md) | 12 |');
    expect(index).toContain('| [Fulfilment](domains/fulfilment.md) | 8 |');
    expect(index).toContain('| [Ordering](domains/ordering.md) | 15 |');
    expect(index).toContain('| [Payments](domains/payments.md) | 8 |');
    expect(index).toContain('| [Platform](domains/platform.md) | 7 |');
    expect(index).toContain('| [Storefront](domains/storefront.md) | 10 |');

    const ordering = readFileSync(join(out, 'source', 'docs', 'domains', 'ordering.md'), 'utf8');
    expect(ordering).toContain('# Ordering');
    expect(ordering).toContain('The Ordering domain holds 15 elements.');
    expect(ordering).toContain('| Checkout | service | TypeScript, NestJS |');

    const domainFiles = readdirSync(join(out, 'source', 'docs', 'domains'));
    expect(domainFiles.sort()).toEqual(['catalog.md', 'fulfilment.md', 'ordering.md', 'payments.md', 'platform.md', 'storefront.md']);
    expect(readFileSync(join(out, 'source', 'zensical.toml'), 'utf8')).toContain('"Ordering" = "domains/ordering.md"');
    expect(readFileSync(FAKE_LOG, 'utf8')).toContain('zensical==0.0.66 build');
  });

  test('--engine hugo exits 2 naming the value and the allowed engines, and writes nothing', () => {
    const out = outFolder();
    const run = runWiki([REFERENCE_SYSTEM, '--out', out, '--engine', 'hugo']);
    expect(run.status).toBe(2);
    const said = combined(run);
    expect(said).toContain('hugo');
    expect(said).toContain('zensical');
    expect(said).toContain('starlight');
    expect(existsSync(out)).toBe(false);
  });

  test('the engine comes from MADARCH_WIKI_ENGINE, and --engine wins over it', () => {
    const refused = outFolder();
    expect(runWiki([REFERENCE_SYSTEM, '--out', refused], undefined, { MADARCH_WIKI_ENGINE: 'hugo' }).status).toBe(2);
    expect(existsSync(refused)).toBe(false);

    const built = outFolder();
    const run = runWiki([REFERENCE_SYSTEM, '--out', built, '--engine', 'zensical'], undefined, { MADARCH_WIKI_ENGINE: 'hugo' });
    expect(run.status).toBe(0);
    expect(existsSync(join(built, 'site', 'index.html'))).toBe(true);
  });

  test('--engine starlight exits 2 saying it is not built yet, and writes nothing', () => {
    const out = outFolder();
    const run = runWiki([REFERENCE_SYSTEM, '--out', out, '--engine', 'starlight']);
    expect(run.status).toBe(2);
    expect(combined(run)).toContain('starlight');
    expect(existsSync(out)).toBe(false);

    const byEnv = outFolder();
    const envRun = runWiki([REFERENCE_SYSTEM, '--out', byEnv], undefined, { MADARCH_WIKI_ENGINE: 'starlight' });
    expect(envRun.status).toBe(2);
    expect(existsSync(byEnv)).toBe(false);
  });

  test('without uv on PATH it exits 2 naming how to install uv, and writes nothing', () => {
    const out = outFolder();
    const empty = mkdtempSync(join(tmpdir(), 'madarch-wiki-nouvp-'));
    const run = runWiki([REFERENCE_SYSTEM, '--out', out], empty);
    expect(run.status).toBe(2);
    const said = combined(run);
    expect(said).toContain('uv');
    expect(said).toContain('astral.sh');
    expect(existsSync(out)).toBe(false);
  });

  test('a failing engine build exits 1 and prints the engine output', () => {
    const out = outFolder();
    const run = runWiki([REFERENCE_SYSTEM, '--out', out], `${FAILING_BIN}:${process.env.PATH ?? ''}`);
    expect(run.status).toBe(1);
    const said = combined(run);
    expect(said).toContain('zensical exploded');
    expect(said).toContain('zensical build failed');
    expect(existsSync(join(out, 'site'))).toBe(false);
    expect(existsSync(join(out, 'source', 'docs', 'index.md'))).toBe(true);
  });

  test('a model naming an unknown parent exits 2 with the error file and line, and builds nothing', () => {
    const repo = new Repo();
    repo.writeModel(
      'model.yaml',
      ['version: 1', '', 'elements:', '  - id: orphan', '    kind: service', '    name: Orphan', '    parent: nobody', ''].join('\n'),
    );
    const line = repo.lineOf('model.yaml', 'parent: nobody');
    const out = outFolder();
    const run = runWiki([repo.path, '--out', out]);
    expect(run.status).toBe(2);
    expect(combined(run)).toContain(`madarch/model.yaml:${line}`);
    expect(existsSync(out)).toBe(false);
  });

  test('two runs over the same repository write byte-identical page sources', () => {
    const first = outFolder();
    const second = outFolder();
    expect(runWiki([REFERENCE_SYSTEM, '--out', first]).status).toBe(0);
    expect(runWiki([REFERENCE_SYSTEM, '--out', second]).status).toBe(0);
    const left = walkFiles(join(first, 'source'));
    const right = walkFiles(join(second, 'source'));
    const entries = (files: Map<string, string>): [string, string][] => [...files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    expect(entries(left)).toEqual(entries(right));
  });

  test('usage errors exit 2 with the usage line', () => {
    expect(runWiki([]).status).toBe(2);
    expect(combined(runWiki([]))).toContain('usage: bun scripts/wiki.ts');
    expect(runWiki([REFERENCE_SYSTEM]).status).toBe(2);
    expect(runWiki([REFERENCE_SYSTEM, '--out']).status).toBe(2);
    expect(runWiki([REFERENCE_SYSTEM, '--out', outFolder(), '--bogus']).status).toBe(2);
  });
});

describe('scripts/wiki.ts with a real Zensical build', () => {
  test.skipIf(!process.env.MADARCH_WIKI_E2E)(
    'builds the reference system into a real static site',
    () => {
      const out = outFolder();
      const run = runWiki([REFERENCE_SYSTEM, '--out', out], process.env.PATH ?? '');
      expect(run.status).toBe(0);
      expect(run.stdout).toContain(resolve(out, 'site'));
      expect(existsSync(join(out, 'site', 'index.html'))).toBe(true);
      expect(existsSync(join(out, 'source', 'docs', 'index.md'))).toBe(true);
    },
    { timeout: 180_000 },
  );
});
