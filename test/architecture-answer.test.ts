/**
 * The Architecture answer's cache (madarch-tzte.23.8): the wiki serves the bundle of the
 * product as it stands, builds it once per revision and hands the same one out until a
 * page, a model file or the manifest moves. The app asks `/api/architecture` on every
 * page load — the shell's count and a page's element links read it — and one build is a
 * render of every view through a temporary database, so a second ask of an unchanged
 * product must cost nothing.
 *
 * The values here are the task's own: one build per revision, one build shared by two
 * readers of one revision, no page text read for a product whose model does not
 * compile, and a rebuilt answer after each thing the answer depends on moves.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { openProductWiki, type ProductWiki } from '../src/product-wiki/pages.js';
import { createArchitectureAnswer } from '../src/server/architecture-answer.js';

let folder: string | undefined;

/** A product folder holding the manifest and nothing else: every test writes what it is about. */
function product(manifest = 'schemaVersion: 1\nid: demo\nname: Demo\n'): string {
  folder = mkdtempSync(join(tmpdir(), 'madarch-arch-answer-'));
  writeFileSync(join(folder, 'workspace.yaml'), manifest);
  return folder;
}

/** One file of the product, its folders made first. */
function write(path: string, content: string): void {
  const full = join(folder!, path);
  mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
  writeFileSync(full, content);
}

/** The opened product wiki of the folder a test made. */
function wikiOf(at: string): ProductWiki {
  const opened = openProductWiki(at);
  if (!opened.ok) throw new Error(opened.message);
  return opened.wiki;
}

/** The wiki as the answer reads it, counting the walks: `pages` keys the answer, `nextStepPages` reads the texts. */
function counted(wiki: ProductWiki): { wiki: ProductWiki; reads: { pages: number; nextStepPages: number } } {
  const reads = { pages: 0, nextStepPages: 0 };
  return {
    reads,
    wiki: {
      product: wiki.product,
      pages: () => {
        reads.pages += 1;
        return wiki.pages();
      },
      page: (path: string) => wiki.page(path),
      questions: () => wiki.questions(),
      nextStepPages: () => {
        reads.nextStepPages += 1;
        return wiki.nextStepPages();
      },
      overview: () => wiki.overview(),
      audience: () => wiki.audience(),
    },
  };
}

/** A model that compiles: one view beside the landscape, so the render has something to draw. */
const MODEL = `version: 1

elements:
  - id: shop
    kind: domain
    name: Shop
  - id: checkout-web
    kind: service
    name: Checkout web
    parent: shop
  - id: catalog-api
    kind: service
    name: Catalog API
    parent: shop

relations:
  - id: web-reads-catalog
    name: reads prices
    from: checkout-web
    to: catalog-api
`;

afterEach(() => {
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

describe('one answer per revision', () => {
  test('two asks of an unchanged product are the one bundle, built once, with one page walk', async () => {
    product();
    write('model/system.yaml', MODEL);
    write('docs/vision.md', '# Vision\n\nThe shop serves its customers.\n');
    const watched = counted(wikiOf(folder!));
    const answer = createArchitectureAnswer(watched.wiki);
    const first = await answer.answer();
    const second = await answer.answer();
    // The same bundle object: the second ask built nothing.
    expect(second).toBe(first);
    expect(first.model?.elements.map((element) => element.id)).toEqual(['catalog-api', 'checkout-web', 'shop']);
    // Every ask reads the revision it keys the answer by; only the first reads the pages' texts.
    expect(watched.reads).toEqual({ pages: 2, nextStepPages: 1 });
  }, 60_000);

  test('two readers of one revision share the build the first asked for', async () => {
    product();
    write('model/system.yaml', MODEL);
    write('docs/vision.md', '# Vision\n');
    const watched = counted(wikiOf(folder!));
    const answer = createArchitectureAnswer(watched.wiki);
    const [first, second] = await Promise.all([answer.answer(), answer.answer()]);
    expect(second).toBe(first);
    expect(watched.reads.nextStepPages).toBe(1);
  }, 60_000);

  test('a saved page is a new revision and a new answer: the page naming an element moves into its backlinks', async () => {
    product();
    write('model/system.yaml', MODEL);
    write('docs/vision.md', '# Vision\n\nNothing is named here.\n');
    const watched = counted(wikiOf(folder!));
    const answer = createArchitectureAnswer(watched.wiki);
    const before = await answer.answer();
    expect(before.model?.elements.find((element) => element.id === 'shop')?.namedBy).toEqual([]);
    write('docs/vision.md', '# Vision\n\nThe shop serves its customers.\n');
    const after = await answer.answer();
    expect(after).not.toBe(before);
    expect(after.model?.elements.find((element) => element.id === 'shop')?.namedBy).toEqual(['docs/vision.md']);
    expect(watched.reads.nextStepPages).toBe(2);
  }, 60_000);

  test('a saved model file is a new revision and a new answer', async () => {
    product();
    write('model/system.yaml', MODEL);
    const answer = createArchitectureAnswer(wikiOf(folder!));
    const before = await answer.answer();
    expect(before.model?.elements).toHaveLength(3);
    write('model/system.yaml', MODEL + '\n\nelements:\n  - id: extra\n    kind: service\n    parent: shop\n');
    const after = await answer.answer();
    expect(after).not.toBe(before);
    expect(after.model?.elements.map((element) => element.id)).toContain('extra');
  }, 60_000);

  test('a declared repository is part of what the answer says: a manifest edit rebuilds it, though no page or model file moved', async () => {
    product();
    write('model/system.yaml', MODEL);
    const wiki = wikiOf(folder!);
    const answer = createArchitectureAnswer(wiki);
    const before = await answer.answer();
    expect(before.notes).toEqual([]);
    const revisionBefore = wiki.pages();
    write('workspace.yaml', 'schemaVersion: 1\nid: demo\nname: Demo\nrepos:\n  - name: gone\n    url: https://example.invalid/gone.git\n');
    const revisionAfter = wiki.pages();
    if (!revisionBefore.ok || !revisionAfter.ok) throw new Error('the pages could not be read');
    // The revision the wiki reports alone would not see it: the manifest's own bytes are the key's other half.
    expect(revisionAfter.revision).toBe(revisionBefore.revision);
    const after = await answer.answer();
    expect(after).not.toBe(before);
    expect(after.notes.map((note) => note.file)).toEqual(['repos/gone']);
  }, 60_000);
});

describe('a product whose model does not compile', () => {
  test('answers its errors and reads no page text at all, and the answer is kept like any other', async () => {
    product();
    write('docs/vision.md', '# Vision\n\nThe shop serves its customers.\n');
    const watched = counted(wikiOf(folder!));
    const answer = createArchitectureAnswer(watched.wiki);
    const first = await answer.answer();
    expect(first.model).toBeUndefined();
    expect(first.errors).toHaveLength(1);
    expect(first.errors[0]!.file).toBe('model');
    expect(first.errors[0]!.message).toContain('no model');
    const second = await answer.answer();
    expect(second).toBe(first);
    // No page of the product is read: the answer names no backlink, so nothing reads one.
    expect(watched.reads).toEqual({ pages: 2, nextStepPages: 0 });
  }, 60_000);
});
