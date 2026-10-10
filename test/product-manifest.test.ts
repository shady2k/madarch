/**
 * The consumer tests of the pinned program's contract (madarch-4fk, decision
 * 0019): madarch reads the manifest through the skill set's product-repository
 * program, so the set's own fixtures are the contract this reader is held to.
 * The manifest cases (fixtures/workspace/cases.json) are run against
 * `readProduct` exactly as the program's `--selftest` runs them against its
 * own reader — every identity field and every refusal, the line and the
 * message's words included — so a form changed in the set reaches madarch's
 * CI rather than a reader. The set's example product folder
 * (fixtures/product/good) and a folder written by hand must read the same
 * way, which is what `madarch serve` and `madarch list` sit on.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'bun:test';
import { readProduct } from '../src/product/manifest.js';

/** The vendored pinned release the program is read from (pinned in src/product/program.ts). */
const PROGRAM = fileURLToPath(new URL('../vendor/shady2k-skills/0.94.0/product.mjs', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../vendor/shady2k-skills/0.94.0/fixtures/', import.meta.url));

/** Every temporary folder this file makes, removed on exit with whatever is left. */
const made: string[] = [];
const removeMadeFolders = (): void => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
};
afterAll(removeMadeFolders);

function tempFolder(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** One manifest case of the set's, read by madarch. */
interface ManifestCase {
  name: string;
  text: string | null;
  folder?: string;
  ok?: Record<string, unknown>;
  line?: number;
  message?: string;
}

const casesFile = join(FIXTURES, 'workspace', 'cases.json');
const suite = JSON.parse(readFileSync(casesFile, 'utf8')) as { about: string; folder: string; cases: ManifestCase[] };
const CASES = suite.cases;
const GOOD = join(FIXTURES, 'product', 'good');

describe('the manifest reader against the set\'s own fixture cases', () => {
  test(`every one of the ${CASES.length} cases the set publishes agrees with madarch's reader`, () => {
    const base = tempFolder('madarch-manifest-cases-');
    const mismatches: string[] = [];
    for (const one of CASES) {
      const folder = join(base, one.folder ?? suite.folder);
      mkdirSync(folder, { recursive: true });
      if (one.text !== null && one.text !== undefined) writeFileSync(join(folder, 'workspace.yaml'), one.text);
      const read = readProduct(folder);
      rmSync(folder, { recursive: true, force: true });
      if (one.ok !== undefined && one.ok !== null) {
        if (!read.ok) {
          mismatches.push(`${one.name}: expected to read, got refused at line ${read.line}: ${read.message}`);
        } else {
          const product = read.product as unknown as Record<string, unknown>;
          for (const [field, expected] of Object.entries(one.ok)) {
            if (JSON.stringify(product[field]) !== JSON.stringify(expected)) {
              mismatches.push(`${one.name}: field ${field} expected ${JSON.stringify(expected)}, got ${JSON.stringify(product[field])}`);
            }
          }
        }
      } else {
        const line = one.line ?? 1;
        const same = read.ok === false && read.line === line && read.message.includes(one.message ?? '');
        if (!same) {
          mismatches.push(`${one.name}: expected refused at line ${line} naming ${JSON.stringify(one.message ?? '')}, got ${read.ok ? 'read as ok' : `line ${read.line}: ${read.message}`}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  test('the set\'s example product folder reads back with its identity, its skills and its repos', () => {
    const read = readProduct(GOOD);
    expect(read).toMatchObject({
      ok: true,
      product: {
        folder: GOOD,
        id: '8f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
        name: 'leftover-listings',
        schemaVersion: 1,
        skills: { shady2k: '0.90.0' },
        repos: [
          { name: 'api', url: 'https://example.invalid/leftover-listings-api.git', branch: 'main' },
          { name: 'web', url: 'https://example.invalid/leftover-listings-web.git' },
        ],
      },
    });
  });

  test('a folder written by hand reads the same way, its name falling back to the folder\'s', () => {
    const folder = join(tempFolder('madarch-manifest-hand-'), 'written-by-hand');
    mkdirSync(folder);
    // No name: the folder's own name is the product's, as a draft's is.
    writeFileSync(join(folder, 'workspace.yaml'), ['schemaVersion: 1', 'id: 3f6d2dc8-b16e-4bf0-9d3a-2c9c00b5287d', ''].join('\n'));
    const read = readProduct(folder);
    expect(read).toMatchObject({ ok: true, product: { id: '3f6d2dc8-b16e-4bf0-9d3a-2c9c00b5287d', name: 'written-by-hand', schemaVersion: 1, skills: {}, repos: [] } });
  });

  test('the pinned program\'s own reader and madarch\'s refuse the same manifest the same way', () => {
    // One case run twice, through the program's CLI and through madarch's
    // reader: the refusal's words are the program's, and madarch adds none.
    const folder = join(tempFolder('madarch-manifest-same-'), 'broken');
    mkdirSync(folder);
    writeFileSync(join(folder, 'workspace.yaml'), ['schemaVersion: 1', 'id: 3f6d2dc8-b16e-4bf0-9d3a-2c9c00b5287d', 'name: 5', ''].join('\n'));
    const run = spawnSync('node', [PROGRAM, 'read', folder], { encoding: 'utf8' });
    expect(run.status).toBe(2);
    const madarch = readProduct(folder);
    expect(madarch.ok).toBe(false);
    if (madarch.ok) return;
    expect(`${madarch.file}:${madarch.line}: ${madarch.message}`).toBe(run.stderr.trim());
  });
});
