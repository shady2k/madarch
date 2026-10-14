import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { openProductWiki } from '../src/product-wiki/pages.js';
import { readRegistryServing } from '../src/product-wiki/registry.js';
import { readProductRegistry } from '../src/product/registry.js';

/**
 * A product's pages read from the working tree (docs/changes/draft-product/
 * capabilities/product-wiki.md, requirements `pages`, `live` and `result`):
 * every Markdown file under `docs/` and `README.md` at the root, in code point
 * order of their paths, each with a title, read fresh on every call, with a
 * revision digesting the pages' paths and contents. Nothing else in the
 * product is read, and serving changes nothing.
 */

let folder: string | undefined;
const backtick: string = String.fromCharCode(96);

function draft(): string {
  folder = mkdtempSync(join(tmpdir(), 'madarch-wiki-pages-'));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: demo\nname: Demo\n');
  return folder;
}

function write(path: string, content: string): void {
  const full = join(folder!, path);
  const dir = full.slice(0, full.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(full, content);
}

function writeBytes(path: string, bytes: Buffer): void {
  const full = join(folder!, path);
  const dir = full.slice(0, full.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(full, bytes);
}

function requireProduct(wiki: ReturnType<typeof openProductWiki>): import('../src/product-wiki/pages.js').ProductWiki {
  if (!wiki.ok) throw new Error(wiki.message);
  return wiki.wiki;
}

afterEach(() => {
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

describe('the pages a product holds', () => {
  test('a draft with no docs and no README holds no pages', () => {
    const product = requireProduct(openProductWiki(draft()));
    const pages = product.pages();
    if (!pages.ok) throw new Error(pages.message);
    expect(pages.pages).toEqual([]);
  });

  test('README.md at the root and every Markdown under docs, in code point order, each with an address', () => {
    draft();
    write('docs/vision.md', '# Vision\n\nWhat it is for.\n');
    write('docs/a-notes.md', 'no heading here\n');
    write('docs/deep/z.md', 'nothing to name\n');
    write('README.md', '# Demo\n\nThe readme.\n');
    write('docs/drawing.svg', '<svg/>');
    write('docs/notes.txt', 'not a page');
    write('skills/own.md', '# not a page');
    write('.beads/issues.jsonl', '{}\n');
    const product = requireProduct(openProductWiki(folder!));
    const pages = product.pages();
    if (!pages.ok) throw new Error(pages.message);
    expect(pages.pages.map((page) => page.path)).toEqual([
      'README.md',
      'docs/a-notes.md',
      'docs/deep/z.md',
      'docs/vision.md',
    ]);
    expect(pages.pages.map((page) => page.address)).toEqual([
      '/p/README.md',
      '/p/docs/a-notes.md',
      '/p/docs/deep/z.md',
      '/p/docs/vision.md',
    ]);
    expect(pages.pages.map((page) => page.title)).toEqual(['Demo', 'a-notes', 'z', 'Vision']);
  });

  test('a title inside a code fence is not the heading', () => {
    draft();
    write('docs/vision.md', `${backtick}${backtick}${backtick}\n# not a heading\n${backtick}${backtick}${backtick}\n\n# Real.\n`);
    const product = requireProduct(openProductWiki(folder!));
    const pages = product.pages();
    if (!pages.ok) throw new Error(pages.message);
    const page = pages.pages.find((each) => each.path === 'docs/vision.md');
    if (page === undefined) throw new Error('the page is not listed');
    expect(page.title).toBe('Real.');
  });

  test('an unchanged wiki gives the same revision; a changed file gives a new one', () => {
    draft();
    write('docs/vision.md', '# Vision\none\n');
    const product = requireProduct(openProductWiki(folder!));
    const first = product.pages();
    if (!first.ok) throw new Error(first.message);
    const second = product.pages();
    if (!second.ok) throw new Error(second.message);
    expect(second.revision).toBe(first.revision);
    expect(first.revision).not.toBe('');
    write('docs/vision.md', '# Vision\ntwo\n');
    const third = product.pages();
    if (!third.ok) throw new Error(third.message);
    expect(third.revision).not.toBe(first.revision);
  });

  test('a page is read fresh from disk, byte for byte', () => {
    draft();
    write('docs/vision.md', '# Vision\n\none\n');
    const product = requireProduct(openProductWiki(folder!));
    const first = product.page('docs/vision.md');
    if (!first.ok) throw new Error(first.message);
    expect(first.page.markdown).toBe('# Vision\n\none\n');
    expect(Number.isFinite(Date.parse(first.page.changedAt ?? ''))).toBe(true);
    write('docs/vision.md', '# Vision\n\ntwo\n');
    const second = product.page('docs/vision.md');
    if (!second.ok) throw new Error(second.message);
    expect(second.page.markdown).toBe('# Vision\n\ntwo\n');
  });

  test('a page missing from the wiki, and a path that climbs out, are refused naming the path', () => {
    draft();
    write('docs/vision.md', '# Vision\n');
    const product = requireProduct(openProductWiki(folder!));
    const missing = product.page('docs/other.md');
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.message).toContain('docs/other.md');
    }
    const climbing = product.page('../AGENTS.md');
    expect(climbing.ok).toBe(false);
    if (!climbing.ok) expect(climbing.message).toContain('../AGENTS.md');
    const outside = product.page('README.txt');
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.message).toContain('README.txt');
    const rooted = product.page('/');
    expect(rooted.ok).toBe(false);
    if (!rooted.ok) expect(rooted.message).toContain('/');
  });

  test('a product whose manifest cannot be read is refused', () => {
    const bad = mkdtempSync(join(tmpdir(), 'madarch-wiki-pages-'));
    try {
      const refused = openProductWiki(bad);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.message).toContain('workspace.yaml');
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }
  });

  test('the pages are named by code point order of their paths, not the locale', () => {
    draft();
    write('docs/vision.md', '# X\n');
    write('docs/B.md', '# B\n');
    write('docs/_a.md', '# a\n');
    const product = requireProduct(openProductWiki(folder!));
    const pages = product.pages();
    if (!pages.ok) throw new Error(pages.message);
    expect(pages.pages.map((page) => page.path)).toEqual(['docs/B.md', 'docs/_a.md', 'docs/vision.md']);
  });

  test('a symlink at the root or under docs that leaves the product is refused, naming both paths', () => {
    draft();
    write('docs/vision.md', '# Vision\n');
    write('.beads/issues.jsonl', '{"secret":true}\n');
    symlinkSync(join(folder!, '.beads', 'issues.jsonl'), join(folder!, 'README.md'));
    const product = requireProduct(openProductWiki(folder!));
    const pages = product.pages();
    expect(pages.ok).toBe(false);
    if (!pages.ok) {
      expect(pages.message).toContain('README.md');
      expect(pages.message).toContain(join(folder!, '.beads', 'issues.jsonl'));
    }
    rmSync(join(folder!, 'README.md'));
    const outside = mkdtempSync(join(tmpdir(), 'madarch-wiki-outside-'));
    try {
      writeFileSync(join(outside, 'leaked.md'), '# leaked\n');
      symlinkSync(join(outside, 'leaked.md'), join(folder!, 'docs', 'leaked.md'));
      const refused = product.pages();
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.message).toContain('docs/leaked.md');
        expect(refused.message).toContain(join(outside, 'leaked.md'));
      }
      let refusedPage: unknown;
      try {
        refusedPage = product.page('docs/leaked.md');
      } catch (error) {
        refusedPage = { ok: false, message: (error as Error).message };
      }
      expect((refusedPage as { ok: boolean }).ok).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('a symlink that stays inside the product is followed', () => {
    draft();
    write('docs/real.md', '# Real\n');
    symlinkSync('real.md', join(folder!, 'docs', 'alias.md'));
    const product = requireProduct(openProductWiki(folder!));
    const pages = product.pages();
    if (!pages.ok) throw new Error(pages.message);
    expect(pages.pages.map((page) => page.path)).toContain('docs/alias.md');
  });

  test('a failed read is a refusal, never a smaller wiki', () => {
    draft();
    write('docs/vision.md', '# Vision\n');
    write('docs/private/hidden.md', '# hidden\n');
    const privateDir = join(folder!, 'docs', 'private');
    const docsDir = join(folder!, 'docs');
    try {
      chmodSync(privateDir, 0o000);
      const product = requireProduct(openProductWiki(folder!));
      const pages = product.pages();
      expect(pages.ok).toBe(false);
      if (!pages.ok) expect(pages.message).toContain(privateDir);
      // An unreadable docs/ itself is refused too, not an empty wiki.
      chmodSync(privateDir, 0o755);
      chmodSync(docsDir, 0o000);
      const refused = product.pages();
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.message).toContain(docsDir);
    } finally {
      chmodSync(docsDir, 0o755);
    }
  });

  test('titles follow the Markdown heading rules: fences, indented, closing hashes, no-space', () => {
    draft();
    write('docs/fenced.md', `~~~\n# not a heading\n~~~\n\n# Real one.\n`);
    write('docs/nospace.md', '#Title line\n\n## Real heading\n');
    write('docs/indented.md', '    # not a heading (code)\n\n# Indented ok\n');
    write('docs/closing.md', '# Closed # \n');
    const product = requireProduct(openProductWiki(folder!));
    const pages = product.pages();
    if (!pages.ok) throw new Error(pages.message);
    const title = (path: string): string => pages.pages.find((page) => page.path === path)!.title;
    expect(title('docs/fenced.md')).toBe('Real one.');
    expect(title('docs/nospace.md')).toBe('nospace');
    expect(title('docs/indented.md')).toBe('Indented ok');
    expect(title('docs/closing.md')).toBe('Closed');
  });

  test('addresses are round-trip: encoded out, decoded in', () => {
    draft();
    write('docs/a b.md', '# Spaced\n');
    write('docs/c#sharp.md', '# Hash\n');
    write('docs/vision.md', '# Vision\n');
    const product = requireProduct(openProductWiki(folder!));
    const pages = product.pages();
    if (!pages.ok) throw new Error(pages.message);
    const byPath = new Map(pages.pages.map((page) => [page.path, page]));
    expect(byPath.get('docs/a b.md')!.address).toBe('/p/docs/a%20b.md');
    expect(byPath.get('docs/c#sharp.md')!.address).toBe('/p/docs/c%23sharp.md');
    expect(byPath.get('docs/vision.md')!.address).toBe('/p/docs/vision.md');
    // An address written into a document names the page it advertises.
    const written = product.page('/p/docs/vision.md');
    if (!written.ok) throw new Error(written.message);
    expect(written.page.path).toBe('docs/vision.md');
    const escaped = product.page('/p/docs/a%20b.md');
    if (!escaped.ok) throw new Error(escaped.message);
    expect(escaped.page.path).toBe('docs/a b.md');
  });

  test('a FIFO named .md is refused naming its path, never opened', () => {
    draft();
    write('docs/vision.md', '# Vision\n');
    const made = spawnSync('mkfifo', [join(folder!, 'docs', 'pipe.md')]);
    expect(made.status).toBe(0); // the fixture exists: the assertion below is about the walk, not mkfifo
    const product = requireProduct(openProductWiki(folder!));
    const pages = product.pages();
    expect(pages.ok).toBe(false);
    if (!pages.ok) expect(pages.message).toContain('docs/pipe.md');
  });

  test('a single-page ask keeps the walk\'s failure instead of throwing it away', () => {
    draft();
    write('docs/vision.md', '# Vision\n');
    mkdirSync(join(folder!, 'docs', 'private'), { recursive: true });
    const privateDir = join(folder!, 'docs', 'private');
    chmodSync(privateDir, 0o000);
    try {
      const product = requireProduct(openProductWiki(folder!));
      const asked = product.page('docs/vision.md');
      expect(asked.ok).toBe(false);
      if (!asked.ok) expect(asked.message).toContain(privateDir);
    } finally {
      chmodSync(privateDir, 0o755);
    }
  });

  test('asking reads the product without changing it', () => {
    draft();
    write('docs/vision.md', '# Vision\n');
    const before = readFileSync(join(folder!, 'docs', 'vision.md'), 'utf8');
    const product = requireProduct(openProductWiki(folder!));
    product.pages();
    product.page('docs/vision.md');
    expect(readFileSync(join(folder!, 'docs', 'vision.md'), 'utf8')).toBe(before);
  });
});

describe('the kinds registry the wiki serves', () => {
  function withRegistry(text: string): string {
    draft();
    write('docs/kinds.yaml', text);
    write('docs/decisions/D-001.md', '# D-001 — One decision\n\nrecorded here\n');
    return folder!;
  }

  function pageKinds(pages: { ok: boolean; pages?: { kind?: string }[] }): string[] {
    return pages.pages?.map((page) => page.kind ?? '') ?? [];
  }

  test('a registry at a version the wiki does not know names the version and serves plain pages', () => {
    const product = requireProduct(openProductWiki(withRegistry('contract: 99\nstages:\n  - id: idea\nkinds:\n  - name: decision\n    prefix: D\n    folder: docs/decisions\n    stage: idea\n    hint: one\n')));
    const pages = product.pages();
    if (!pages.ok) throw new Error(pages.message);
    expect(pages.contract).toEqual({ known: false, version: 99, message: 'docs/kinds.yaml:1: contract: the registry declares contract 99; this madarch reads contract 1 — the wiki serves these pages as plain documents' });
    expect(pageKinds(pages)).toEqual(['']);

    const asked = product.page('docs/decisions/D-001.md');
    if (!asked.ok) throw new Error(asked.message);
    expect(asked.page.document).toBeUndefined();
    expect(asked.page.markdown).toContain('recorded here');
  });

  test('a registry the wiki cannot read degrades with the reading refusal as the banner', () => {
    const product = requireProduct(openProductWiki(withRegistry('contract: 1\nstages:\n  - id: idea\nkinds:\n  - name: decision\n    prefix: d\n    folder: docs/decisions\n    stage: idea\n    hint: one\n')));
    const pages = product.pages();
    if (!pages.ok) throw new Error(pages.message);
    const banner = pages.contract;
    if (banner === undefined || banner.known !== false) throw new Error('the registry refused its reading, so the wiki degrades');
    expect(banner.message).toContain('docs/kinds.yaml:6: kinds[0].prefix: "d" is not an id prefix');
    expect(banner.message).toContain('the wiki serves these pages as plain documents');
    expect(banner.version).toBeUndefined();
  });

  test('a registry at contract 1 the wiki serves reads as before, and no registry means no banner', () => {
    const product = requireProduct(openProductWiki(withRegistry('contract: 1\nstages:\n  - id: idea\nkinds:\n  - name: decision\n    prefix: D\n    folder: docs/decisions\n    stage: idea\n    hint: one\n')));
    const pages = product.pages();
    if (!pages.ok) throw new Error(pages.message);
    expect(pages.contract).toEqual({ known: true, version: 1 });
    expect(pageKinds(pages)).toEqual(['decision']);

    const bare = requireProduct(openProductWiki(draft()));
    const fresh = bare.pages();
    if (!fresh.ok) throw new Error(fresh.message);
    expect(fresh.contract).toBeUndefined();
  });

  test('an edit to the registry is a change the wiki revises on its own ask', () => {
    const unused = withRegistry('contract: 99\nstages:\n  - id: idea\nkinds:\n  - name: decision\n    prefix: D\n    folder: docs/decisions\n    stage: idea\n    hint: one\n');
    const product = requireProduct(openProductWiki(unused));
    const before = product.pages();
    if (!before.ok) throw new Error(before.message);
    const revisionBefore = before.revision;
    if (before.contract === undefined || before.contract.known !== false) throw new Error('the unknown contract degrades');
    write('docs/kinds.yaml', 'contract: 1\nstages:\n  - id: idea\nkinds:\n  - name: decision\n    prefix: D\n    folder: docs/decisions\n    stage: idea\n    hint: one\n');
    const after = product.pages();
    if (!after.ok) throw new Error(after.message);
    expect(after.revision).not.toBe(revisionBefore);
    expect(after.contract).toEqual({ known: true, version: 1 });
    expect(pageKinds(after)).toEqual(['decision']);
  });

  test('the revision digests the registry\'s bytes, not the decoded text: two byte-distinct files the decoder flattens to the same text are two revisions', () => {
    const unused = withRegistry('contract: 1\nstages:\n  - id: idea\nkinds:\n  - name: decision\n    prefix: D\n    folder: docs/decisions\n    stage: idea\n    hint: one\n');
    const file = join(folder!, 'docs', 'kinds.yaml');
    const product = requireProduct(openProductWiki(folder!));
    const before = product.pages();
    if (!before.ok) throw new Error(before.message);
    expect(before.contract).toEqual({ known: true, version: 1 });
    // A stray continuation byte (0xA0) and another one (0xBE) decode to the
    // same replacement character, so a revision over the decoded text would
    // see no change; the bytes themselves must move it. The byte rides
    // inside the last scalar (before the final newline), so the file still
    // reads whole as YAML - the answer must not depend on a broken file.
    const raw = readFileSync(file);
    const spine = raw.subarray(0, raw.length - 1);
    writeBytes('docs/kinds.yaml', Buffer.concat([spine, Buffer.from([0xA0, 10])]));
    const strayOne = product.pages();
    if (!strayOne.ok) throw new Error(strayOne.message);
    expect(strayOne.contract).toEqual({ known: true, version: 1 });
    writeBytes('docs/kinds.yaml', Buffer.concat([spine, Buffer.from([0xBE])]));
    const strayTwo = product.pages();
    if (!strayTwo.ok) throw new Error(strayTwo.message);
    expect(strayTwo.revision).not.toBe(strayOne.revision);
    expect(strayTwo.contract).toEqual({ known: true, version: 1 });
  });

  test('a registry the file system refuses to stat is the named unknown state, not the absent state', () => {
    withRegistry('contract: 1\nstages:\n  - id: idea\nkinds:\n  - name: decision\n    prefix: D\n    folder: docs/decisions\n    stage: idea\n    hint: one\n');
    chmodSync(join(folder!, 'docs'), 0o000);
    try {
      const serving = readRegistryServing(folder!);
      expect(serving.contract.state).toBe('unknown');
      if (serving.contract.state !== 'unknown') return;
      expect(serving.contract.message).toContain('docs/kinds.yaml could not be read');
      expect(serving.contract.message).toContain('plain documents');
      expect(serving.contract.version).toBeUndefined();
    } finally {
      chmodSync(join(folder!, 'docs'), 0o755);
    }
  });

  test('each state of the registry carries its own digest, so a change of state is never lost under a shared one', () => {
    withRegistry('contract: 1\nstages:\n  - id: idea\nkinds:\n  - name: decision\n    prefix: D\n    folder: docs/decisions\n    stage: idea\n    hint: one\n');
    const file = join(folder!, 'docs', 'kinds.yaml');
    const known = readRegistryServing(folder!).digest;
    rmSync(file);
    const absent = readRegistryServing(folder!).digest;
    mkdirSync(file);
    const served = readRegistryServing(folder!);
    expect(served.contract).toMatchObject({ state: 'unknown' });
    if (served.contract.state !== 'unknown') throw new Error('the folder degrades');
    expect(served.contract.message).toContain('docs/kinds.yaml is a folder, not a registry file');
    expect(served.contract.message).toContain('plain documents');
    const folderState = served.digest;
    rmSync(file, { recursive: true });
    chmodSync(join(folder!, 'docs'), 0o000);
    let unreadable: string;
    try {
      unreadable = readRegistryServing(folder!).digest;
    } finally {
      chmodSync(join(folder!, 'docs'), 0o755);
    }
    const taken = new Set([known, absent, folderState, unreadable]);
    expect(taken.size).toBe(4);
  });

  test('the refusal banner names each refusal with its file, line, path and words', () => {
    const product = requireProduct(openProductWiki(withRegistry('contract: 1\nstages:\n  - id: idea\nkinds:\n  - name: decision\n    prefix: d\n    folder: docs/decisions\n    stage: idea\n    hint: one\n  - name: source\n    prefix: s\n    folder: docs/sources\n    stage: idea\n    hint: one\n')));
    const pages = product.pages();
    if (!pages.ok) throw new Error(pages.message);
    const banner = pages.contract;
    if (banner === undefined || banner.known !== false) throw new Error('the registry refused its reading, so the wiki degrades');
    expect(banner.message).toBe('docs/kinds.yaml:6: kinds[0].prefix: "d" is not an id prefix: one to four capitals (A-Z); docs/kinds.yaml:11: kinds[1].prefix: "s" is not an id prefix: one to four capitals (A-Z) — the wiki serves these pages as plain documents');
  });

  test('a whole-file refusal names the file and line with no path between', () => {
    const product = requireProduct(openProductWiki(withRegistry('contract: 1\nstages:\n\t- id: idea\nkinds: []\n')));
    const pages = product.pages();
    if (!pages.ok) throw new Error(pages.message);
    const banner = pages.contract;
    if (banner === undefined || banner.known !== false) throw new Error('the registry refused its reading, so the wiki degrades');
    expect(banner.message).toContain('docs/kinds.yaml:3: Tabs are not allowed as indentation');
    expect(banner.message).not.toContain(': :');
    expect(banner.message).toContain('the wiki serves these pages as plain documents');
  });

  test('a registry whose bytes refuse to be read is the named unknown state, never a throw of the ask', () => {
    withRegistry('contract: 1\nstages:\n  - id: idea\nkinds:\n  - name: decision\n    prefix: D\n    folder: docs/decisions\n    stage: idea\n    hint: one\n');
    const file = join(folder!, 'docs', 'kinds.yaml');
    chmodSync(file, 0o000);
    try {
      const serving = readRegistryServing(folder!);
      expect(serving.contract.state).toBe('unknown');
      if (serving.contract.state !== 'unknown') return;
      expect(serving.contract.message).toContain('docs/kinds.yaml could not be read');
      expect(serving.contract.message).toContain('plain documents');
    } finally {
      chmodSync(file, 0o644);
    }
  });

  test('a registry the wiki cannot serve degrades the open questions the way it degrades the pages', () => {
    const product = requireProduct(openProductWiki(withRegistry('contract: 99\nstages:\n  - id: idea\nkinds:\n  - name: decision\n    prefix: D\n    folder: docs/decisions\n    stage: idea\n    hint: one\n')));
    write('docs/decisions/D-001.md', '# D-001 — One decision\n\nrecorded here\n');
    write('docs/decisions/Q-009-late.md', '\n# Q-009 — Serving late?\n\n## Question\nA question the degradation must not answer.\n\n## Answer\n');
    const asked = product.questions();
    if (!asked.ok) throw new Error(asked.message);
    expect(asked.questions).toEqual([]);
    expect(asked.openCount).toBe(0);
  });

  test('a registry symlink outside the product is refused by the serving reader', () => {
    const productFolder = withRegistry('contract: 1\nstages:\n  - id: idea\nkinds:\n  - name: decision\n    prefix: D\n    folder: docs/decisions\n    stage: idea\n    hint: one\n');
    const outside = mkdtempSync(join(tmpdir(), 'madarch-registry-outside-'));
    try {
      const externalRegistry = join(outside, 'kinds.yaml');
      writeFileSync(externalRegistry, 'contract: 1\nstages:\n  - id: idea\nkinds:\n  - name: external\n    prefix: X\n    folder: docs/external\n    stage: idea\n    hint: outside\n');
      const registryFile = join(productFolder, 'docs', 'kinds.yaml');
      rmSync(registryFile);
      symlinkSync(externalRegistry, registryFile);

      const serving = readRegistryServing(productFolder);
      expect(serving.contract.state).toBe('unknown');
      if (serving.contract.state !== 'unknown') return;
      expect(serving.contract.message).toContain('symlink the product does not hold');
      expect(serving.contract.message).toContain(externalRegistry);

      const pages = requireProduct(openProductWiki(productFolder)).pages();
      if (!pages.ok) throw new Error(pages.message);
      if (pages.contract === undefined || pages.contract.known !== false) throw new Error('the external registry link must degrade');
      expect(pages.contract.message).toContain('symlink the product does not hold');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('retargeting an outside registry symlink changes the wiki revision', () => {
    const productFolder = withRegistry('');
    const outside = mkdtempSync(join(tmpdir(), 'madarch-registry-targets-'));
    const targetA = join(outside, 'a.yaml');
    const targetB = join(outside, 'b.yaml');
    writeFileSync(targetA, 'contract: 1\nstages: []\nkinds: []\n');
    writeFileSync(targetB, 'contract: 1\nstages: []\nkinds: []\n');
    const registryFile = join(productFolder, 'docs', 'kinds.yaml');
    rmSync(registryFile);
    symlinkSync(targetA, registryFile);
    try {
      const product = requireProduct(openProductWiki(productFolder));
      const first = product.pages();
      if (!first.ok) throw new Error(first.message);
      rmSync(registryFile);
      symlinkSync(targetB, registryFile);
      const second = product.pages();
      if (!second.ok) throw new Error(second.message);
      expect(second.revision).not.toBe(first.revision);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('retargeting an outside registry symlink between directories changes the wiki revision', () => {
    const productFolder = withRegistry('');
    const outside = mkdtempSync(join(tmpdir(), 'madarch-registry-directories-'));
    const targetA = join(outside, 'a');
    const targetB = join(outside, 'b');
    mkdirSync(targetA);
    mkdirSync(targetB);
    const registryFile = join(productFolder, 'docs', 'kinds.yaml');
    rmSync(registryFile);
    symlinkSync(targetA, registryFile);
    try {
      const product = requireProduct(openProductWiki(productFolder));
      const first = product.pages();
      if (!first.ok) throw new Error(first.message);
      rmSync(registryFile);
      symlinkSync(targetB, registryFile);
      const second = product.pages();
      if (!second.ok) throw new Error(second.message);
      expect(second.revision).not.toBe(first.revision);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('the product registry reader refuses a FIFO without blocking', () => {
    const productFolder = withRegistry('');
    rmSync(join(productFolder, 'docs', 'kinds.yaml'));
    const made = spawnSync('mkfifo', [join(productFolder, 'docs', 'kinds.yaml')]);
    expect(made.status).toBe(0);
    const registry = readProductRegistry(productFolder);
    expect(registry.present).toBe(true);
    if (registry.present && 'refused' in registry) {
      expect(registry.refused[0]?.message).toContain('not a regular file');
    } else {
      throw new Error('FIFO must be refused');
    }
  });

  test('a dangling registry symlink is named as unknown, not treated as absent', () => {
    const productFolder = withRegistry('');
    const registryFile = join(productFolder, 'docs', 'kinds.yaml');
    const absentDigest = readRegistryServing(productFolder).digest;
    rmSync(registryFile);
    symlinkSync(join(productFolder, 'docs', 'missing.yaml'), registryFile);

    const serving = readRegistryServing(productFolder);
    expect(serving.contract.state).toBe('unknown');
    if (serving.contract.state !== 'unknown') return;
    expect(serving.contract.message).toContain('could not be resolved');
    expect(serving.contract.message).toContain('plain documents');
    expect(serving.digest).not.toBe(absentDigest);

    const pages = requireProduct(openProductWiki(productFolder)).pages();
    if (!pages.ok) throw new Error(pages.message);
    if (pages.contract === undefined || pages.contract.known !== false) throw new Error('the dangling registry link must degrade');
    expect(pages.contract.message).toContain('could not be resolved');
  });

  test('a registry that is not a regular file is named and degrades the wiki, and the ask never blocks on it', () => {
    const unused = withRegistry('');
    rmSync(join(folder!, 'docs', 'kinds.yaml'));
    const made = spawnSync('mkfifo', [join(folder!, 'docs', 'kinds.yaml')]);
    if (made.status !== 0) throw new Error(`mkfifo is not available here: ${made.stderr?.toString() ?? made.status}`);
    const product = requireProduct(openProductWiki(folder!));
    const pages = product.pages();
    if (!pages.ok) throw new Error(pages.message);
    if (pages.contract === undefined || pages.contract.known !== false) throw new Error('the irregular file degrades');
    expect(pages.contract.message).toContain('docs/kinds.yaml is not a regular file');
    expect(pages.contract.message).toContain('the wiki serves these pages as plain documents');
    expect(pages.contract.version).toBeUndefined();
    const asked = product.page('docs/decisions/D-001.md');
    if (!asked.ok) throw new Error(asked.message);
    expect(asked.page.document).toBeUndefined();
    expect(asked.page.markdown).toContain('recorded here');
  });
});

describe('the product\'s open questions', () => {
  const OPEN = [
    '# Q-004 — Who collects the unclaimed portions?',
    '',
    'Concerns: UC-001, FR-002',
    'Who can answer: the cafe owner',
    '',
    '## Question',
    'When the cafe closes and portions are still listed, does the owner want to be told?',
    '',
    '## What settles it',
    "The owner's answer after the first week with the prototype.",
    '',
    '## Answer',
    '',
  ].join('\n');

  test('a question whose answer is empty is open; one with text is answered; Not applicable closes', () => {
    draft();
    write('docs/kinds.yaml', ['contract: 1', 'overview:', '  audience:', '    document: docs/vision.md', '    section: Audience', 'stages:', '  - id: idea', 'kinds:', '  - name: question', '    prefix: Q', '    folder: docs/questions', '    stage: idea', '    hint: write a question', '    questions:', '      identityPrefix: Q', '      titleSeparator: —', '      promptSection: Question', '      answerSection: Answer', '      answererField: Who can answer', '      concernsField: Concerns', '      notApplicablePrefix: "Not applicable:"'].join('\n') + '\n');
    write('docs/questions/Q-004-who-collects-unclaimed.md', OPEN + '\n');
    const product = requireProduct(openProductWiki(folder!));
    const asked = product.questions();
    if (!asked.ok) throw new Error(asked.message);
    expect(asked.questions.length).toBe(1);
    const [question] = asked.questions;
    expect(question!.id).toBe('Q-004');
    expect(question!.title).toBe('Who collects the unclaimed portions?');
    expect(question!.state).toBe('open');
    expect(question!.who).toBe('the cafe owner');
    expect(question!.concerns).toEqual(['UC-001', 'FR-002']);
    expect(asked.openCount).toBe(1);
  });

  test('the manifest supplies question identity, fields, sections and audience source', () => {
    draft();
    write('docs/kinds.yaml', [
      'contract: 1', 'overview:', '  audience:', '    document: docs/brief.md', '    section: Readers',
      'stages:', '  - id: explore', 'kinds:', '  - name: inquiry', '    prefix: IQ', '    folder: docs/inquiries', '    stage: explore', '    hint: ask the question',
      '    questions:', '      identityPrefix: ASK', '      titleSeparator: \":\"', '      promptSection: Unknown', '      answerSection: Decision', '      answererField: Steward', '      concernsField: Touches', '      notApplicablePrefix: "Out of scope:"',
    ].join('\n') + '\n');
    write('docs/inquiries/ASK-001.md', '# ASK-001: Is the route known?\n\nSteward: Maintainer\nTouches: IQ-002, ADR-003\n\n## Unknown\nWhich route should be used?\n\n## Decision\nOut of scope: not needed now.\n');
    write('docs/brief.md', '# Brief\n\n## Readers\nOperators of small labs.\n');
    const product = requireProduct(openProductWiki(folder!));
    const asked = product.questions();
    if (!asked.ok) throw new Error(asked.message);
    expect(asked.kindName).toBe('inquiry');
    expect(asked.questions.map((question) => [question.id, question.who, question.concerns, question.state])).toEqual([
      ['ASK-001', 'Maintainer', ['IQ-002', 'ADR-003'], 'not-applicable'],
    ]);
    expect(product.audience()).toBe('Operators of small labs.');
  });

  test('an answered and a not-applicable question are closed; the empty answer is not an answer', () => {
    draft();
    write('docs/kinds.yaml', ['contract: 1', 'overview:', '  audience:', '    document: docs/vision.md', '    section: Audience', 'stages:', '  - id: idea', 'kinds:', '  - name: question', '    prefix: Q', '    folder: docs/questions', '    stage: idea', '    hint: write a question', '    questions:', '      identityPrefix: Q', '      titleSeparator: —', '      promptSection: Question', '      answerSection: Answer', '      answererField: Who can answer', '      concernsField: Concerns', '      notApplicablePrefix: "Not applicable:"'].join('\n') + '\n');
    write('docs/questions/Q-001-open.md', OPEN.replace('Q-004', 'Q-001') + '\n');
    write('docs/questions/Q-002-answered.md', [
      '# Q-002 — Should leftovers be delivered?',
      '',
      'Concerns: VISION',
      'Who can answer: the product owner',
      '',
      '## Question',
      'Do buyers expect the portions to be delivered?',
      '',
      '## What settles it',
      "The product owner's decision on scope.",
      '',
      '## Answer',
      'A first run showed no buyer asked for delivery in the first week.',
    ].join('\n') + '\n');
    write('docs/questions/Q-003-na.md', [
      '# Q-003 — Chains with their own apps?',
      '',
      'Concerns: VISION',
      'Who can answer: the product owner',
      '',
      '## Question',
      'Do we serve chains that already run their own ordering apps?',
      '',
      '## What settles it',
      'The vision.',
      '',
      '## Answer',
      'Not applicable: delivery and chains are out of the vision.',
    ].join('\n') + '\n');
    const product = requireProduct(openProductWiki(folder!));
    const asked = product.questions();
    if (!asked.ok) throw new Error(asked.message);
    expect(asked.questions.map((each) => each.state)).toEqual(['open', 'answered', 'not-applicable']);
    expect(asked.openCount).toBe(1);
    const closed = asked.questions.find((each) => each.id === 'Q-003');
    expect(closed?.answer).toBe('Not applicable: delivery and chains are out of the vision.');
  });

  test('the answer is read whole, code fences included; the identity line is no section', () => {
    draft();
    write('docs/kinds.yaml', ['contract: 1', 'overview:', '  audience:', '    document: docs/vision.md', '    section: Audience', 'stages:', '  - id: idea', 'kinds:', '  - name: question', '    prefix: Q', '    folder: docs/questions', '    stage: idea', '    hint: write a question', '    questions:', '      identityPrefix: Q', '      titleSeparator: —', '      promptSection: Question', '      answerSection: Answer', '      answererField: Who can answer', '      concernsField: Concerns', '      notApplicablePrefix: "Not applicable:"'].join('\n') + '\n');
    write('docs/questions/Q-005-fenced.md', [
      '# Q-005 — Which kernel do we bind?',
      '',
      'Concerns: VISION',
      'Who can answer: the owner',
      '',
      '## Question',
      'Which database kernel does the first version bind?',
      '',
      '## What settles it',
      'A benchmark both candidates pass.',
      '',
      '## Answer',
      'Chosen: the embedded one, for the reasons the decision records.',
      '',
      '```',
      '# not a heading inside the fence',
      '```',
    ].join('\n') + '\n');
    const product = requireProduct(openProductWiki(folder!));
    const asked = product.questions();
    if (!asked.ok) throw new Error(asked.message);
    expect(asked.questions.length).toBe(1);
    expect(asked.questions[0]!.state).toBe('answered');
  });

  test('a document that is no question is not listed; the questions change with the files', () => {
    draft();
    write('docs/kinds.yaml', ['contract: 1', 'overview:', '  audience:', '    document: docs/vision.md', '    section: Audience', 'stages:', '  - id: idea', 'kinds:', '  - name: question', '    prefix: Q', '    folder: docs/questions', '    stage: idea', '    hint: write a question', '    questions:', '      identityPrefix: Q', '      titleSeparator: —', '      promptSection: Question', '      answerSection: Answer', '      answererField: Who can answer', '      concernsField: Concerns', '      notApplicablePrefix: "Not applicable:"'].join('\n') + '\n');
    write('docs/questions/Q-006-later.md', OPEN.replace('Q-004', 'Q-006') + '\n');
    write('docs/vision.md', '# Vision\n\nNo question here.\n');
    const product = requireProduct(openProductWiki(folder!));
    const asked = product.questions();
    if (!asked.ok) throw new Error(asked.message);
    expect(asked.questions.map((each) => each.id)).toEqual(['Q-006']);
    write('docs/questions/Q-006-later.md', OPEN.replace('Q-004', 'Q-006').replace('## Answer\n', '## Answer\nNow we know: the owner collects them.\n') + '\n');
    const after = product.questions();
    if (!after.ok) throw new Error(after.message);
    expect(after.openCount).toBe(0);
    expect(after.questions[0]!.state).toBe('answered');
  });

  test('the audience is the vision\'s Audience section; no vision, no audience', () => {
    draft();
    write('docs/kinds.yaml', ['contract: 1', 'overview:', '  audience:', '    document: docs/vision.md', '    section: Audience', 'stages:', '  - id: idea', 'kinds:', '  - name: question', '    prefix: Q', '    folder: docs/questions', '    stage: idea', '    hint: write a question', '    questions:', '      identityPrefix: Q', '      titleSeparator: —', '      promptSection: Question', '      answerSection: Answer', '      answererField: Who can answer', '      concernsField: Concerns', '      notApplicablePrefix: "Not applicable:"'].join('\n') + '\n');
    const product = requireProduct(openProductWiki(folder!));
    expect(product.audience()).toBeUndefined();
    write('docs/vision.md', [
      '# Leftovers',
      '',
      '## Audience',
      'Owners of small cafes with fewer than twenty seats.',
      '',
      '## Problem',
      'Unsold portions are thrown away at closing.',
    ].join('\n') + '\n');
    expect(product.audience()).toBe('Owners of small cafes with fewer than twenty seats.');
  });

  test('an audience document symlink cannot read outside the product root', () => {
    draft();
    const outside = join(tmpdir(), `madarch-audience-outside-${process.pid}.md`);
    writeFileSync(outside, '# Outside\n\n## Audience\nSecret outside text.\n');
    try {
      write('docs/kinds.yaml', ['contract: 1', 'overview:', '  audience:', '    document: docs/brief.md', '    section: Readers', 'stages:', '  - id: explore', 'kinds: []'].join('\n') + '\n');
      symlinkSync(outside, join(folder!, 'docs', 'brief.md'));
      expect(requireProduct(openProductWiki(folder!)).audience()).toBeUndefined();
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test('an Audience inside a code fence is not the audience', () => {
    draft();
    write('docs/kinds.yaml', ['contract: 1', 'overview:', '  audience:', '    document: docs/vision.md', '    section: Audience', 'stages:', '  - id: idea', 'kinds:', '  - name: question', '    prefix: Q', '    folder: docs/questions', '    stage: idea', '    hint: write a question', '    questions:', '      identityPrefix: Q', '      titleSeparator: —', '      promptSection: Question', '      answerSection: Answer', '      answererField: Who can answer', '      concernsField: Concerns', '      notApplicablePrefix: "Not applicable:"'].join('\n') + '\n');
    write('docs/vision.md', [
      '# Draft',
      '',
      '```',
      '## Audience',
      'not a section',
      '```',
      '',
      '## Audience',
      'The real one, after the fence.',
    ].join('\n') + '\n');
    const product = requireProduct(openProductWiki(folder!));
    expect(product.audience()).toBe('The real one, after the fence.');
  });
});

/**
 * Mutation-killing edges: every branch of the parser named once. These run
 * in-process on `parseQuestion` and `audienceOf` directly, so a mutant that
 * changes one branch turns one of these cases red.
 */
import { parseQuestion as parseConfiguredQuestion, audienceOf as audienceOfSection } from '../src/product-wiki/questions.js';
const questionForm = { identityPrefix: 'Q', titleSeparator: '—', promptSection: 'Question', answerSection: 'Answer', answererField: 'Who can answer', concernsField: 'Concerns', notApplicablePrefix: 'Not applicable:' };
const parseQuestion = (path: string, markdown: string) => parseConfiguredQuestion(path, markdown, questionForm);
const audienceOf = (markdown: string) => audienceOfSection(markdown, 'Audience');

describe('parseQuestion edges, one branch at a time', () => {
  const identity = (rest: string): string => `# ${rest}\n`;

  test('a short id (fewer than three digits) is not a question; a title with no dash text is not one', () => {
    expect(parseQuestion('docs/x.md', identity('Q-01 — Two digits'))).toBeUndefined();
    expect(parseQuestion('docs/x.md', identity('Q-005 — '))).toBeUndefined();
    expect(parseQuestion('docs/x.md', identity('FR-001 — Not a question'))).toBeUndefined();
  });

  test('a fence inside the Question section holds no section switch; tildes too', () => {
    const withFence = [
      '# Q-005 — Which kernel?',
      '',
      'Who can answer: the owner',
      '',
      '## Question',
      'Which kernel?',
      '',
      '```',
      '## What settles it inside',
      '~~~',
      'a plain line',
      '```',
      'The real settling line.',
      '',
      '## Answer',
    ].join('\n');
    const question = parseQuestion('docs/x.md', withFence);
    expect(question?.question).toContain('The real settling line.');
    expect(question?.question).toContain('What settles it inside');
    expect(question?.question).toContain('a plain line');
    expect(question?.state).toBe('open');
  });

  test('unknown top-level fields are ignored; Concerns splits and trims; a later field line is body', () => {
    const doc = [
      '# Q-006 — Splitting?',
      '',
      'Status: done',
      'Concerns: VISION,  Q-001 , FR-002',
      'Who can answer:  trimmed  ',
      '',
      '## Question',
      'Concerns: not a field here',
      '',
      '## What settles it',
      'A decision.',
      '',
      '## Answer',
    ].join('\n');
    const question = parseQuestion('docs/x.md', doc);
    expect(question?.who).toBe('trimmed');
    expect(question?.concerns).toEqual(['VISION', 'Q-001', 'FR-002']);
    expect(question?.question).toContain('not a field here');
    // A `Status:` line before a section is an unknown field to the reader,
    // whatever the set's gate refuses: the state stays computed, never taken.
    expect(question?.state).toBe('open');
  });

  test('Not applicable is the first line only; any other answer is answered; no Answer section is open', () => {
    const base = (answer: string): string => [
      '# Q-007 — Ends?',
      '',
      'Who can answer: the owner',
      '',
      '## Question',
      'Does it end?',
      '',
      '## What settles it',
      'An answer.',
      '',
      '## Answer',
      answer,
    ].join('\n');
    expect(parseQuestion('docs/x.md', base('not applicable: lowercase first word'))?.state).toBe('answered');
    expect(parseQuestion('docs/x.md', base('I do not think not applicable: no'))?.state).toBe('answered');
    const naQuestion = parseQuestion('docs/x.md', base('Not applicable: out of scope, and the reason.'));
    expect(naQuestion?.state).toBe('not-applicable');
    expect(naQuestion?.answer).toBe('Not applicable: out of scope, and the reason.');
    // Whitespace around the answer does not close anything.
    expect(parseQuestion('docs/x.md', base('   '))?.state).toBe('open');
    const withoutAnswer = [
      '# Q-008 — Open entirely?',
      '',
      'Who can answer: the owner',
      '',
      '## Question',
      'Does it end?',
      '',
      '## What settles it',
      'An answer.',
    ].join('\n');
    expect(parseQuestion('docs/x.md', withoutAnswer)?.state).toBe('open');
  });

  test('the What settles it section alone, with no Question body, is still no question', () => {
    const half = [
      '# Q-009 — No question section?',
      '',
      'Who can answer: the owner',
      '',
      '## What settles it',
      'An answer.',
      '',
      '## Answer',
    ].join('\n');
    expect(parseQuestion('docs/x.md', half)).toBeUndefined();
  });

  test('the identity line is not a section; a deeper heading after it is a body line', () => {
    const doc = [
      '# Q-010 — Which depth?',
      '',
      '## Question',
      'The question first.',
      '### A deeper heading',
      'Then the body.',
      '',
      '## Answer',
    ].join('\n');
    expect(parseQuestion('docs/x.md', doc)?.question).toContain('The question first.');
    expect(parseQuestion('docs/x.md', doc)?.question).toContain('A deeper heading');
    expect(parseQuestion('docs/x.md', doc)?.question).toContain('Then the body.');
  });

  test('a document whose first non-empty line stands inside a fence is not a question', () => {
    const doc = ['```', '# Q-011 — Inside the fence', '```'].join('\n');
    expect(parseQuestion('docs/x.md', doc)).toBeUndefined();
  });
});

describe('audienceOf edges', () => {
  test('a lookalike heading does not count; the exact section heading does', () => {
    expect(audienceOf(['# V', '', '## AudienceX', 'wrong one.', '', '## Audience', 'right one.'].join('\n'))).toBe('right one.');
    expect(audienceOf('## Audience')).toBeUndefined(); // heading, then the section end: empty
  });

  test('the paragraph runs over its wrapped lines, ends at its first blank line, and never takes a heading', () => {
    const doc = ['# V', '', '## Audience', 'Line one,', 'line two.', '', 'Second paragraph, not read.', '', '## Problem', 'After.'].join('\n');
    expect(audienceOf(doc)).toBe('Line one, line two.');
    const headingFollows = ['# V', '', '## Audience', '## Problem', 'After.'].join('\n');
    expect(audienceOf(headingFollows)).toBeUndefined();
  });

  test('the section inside a code fence is not the audience; a blank line before the paragraph is skipped', () => {
    const fenced = ['# V', '', '~~~sh', '## Audience', 'not this', '~~~', '', '## Audience', '', '', 'The real paragraph.'].join('\n');
    expect(audienceOf(fenced)).toBe('The real paragraph.');
  });
});

describe('parseQuestion and audienceOf: the fence and anchor edges the mutants probe', () => {
  test('an invalid identity line over a document with sections is no question, not a crash', () => {
    const wrong = [
      '# Q-01 — Two digits, then sections',
      '',
      '## Question',
      'Still a document shape.',
      '',
      '## What settles it',
      'An answer.',
    ].join('\n');
    expect(parseQuestion('docs/x.md', wrong)).toBeUndefined();
  });

  test('the Not applicable word is recognised only as the answer line, whole', () => {
    const base = (answer: string): string => [
      '# Q-030 — Ends?',
      '',
      '## Question',
      'Does it end?',
      '',
      '## What settles it',
      'An answer.',
      '',
      '## Answer',
      answer,
    ].join('\n');
    expect(parseQuestion('docs/x.md', base('I said, Not applicable: maybe'))?.state).toBe('answered');
    expect(parseQuestion('docs/x.md', base('Not applicable, but no colon'))?.state).toBe('answered');
  });

  test('the identity line is anchored: a sentence that quotes one is not the identity', () => {
    const quoted = [
      'The set writes the line # Q-005 — like this inside prose.',
      '',
      '## Question',
      'Real content.',
      '',
      '## What settles it',
      'An answer.',
    ].join('\n');
    expect(parseQuestion('docs/x.md', quoted)).toBeUndefined();
  });

  test('blank and whitespace-only lines ahead of the identity line are skipped', () => {
    const spaced = '\n   \n# Q-031 — After blanks?\n\n## Question\nQ.\n\n## What settles it\nA.\n';
    const question = parseQuestion('docs/x.md', spaced);
    expect(question?.id).toBe('Q-031');
  });

  test('a fence that opens before the identity line does not stop the reader', () => {
    const first = ['```', 'random', '```', '# Q-032 — After a front fence?', '', '## Question', 'Q.', '## Answer', 'Known.'].join('\n');
    const question = parseQuestion('docs/x.md', first);
    expect(question?.id).toBe('Q-032');
    expect(question?.state).toBe('answered');
  });

  test('a fence in the Question section holds the answer apart: tildes do not close backticks', () => {
    const doc = [
      '# Q-033 — With a fenced answer?',
      '',
      '## Question',
      'Which kernel?',
      '',
      '```',
      '## What settles it inside',
      'a plain line',
      '```',
      'The real settling line.',
      '',
      '## Answer',
      'The embedded one.',
    ].join('\n');
    const question = parseQuestion('docs/x.md', doc);
    expect(question?.question).toContain('What settles it inside');
    expect(question?.question).toContain('a plain line');
    expect(question?.question).toContain('The real settling line.');
    expect(question?.state).toBe('answered');
    expect(question?.answer).toBe('The embedded one.');
  });

  test('longer rows of the same tick, and other ticks, do not close a fence', () => {
    const doc = [
      '# Q-034 — Long closes?',
      '',
      '## Question',
      'A question.',
      '',
      '``````',
      'still inside',
      '~~~',
      '~~~~',
      '```',
      '## Answer',
      'Still closed by this section, once the fence ends.',
    ].join('\n');
    const question = parseQuestion('docs/x.md', doc);
    expect(question?.question).toContain('still inside');
    expect(question?.question).toContain('~~~');
    expect(question?.question).toContain('~~~~');
    expect(question?.state).toBe('open');
  });

  test('question and answer keep their joined lines exactly, trimming only the edges', () => {
    const doc = [
      '# Q-035 — Exact bodies?',
      '',
      'Who can answer: the owner',
      '',
      '## Question',
      'Line one of the question.',
      'Line two of the question.',
      '',
      '## What settles it',
      'An answer.',
      '',
      '## Answer',
      'Line one of the answer.',
      'Line two of the answer.',
    ].join('\n');
    const question = parseQuestion('docs/x.md', doc);
    expect(question?.question).toBe('Line one of the question.\nLine two of the question.');
    expect(question?.answer).toBe('Line one of the answer.\nLine two of the answer.');
  });

  test('a repeated section heading does not wipe what came before it', () => {
    const doc = [
      '# Q-036 — Repeated?',
      '',
      '## Question',
      'The first body.',
      '',
      '## Question',
      'The second body.',
      '',
      '## What settles it',
      'An answer.',
    ].join('\n');
    const question = parseQuestion('docs/x.md', doc);
    expect(question?.question).toContain('The first body.');
    expect(question?.question).toContain('The second body.');
  });

  test('a sentence naming a section in prose is not a section heading', () => {
    const doc = [
      '# Q-037 — Inline section names?',
      '',
      'The plan mentions ## Question above the fold, but not as a heading.',
      '',
      '## Question',
      'Real body.',
      '',
      '## What settles it',
      'An answer.',
    ].join('\n');
    expect(parseQuestion('docs/x.md', doc)?.question).toBe('Real body.');
  });

  test('a section heading keeps its name when the writer left trailing spaces', () => {
    const doc = [
      '# Q-038 — Trailing spaces?',
      '',
      '## Question  ',
      'Real body.',
      '',
      '## What settles it',
      'An answer.',
      '',
      '## Answer',
      'It closes.',
    ].join('\n');
    const question = parseQuestion('docs/x.md', doc);
    expect(question?.question).toBe('Real body.');
    expect(question?.state).toBe('answered');
  });

  test('a body line that begins like a field, before the first section, is no field', () => {
    const doc = [
      '# Q-039 — Field-shaped prose?',
      '',
      'See Who can answer: nobody, in prose.',
      '',
      '## Question',
      'Real body.',
      '',
      '## What settles it',
      'An answer.',
    ].join('\n');
    const question = parseQuestion('docs/x.md', doc);
    expect(question?.who).toBe('');
  });
})

describe('audienceOf: the fence and anchor edges the mutants probe', () => {
  test('a paragraph line that quotes a heading is not the section, and two spaces still are one', () => {
    expect(audienceOf(['# V', '', 'see the ## Audience line, in prose.', '', '##  Audience', 'The two-space one.'].join('\n'))).toBe('The two-space one.');
  });

  test('only the first paragraph is the audience, blanks and stray fences aside', () => {
    const doc = ['# V', '', '## Audience', 'Para one.', '', 'Second paragraph, not read.'].join('\n');
    expect(audienceOf(doc)).toBe('Para one.');
  });

  test('a stray unticked fence marker inside prose opens no fence, and a quoted heading does not end a paragraph', () => {
    const doc = [
      '# V',
      '',
      'a word~~~ line',
      '',
      '## Audience',
      'Para one speaks ## of the audience plainly, then keeps going.',
      '',
      '## Problem',
      'After.',
    ].join('\n');
    expect(audienceOf(doc)).toBe('Para one speaks ## of the audience plainly, then keeps going.');
  });
})

describe('parseQuestion: the fields the reader keeps', () => {
  test('Concerns split drops the blanks; trimming is per id, not whole-line', () => {
    const doc = [
      '# Q-045 — Blanks in Concerns?',
      '',
      'Concerns: VISION, , FR-002 , ',
      'Who can answer: the owner',
      '',
      '## Question',
      'Q.',
      '',
      '## What settles it',
      'An answer.',
    ].join('\n');
    expect(parseQuestion('docs/x.md', doc)?.concerns).toEqual(['VISION', 'FR-002']);
  });

  test('a prose line that only CONTAINS the field name is no field', () => {
    const doc = [
      '# Q-046 — Prose field?',
      '',
      'The plan (Who can answer: bob) says it in prose.',
      '',
      '## Question',
      'Q.',
      '',
      '## What settles it',
      'An answer.',
    ].join('\n');
    expect(parseQuestion('docs/x.md', doc)?.who).toBe('');
  });
});
