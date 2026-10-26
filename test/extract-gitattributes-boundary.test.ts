/**
 * Repository-declared generated and vendored files (mwhd.3, coordinator 08:05Z).
 * The attributes are read from `.gitattributes` and carried as `code.file`
 * properties; no consumer recognises a lock file or any other generated file by
 * its name, and a malformed line is a located gap, never a missing file.
 */
import {describe, expect, test} from 'bun:test';
import {extractFiles} from '../src/extract/driver/files.js';
import {gitAttributesFacts} from '../src/extract/driver/gitattributes.js';
import type {TreeReader} from '../src/extract/records.js';

function tree(files: Readonly<Record<string, string | Uint8Array>>): TreeReader {
  const paths = Object.keys(files).sort();
  return {paths, read(path: string): Uint8Array {
    const held = files[path];
    if (held === undefined) throw new Error(`${import.meta.path}:17: no such path ${path}`);
    return typeof held === 'string' ? new TextEncoder().encode(held) : held;
  }};
}

const marks = (files: Readonly<Record<string, string | Uint8Array>>): [string, string][] =>
  [...gitAttributesFacts(tree(files)).generated.entries()].sort();

describe('the attributes a repository declares', () => {
  test('a basename pattern marks a file at any depth and leaves other files unmarked', () => {
    expect(marks({
      '.gitattributes': '*.lock linguist-generated\n',
      'a/b.lock': 'x', 'c.lock': 'x', 'src/main.ts': 'x',
    })).toEqual([['a/b.lock', 'linguist-generated'], ['c.lock', 'linguist-generated']]);
  });

  test('a directory glob spans folders and a single positioning pattern does not', () => {
    expect(marks({
      '.gitattributes': '**/*.snap linguist-generated\ndocs/*.md linguist-vendored\n',
      'a/b/c.snap': 'x', 'one.snap': 'x', 'docs/readme.md': 'x', 'docs/deep/note.md': 'x',
    })).toEqual([['a/b/c.snap', 'linguist-generated'], ['docs/readme.md', 'linguist-vendored'], ['one.snap', 'linguist-generated']]);
  });

  test('a directory pattern marks no file inside it, as git defines it', () => {
    expect(marks({'.gitattributes': 'vendor/ linguist-vendored\n', 'vendor/lib.ts': 'x'})).toEqual([]);
  });

  test('the last matching line wins and an unset clears the mark', () => {
    expect(marks({
      '.gitattributes': '*.js linguist-generated\nkeep.js -linguist-generated\n\n*.gen linguist-generated\nother.gen linguist-generated=false\n',
      'a.js': 'x', 'keep.js': 'x', 'a.gen': 'x', 'other.gen': 'x',
    })).toEqual([['a.gen', 'linguist-generated'], ['a.js', 'linguist-generated']]);
  });

  test('a deeper attributes file overrides a shallower one and only inside its own folder', () => {
    expect(marks({
      '.gitattributes': '*.gen linguist-generated\n',
      'sub/.gitattributes': '*.gen -linguist-generated\n*.keep linguist-vendored\n',
      'sub/a.gen': 'x', 'sub/b.keep': 'x', 'a.gen': 'x',
    })).toEqual([['a.gen', 'linguist-generated'], ['sub/b.keep', 'linguist-vendored']]);
  });

  test('a quoted pattern, a character class and an escaped character name their own paths', () => {
    expect(marks({
      '.gitattributes': '"my file.txt" linguist-generated\nasset[0-9].js linguist-vendored\nstar\\*name.txt linguist-generated\n',
      'my file.txt': 'x', 'my.txt': 'x', 'asset1.js': 'x', 'assetA.js': 'x', 'star*name.txt': 'x',
    })).toEqual([['asset1.js', 'linguist-vendored'], ['my file.txt', 'linguist-generated'], ['star*name.txt', 'linguist-generated']]);
  });

  test('a malformed line is a located gap and the tree keeps every file', () => {
    const facts = gitAttributesFacts(tree({
      '.gitattributes': '# a comment\n\n*.a linguist-generated\n"unterminated linguist-generated\nonly-pattern\n*.b linguist-vendored\n',
      'x.a': 'x', 'y.b': 'x',
    }));
    expect([...facts.generated.entries()].sort()).toEqual([['x.a', 'linguist-generated'], ['y.b', 'linguist-vendored']]);
    expect(facts.gaps).toEqual([
      {path: '.gitattributes', line: 4, detail: 'the attributes line cannot be read'},
      {path: '.gitattributes', line: 5, detail: 'the attributes line names no attribute'},
    ]);
    const extraction = extractFiles(tree({'.gitattributes': '"unterminated\n', 'kept.ts': 'x'}));
    expect(extraction.nodes.map((node) => node.key)).toContain('code.file:kept.ts');
    expect(extraction.gaps).toEqual([{path: '.gitattributes', reason: 'line 1: the attributes line cannot be read'}]);
  });

  test('an attributes file that is not UTF-8 is a gap, not a silent tree', () => {
    const facts = gitAttributesFacts(tree({'.gitattributes': new Uint8Array([0xff, 0xfe, 0x2a]), 'kept.ts': 'x'}));
    expect([...facts.generated.entries()]).toEqual([]);
    expect(facts.gaps).toEqual([{path: '.gitattributes', line: 1, detail: 'the attributes file is not UTF-8 text'}]);
  });
});

describe('the file nodes carry what the repository declares', () => {
  test('a declared file keeps its key, digest and edges and gains the mark with its reason', () => {
    const source = tree({
      '.gitattributes': 'package-lock.json linguist-generated\nvendor/** linguist-vendored\n',
      'package-lock.json': '{"lockfileVersion":3}\n', 'src/a.ts': 'export const a = 1;\n', 'vendor/x/y.ts': 'y\n',
    });
    const withFacts = extractFiles(source);
    const without = extractFiles(tree({
      'package-lock.json': '{"lockfileVersion":3}\n', 'src/a.ts': 'export const a = 1;\n', 'vendor/x/y.ts': 'y\n',
    }));
    const byPath = (extraction: typeof withFacts) => new Map(extraction.nodes.map((node) => [node.key, node]));
    const marked = byPath(withFacts);
    const plain = byPath(without);
    for (const key of plain.keys()) {
      const node = marked.get(key)!;
      expect(node.properties['sha256']).toBe(plain.get(key)!.properties['sha256']);
      expect(node.span).toEqual(plain.get(key)!.span);
      expect(node.label).toBe(plain.get(key)!.label);
    }
    expect(marked.get('code.file:package-lock.json')!.properties).toMatchObject({generated: true, generatedBy: 'linguist-generated'});
    expect(marked.get('code.file:vendor/x/y.ts')!.properties).toMatchObject({generated: true, generatedBy: 'linguist-vendored'});
    expect(marked.get('code.file:src/a.ts')!.properties['generated']).toBeUndefined();
    expect(marked.get('code.file:.gitattributes')!.properties['generated']).toBeUndefined();
    expect(withFacts.gaps).toEqual([]);
    expect(withFacts.producer).toBe(without.producer);
  });

  test('a repository with no attributes yields the same nodes and no gap', () => {
    const files = {'src/a.ts': 'a\n', 'deep/b/c.ts': 'c\n'};
    const before = extractFiles(tree(files));
    const after = extractFiles(tree({...files, '.gitattributes': '# nothing declared\n'}));
    const strip = (extraction: typeof before) => extraction.nodes.filter((node) => node.key !== 'code.file:.gitattributes');
    expect(strip(after)).toEqual(strip(before));
    expect(after.gaps).toEqual([]);
  });
});
