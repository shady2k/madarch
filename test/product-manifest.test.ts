/**
 * The consumer tests of madarch's own manifest reader (decision 0021: the
 * product repository's manifest is madarch's contract, read by madarch's own
 * code). The reader is held to the contract's conformance cases — every
 * manifest case in `examples/contract/manifest-cases.json`, the identity and
 * every refusal with its file, line and message's words — in folders the
 * tests build themselves, and to the contract's example products under
 * `examples/contract/`, so `madarch serve` and `madarch list` sit on the
 * same reading the check command runs. A folder written by hand reads the
 * same way as the examples', which is the walk's third road.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'bun:test';
import { readProduct, manifestNamed, manifestWithRepo, yamlWord, yamlText, cutComment, decodedKeyWord, parseManifest } from '../src/product/manifest.js';

const EXAMPLES = fileURLToPath(new URL('../examples/contract/', import.meta.url));
const SET_MADE = join(EXAMPLES, 'set-made-product');

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

/** One manifest case of the contract's examples, read by madarch. */
interface ManifestCase {
  name: string;
  text: string | null;
  folder?: string;
  ok?: Record<string, unknown>;
  line?: number;
  message?: string;
}

const casesFile = join(EXAMPLES, 'manifest-cases.json');
const suite = JSON.parse(readFileSync(casesFile, 'utf8')) as { about: string; folder: string; cases: ManifestCase[] };
const CASES = suite.cases;

describe("the manifest reader against the contract's manifest cases", () => {
  test(`every one of the ${CASES.length} cases the examples publish agrees with madarch's reader`, () => {
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
        // The refusal names the file it was found in: the case's own
        // workspace.yaml, whatever else the words say.
        const line = one.line ?? 1;
        const file = join(folder, 'workspace.yaml');
        const same = read.ok === false && read.file === file && read.line === line && read.message.includes(one.message ?? '');
        if (!same) {
          mismatches.push(`${one.name}: expected refused in ${file} at line ${line} naming ${JSON.stringify(one.message ?? '')}, got ${read.ok ? 'read as ok' : `${read.file}, line ${read.line}: ${read.message}`}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("the contract's set-made example product reads back with its identity, its pinned set and its repos", () => {
    const read = readProduct(SET_MADE);
    expect(read).toMatchObject({
      ok: true,
      product: {
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
    // The folder where the example stands: wherever this clone has it.
    if (read.ok) expect(read.product.folder).toBe(join(EXAMPLES, 'set-made-product'));
  });

  test('a folder written by hand reads the same way, its name falling back to the folder\'s', () => {
    const folder = join(tempFolder('madarch-manifest-hand-'), 'written-by-hand');
    mkdirSync(folder);
    // No name: the folder's own name is the product's, as a draft's is.
    writeFileSync(join(folder, 'workspace.yaml'), ['schemaVersion: 1', 'id: 3f6d2dc8-b16e-4bf0-9d3a-2c9c00b5287d', ''].join('\n'));
    const read = readProduct(folder);
    expect(read).toMatchObject({ ok: true, product: { id: '3f6d2dc8-b16e-4bf0-9d3a-2c9c00b5287d', name: 'written-by-hand', schemaVersion: 1, skills: {}, repos: [] } });
  });

  test("a refusal names the manifest file and its line, the words the walk's command prints", () => {
    // The words a person reads on standard error from `madarch list` (the
    // guide's line): the reader's own message, at the file and line it was
    // found on, not reformulated by the printer.
    const folder = join(tempFolder('madarch-manifest-word-'), 'broken');
    mkdirSync(folder);
    writeFileSync(join(folder, 'workspace.yaml'), ['schemaVersion: 1', 'id: 3f6d2dc8-b16e-4bf0-9d3a-2c9c00b5287d', 'name: 5', ''].join('\n'));
    const read = readProduct(folder);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(`${read.file}:${read.line}: ${read.message}`).toContain('not a name, which is a word');
    expect(read.file.endsWith('/broken/workspace.yaml')).toBe(true);
    expect(read.line).toBe(3);
  });
});

/** Reads the manifest back through a folder the helper builds itself, as readProduct reads it. */
function readProductRoundtrip(text: string): ReturnType<typeof readProduct> {
  const dir = mkdtempSync(join(tmpdir(), 'madarch-manifest-write-'));
  made.push(dir);
  mkdirSync(join(dir, 'written'), { recursive: true });
  writeFileSync(join(dir, 'written', 'workspace.yaml'), text);
  return readProduct(join(dir, 'written'));
}

describe("the manifest's written side (decision 0021: the lifecycle commands are madarch's code)", () => {
  test('yamlWord writes plain where the plain spelling reads back, quoted where it does not', () => {
    expect(yamlWord('gadgets')).toBe('gadgets');
    expect(yamlWord('idea-2026-10-09')).toBe('idea-2026-10-09');
    expect(yamlWord('Draft # part')).toBe(`'Draft # part'`);
    expect(yamlWord('42')).toBe("'42'");
    expect(yamlWord('True')).toBe("'True'");
    expect(yamlWord('NULL')).toBe("'NULL'");
    expect(yamlWord('a: b')).toBe(`'a: b'`);
    // A word whose edges are spaces is refused earlier (by the command's name and repository refusals); the writer never meets one.
  });

  test("manifestNamed replaces only the product’s own name field, every other byte kept", () => {
    const manifest = ['schemaVersion: 1', 'id: x', 'name: idea-2026-10-09', 'repos:', '  - name: api', '    url: https://example.invalid/api.git', ''].join('\n');
    const named = manifestNamed(manifest, 'gadgets');
    expect(named).toBe(['schemaVersion: 1', 'id: x', 'name: gadgets', 'repos:', '  - name: api', '    url: https://example.invalid/api.git', ''].join('\n'));
    // A name inside a repos item is another field's; the product's own value stands alone.
    expect(named).toContain('- name: api');
  });

  test("manifestNamed keeps a comment on the name line, and the key’s own spelling", () => {
    const manifest = 'schemaVersion: 1\nid: x\nname: idea-2026-10-09 # the draft\n';
    expect(manifestNamed(manifest, 'gadgets')).toBe('schemaVersion: 1\nid: x\nname: gadgets # the draft\n');
    const quoted = 'schemaVersion: 1\nid: x\n"name": idea\n';
    expect(manifestNamed(quoted, 'gadgets')).toBe('schemaVersion: 1\nid: x\n"name": gadgets\n');
  });

  test("manifestNamed appends the name field where the manifest names none, keeping the file ending", () => {
    expect(manifestNamed('schemaVersion: 1\nid: x\n', 'gadgets')).toBe('schemaVersion: 1\nid: x\nname: gadgets\n');
    expect(manifestNamed('schemaVersion: 1\nid: x', 'gadgets')).toBe('schemaVersion: 1\nid: x\nname: gadgets');
  });

  test("manifestWithRepo appends an item at the sequence end, keeping comments, blanks and the ending", () => {
    const manifest = 'schemaVersion: 1\n# a person note\nid: x\nname: y\nrepos:\n  - name: api\n    url: https://example.invalid/api.git\n\n# still the block\n';
    const withRepo = manifestWithRepo(manifest, { name: 'web', url: 'https://example.invalid/web.git' });
    const lines = withRepo.split('\n');
    expect(withRepo).toContain('    url: https://example.invalid/web.git');
    expect(withRepo).toContain('# a person note');
    expect(withRepo).toContain('# still the block');
    expect(lines[lines.length - 1]).toBe('');
  });

  test('a repos field written with a value on its own line is cleared, the comment kept, and the item written under it', () => {
    const manifest = 'schemaVersion: 1\nid: x\nrepos: # the code stands apart\n';
    const withRepo = manifestWithRepo(manifest, { name: 'api', url: 'https://example.invalid/api.git' });
    expect(withRepo.split('\n')).toEqual(['schemaVersion: 1', 'id: x', 'repos: # the code stands apart', '  - name: api', '    url: https://example.invalid/api.git', '']);
  });

  test("a manifest naming no repos gains the block at its end", () => {
    const withRepo = manifestWithRepo('schemaVersion: 1\nid: x\nname: gadgets\n', { name: 'api', url: 'https://example.invalid/api.git', branch: 'main' });
    expect(withRepo.split('\n')).toEqual(['schemaVersion: 1', 'id: x', 'name: gadgets', 'repos:', '  - name: api', '    url: https://example.invalid/api.git', '    branch: main', '']);
  });

  test("carriage returns a manifest line ends with are carried by every line the command writes", () => {
    const withRepo = manifestWithRepo('schemaVersion: 1\r\nid: x\r\nrepos:\r\n  - name: api\r\n    url: https://example.invalid/api.git\r\n', { name: 'web', url: 'u' });
    expect(withRepo.split('\n').every((line) => line === '' || line.endsWith('\r'))).toBe(true);
  });

  test('yamlText quotes only what the reader would read back as another value', () => {
    expect(yamlText('https://example.invalid/api.git')).toBe('https://example.invalid/api.git');
    expect(yamlText('.5')).toBe("'.5'");
    expect(yamlText('a: b')).toBe(`'a: b'`);
    expect(yamlText('true')).toBe("'true'");
    // A value one line cannot carry is double-quoted with the escapes the reader understands.
    expect(yamlText('two\nlines')).toBe('"two\\nlines"');
  });

  test("the reader gives back what manifestWithRepo wrote, quoted where it must be", () => {
    const manifest = 'schemaVersion: 1\nid: x\nname: gadgets\n';
    const withRepo = manifestWithRepo(manifest, { name: 'api', url: '.5' });
    expect(withRepo).toContain(`url: '.5'`);
    const read = readProductRoundtrip(withRepo);
    expect(read).toMatchObject({ ok: true, product: { repos: [{ name: 'api', url: '.5' }] } });
  });
});
