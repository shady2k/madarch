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

  test('a plain name holding an apostrophe reads as YAML reads it: the comment is no part of the name', () => {
    // The reader reads the value the YAML parser reads: an apostrophe after a
    // plain character began is the value's own, and a `#` after whitespace
    // starts the comment the walk's commands print beside it.
    const folder = join(tempFolder('madarch-manifest-apos-'), 'written-by-hand');
    mkdirSync(folder);
    writeFileSync(join(folder, 'workspace.yaml'), "schemaVersion: 1\nid: 3f6d2dc8-b16e-4bf0-9d3a-2c9c00b5287d\nname: O'Reilly # owner\n");
    const read = readProduct(folder);
    expect(read).toMatchObject({ ok: true, product: { name: "O'Reilly" } });
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
    // An apostrophe inside a plain name is the name's own character, not a
    // quoted reading's start: the comment stands where the person wrote it.
    const plain = 'schemaVersion: 1\nid: x\nname: O\u0027Reilly # owner\n';
    expect(manifestNamed(plain, 'gadgets')).toBe('schemaVersion: 1\nid: x\nname: gadgets # owner\n');
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

  test('a quoted or gap-spaced repos field is cleared, its key spelling and comment kept', () => {
    // The key's spelling and the gap stand; the value that stood between the
    // colon and the comment goes, and the items are written under it.
    expect(manifestWithRepo(`schemaVersion: 1\nid: x\n'repos':  # the code\n`, { name: 'api', url: 'u' }))
      .toBe(`schemaVersion: 1\nid: x\n'repos':  # the code\n  - name: api\n    url: u\n`);
    expect(manifestWithRepo(`schemaVersion: 1\nid: x\nrepos:   ~  # pinned later\n`, { name: 'api', url: 'u' }))
      .toBe(`schemaVersion: 1\nid: x\nrepos: # pinned later\n  - name: api\n    url: u\n`);
    const read = readProductRoundtrip(manifestWithRepo(`schemaVersion: 1\nid: x\nrepos: # c\n`, { name: 'api', url: 'u' }));
    expect(read).toMatchObject({ ok: true, product: { repos: [{ name: 'api' }] } });
  });
});

describe('the manifest subset mechanics (decision 0021: the reader is madarch own)', () => {
  /** Reads one manifest's text; a refusal is shown whole, at its file and line. */
  const mech = (text: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'madarch-manifest-mech-'));
    made.push(dir);
    mkdirSync(join(dir, 'mech'));
    writeFileSync(join(dir, 'mech', 'workspace.yaml'), text);
    const read = readProduct(join(dir, 'mech'));
    if (read.ok) return { refused: false as const };
    return { refused: true as const, line: read.line, message: read.message };
  };
  const wantRefused = (text: string, line: number, words: string) => {
    const got = mech(text);
    if (!got.refused) throw new Error(`expected a refusal, got ok`);
    expect(got.line).toBe(line);
    expect(got.message).toContain(words);
  };

  test('cutComment keeps a # inside quotes and cuts one standing in the open', () => {
    expect(cutComment(`'a # b'`)).toBe(`'a # b'`);
    expect(cutComment(`"a' # b"`)).toBe(`"a' # b"`);
    expect(cutComment('v # tail')).toBe('v ');
    // An apostrophe after a plain character has begun is the character it is,
    // never a quoted reading's start: the comment after it is cut.
    expect(cutComment(`O'Reilly # owner`)).toBe(`O'Reilly `);
    expect(cutComment(`it "is" fine # tail`)).toBe('it "is" fine ');
    expect(cutComment('v#tail')).toBe('v#tail');
    expect(cutComment(`"a # x" t # y`)).toBe(`"a # x" t `);
  });

  test('quoted values read back whole, escapes included, and refuse closed incompletely or continued', () => {
    expect(mech('schemaVersion: 1\nid: x\nname: "a\\nb"\n')).toEqual({ refused: false });
    expect(mech(`schemaVersion: 1\nid: x\nname: 'a''b'\n`)).toEqual({ refused: false });
    expect(mech(`schemaVersion: 1\nid: x\nname: "\\u0041bc"\n`)).toEqual({ refused: false });
    wantRefused(`schemaVersion: 1\nid: x\nname: "a\\X9"\n`, 3, 'only the usual escapes are written');
    wantRefused(`schemaVersion: 1\nid: x\nname: "a\\u00zz"\n`, 3, 'not \\uXXXX');
    wantRefused(`schemaVersion: 1\nid: x\nname: "abc" uvw\n`, 3, 'after the quoted value');
    wantRefused(`schemaVersion: 1\nid: x\nname: "abc\n`, 3, 'never closes it');
    const good = readProductRoundtrip('schemaVersion: 1\nid: x\nname: "a\\nb"\n');
    expect(good).toMatchObject({ ok: true, product: { name: 'a\nb' } });
  });

  test('a quoted key names the field, an anchor, a tag or a flow collection in its place is refused', () => {
    expect(mech(`schemaVersion: 1\nid: x\n"name": gadgets\n`)).toEqual({ refused: false });
    wantRefused(`schemaVersion: 1\nid: x\n&anchor: gadgets\n`, 3, 'anchor');
    wantRefused(`schemaVersion: 1\nid: x\n!tag: gadgets\n`, 3, 'tag');
    wantRefused(`schemaVersion: 1\nid: x\n{a: b}\n`, 3, 'flow collection');
    // A quoted key with no word inside is refused too.
    wantRefused(`schemaVersion: 1\nid: x\n"": gadgets\n`, 3, 'named by a word');
  });

  test('a line standing alone is refused, a second document and a tab indent are refused', () => {
    wantRefused('schemaVersion: 1\nid: x\nname: v\n---\nid: y\n', 4, 'one document');
    wantRefused('schemaVersion: 1\n\tid: x\n', 2, 'indents with a tab');
    wantRefused('schemaVersion: 1\nid: x\nname: v\n  id: y\n', 4, 'a field holds one value');
    wantRefused('schemaVersion: 1\nid: x\n: v\n', 3, 'with no name');
  });

  test('item shapes: a bare dash opens an item, a field twice in an item is refused at its line', () => {
    expect(mech('schemaVersion: 1\nid: x\nrepos:\n  -\n    name: api\n    url: /u\n')).toEqual({ refused: false });
    wantRefused('schemaVersion: 1\nid: x\nrepos:\n  - name: api\n    name: api\n    url: /u\n', 5, '"name" twice, again on line 5');
  });

  test('the dash and its spacing, and a comment on the dash line', () => {
    expect(mech('schemaVersion: 1\nid: x\nrepos:\n  -   name: api\n      url: /u\n')).toEqual({ refused: false });
    expect(mech('schemaVersion: 1\nid: x\nrepos:\n  - # repository\n    name: api\n    url: /u\n')).toEqual({ refused: false });
    wantRefused('schemaVersion: 1\nid: x\nrepos:\n  -   name: api\n      url: /u\n      url: /v\n', 6, '"url" twice, again on line 6');
  });

  test('a complex mapping key, a block scalar literal and a block scalar folded are refused', () => {
    wantRefused('schemaVersion: 1\nid: x\n? name: sample\n', 3, 'complex mapping key');
    wantRefused('schemaVersion: 1\nid: x\n? &k name: sample\n', 3, 'complex mapping key');
    wantRefused('schemaVersion: 1\nid: x\n? !!str name: sample\n', 3, 'complex mapping key');
    wantRefused('schemaVersion: 1\nid: x\nname: |\n', 3, 'block scalar literal');
    wantRefused('schemaVersion: 1\nid: x\nname: >\n', 3, 'block scalar folded');
  });
});
