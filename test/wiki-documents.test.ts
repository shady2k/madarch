import { afterEach, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { documentHeadings, documentImages, documentLinkWarnings, documentPages, refusedDocumentLinks, scanDocument, type DocumentHost } from '../src/wiki/documents.js';
import { documentImageRoute } from '../src/wiki/pages-path.js';
import { isDocumentPage, type AnyWikiPage, type WikiDocumentPage, type WikiPage } from '../src/wiki/pages.js';
import { navTree, diagramModuleJs, renderDocumentBody, type WriterLinks } from '../src/wiki/render.js';
import { starlightLinks } from '../src/wiki/starlight.js';

/**
 * The repository's own documents as wiki pages (docs/changes/wiki/capabilities/wiki.md,
 * requirements `documents` and `links`): what `documentPages` finds, the titles
 * documents without one get, the folders the navigation keeps, and how the
 * links between documents, to their images and out of the wiki are classified —
 * broken ones naming the document and the target. The body rewriter is the
 * writers' shared pure part: the same Markdown in, each writer's links out.
 */

/**
 * Every temporary folder this file makes, removed after each test and on
 * exit with whatever is left, pass or fail: a run of the suite leaves the
 * system temporary folder as it found it.
 */
const made: string[] = [];

function tempFolder(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

const removeMadeFolders = (): void => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
};

afterEach(removeMadeFolders);
process.on('exit', removeMadeFolders);

/** A repository folder a test writes its files into; no model, no git. */
function writeRepo(files: Record<string, string>): string {
  const root = tempFolder('madarch-wiki-docs-');
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

function documentsOf(files: Record<string, string>, host?: DocumentHost): readonly WikiDocumentPage[] {
  return documentPages(writeRepo(files), host);
}

/** The document page whose body was written at `name` (a repository path with the .md). */
function pageOf(pages: readonly WikiDocumentPage[], name: string): WikiDocumentPage {
  const found = pages.find((page) => page.id === `document/${name.replace(/\.md$/, '')}`);
  if (found === undefined) throw new Error(`no document page for ${name} among ${pages.map((page) => page.id).join(', ')}`);
  return found;
}

const REWRITER: WriterLinks = {
  pathOf: (pageId: string) => `/${pageId}/`,
  slugOf: (text: string) => text.toLowerCase().replace(/ /g, '-'),
};
function rewrite(body: string, files: Record<string, string> = {}, host?: DocumentHost): string {
  const pages = documentPages(writeRepo({ 'docs/doc.md': body, ...files }), host);
  return renderDocumentBody(pages.find((page) => page.id === 'document/docs/doc')!, REWRITER);
}

/** The host every hosted test builds with: github at a fixed commit. */
const GITHUB: DocumentHost = { commit: 'c0ffee0', origin: 'https://github.com/acme/shop.git' };

describe('documentPages', () => {
  test('a repository with README, docs and a review gives one page per document, sorted by path', () => {
    const pages = documentsOf({
      'madarch/review.md': '# Architecture review\n\nConfirmed.\n',
      'README.md': '# Documents fixture\n\nRead me.\n',
      'docs/architecture.md': '# Architecture\n\nThe shape.\n',
      'docs/decisions/0001-use-grpc.md': 'We use gRPC.\n',
    });
    expect(pages.map((page) => page.id)).toEqual([
      'document/README',
      'document/docs/architecture',
      'document/docs/decisions/0001-use-grpc',
      'document/madarch/review',
    ]);
    // Titles: from the level-1 heading where there is one, from the file
    // name where the document has no heading at all — and that document
    // also says its title line is the writer's to insert.
    expect(pages.map((page) => page.title)).toEqual(['Documents fixture', 'Architecture', '0001-use-grpc', 'Architecture review']);
    expect(pages.map((page) => page.insertTitle)).toEqual([false, false, true, false]);
    // The navigation keeps the folders: the review and the README stand in
    // the section directly, the docs pages under one group per folder.
    expect(pages.map((page) => page.nav)).toEqual([
      ['Documents'],
      ['Documents', 'docs'],
      ['Documents', 'docs', 'decisions'],
      ['Documents', 'madarch'],
    ]);
    // A document page is its Markdown whole: no blocks, the body exactly
    // the file's text.
    expect(pages.every((page) => isDocumentPage(page))).toBe(true);
    expect(pageOf(pages, 'docs/decisions/0001-use-grpc.md').body).toBe('We use gRPC.\n');
    expect(pageOf(pages, 'docs/decisions/0001-use-grpc.md').blocks).toEqual([]);
  });

  test('a repository without documents gives none', () => {
    expect(documentsOf({ 'madarch/model.yaml': 'version: 1\n' })).toEqual([]);
    expect(documentPages(writeRepo({}))).toEqual([]);
  });

  test('only Markdown files are documents: README.md, docs/**.md and the review report', () => {
    const pages = documentsOf({
      'README.md': '# Read me\n',
      'docs/a.md': 'A\n',
      'docs/notes.txt': 'not a document\n',
      'docs/b.MD': 'uppercase extension is not a document\n',
      'CONTRIBUTING.md': 'outside the document set\n',
      'madarch/review.md': '# Review\n',
      'madarch/model.yaml': 'version: 1\n',
    });
    expect(pages.map((page) => page.id)).toEqual(['document/README', 'document/docs/a', 'document/madarch/review']);
  });

  test('a docs folder that cannot be read is refused, naming it', () => {
    const root = writeRepo({ 'README.md': '# Read me\n' });
    mkdirSync(join(root, 'docs'));
    chmodSync(join(root, 'docs'), 0o000);
    try {
      expect(() => documentPages(root)).toThrow(`the documents folder ${join(root, 'docs')} cannot be read`);
    } finally {
      chmodSync(join(root, 'docs'), 0o755);
    }
  });

  test('links between documents resolve to their pages, anchors carried along', () => {
    const pages = documentsOf({
      'README.md': '# Read me\n\n[Guide](docs/guide.md)\n',
      'docs/guide.md': '# Guide\n\n[Decision](decisions/0001-x.md), [read me](../README.md), [its context](decisions/0001-x.md#context)\n',
      'docs/decisions/0001-x.md': 'Decision.\n',
    });
    expect(pageOf(pages, 'docs/guide.md').links).toEqual([
      { written: 'decisions/0001-x.md', kind: 'page', pageId: 'document/docs/decisions/0001-x' },
      { written: '../README.md', kind: 'page', pageId: 'document/README' },
      { written: 'decisions/0001-x.md#context', kind: 'page', pageId: 'document/docs/decisions/0001-x', anchor: 'context' },
    ]);
  });

  test('images under docs/ are copied, and the build knows which', () => {
    const pages = documentsOf({
      'README.md': '# Read me\n\n![Overview](docs/img/overview.png)\n',
      'docs/architecture.md': '# Architecture\n\n![Overview](img/overview.png)\n',
      'docs/img/overview.png': 'png bytes',
    });
    expect(pageOf(pages, 'docs/architecture.md').links).toEqual([{ written: 'img/overview.png', kind: 'image', filePath: 'docs/img/overview.png' }]);
    expect(pageOf(pages, 'README.md').links).toEqual([{ written: 'docs/img/overview.png', kind: 'image', filePath: 'docs/img/overview.png' }]);
    expect(documentImages(pages)).toEqual(['docs/img/overview.png']);
  });

  test('a tilde fence is code all the same', () => {
    const pages = documentsOf({
      'docs/a.md': ['~~~text', 'not a link: [fake](also-missing.md)', '~~~', ''].join('\n'),
    });
    expect(pageOf(pages, 'docs/a.md').links).toEqual([]);
  });

  test('an image that is not there is linked to the host like any missing target, and warned about', () => {
    const pages = documentsOf({ 'docs/a.md': '# A\n\n![gone](img/gone.png)\n' }, GITHUB);
    expect(pageOf(pages, 'docs/a.md').links).toEqual([
      { written: 'img/gone.png', kind: 'host', url: 'https://github.com/acme/shop/blob/c0ffee0/docs/img/gone.png', target: 'docs/img/gone.png', line: 3, missing: true },
    ]);
    expect(documentImages(pages)).toEqual([]);
  });

  test('a link with a title resolves the destination, the title riding along the rewrite', () => {
    const pages = documentsOf({ 'docs/a.md': 'See [the decision](decisions/d.md "the decision") here.\n', 'docs/decisions/d.md': 'Decision.\n' });
    expect(pageOf(pages, 'docs/a.md').links).toEqual([{ written: 'decisions/d.md', kind: 'page', pageId: 'document/docs/decisions/d' }]);
    expect(renderDocumentBody(pageOf(pages, 'docs/a.md'), REWRITER)).toBe(
      '# a\n\nSee [the decision](/document/docs/decisions/d/ "the decision") here.\n',
    );
    expect(renderDocumentBody(pageOf(pages, 'docs/a.md'), starlightLinks)).toBe(
      '# a\n\nSee [the decision](/documents/docs/decisions/d/ "the decision") here.\n',
    );
  });

  test('an angle-bracket destination resolves, its brackets kept or retaken as the URL needs', () => {
    const pages = documentsOf({ 'docs/a.md': 'See [the page](<b c.md>) and ![Logo](<img/my logo.png>).\n', 'docs/b c.md': 'B.\n', 'docs/img/my logo.png': 'png' });
    expect(pageOf(pages, 'docs/a.md').links).toEqual([
      { written: 'b c.md', kind: 'page', pageId: 'document/docs/b c' },
      { written: 'img/my logo.png', kind: 'image', filePath: 'docs/img/my logo.png' },
    ]);
    // A URL a bare destination could not carry — it holds a space — goes
    // back inside angle brackets, on both writers; one a bare destination
    // carries stays bare.
    expect(renderDocumentBody(pageOf(pages, 'docs/a.md'), REWRITER)).toBe(
      '# a\n\nSee [the page](</document/docs/b c/>) and ![Logo](</assets/documents/docs/img/my logo.png>).\n',
    );
    expect(renderDocumentBody(pageOf(pages, 'docs/a.md'), starlightLinks)).toBe(
      '# a\n\nSee [the page](/documents/docs/b-c/) and ![Logo](</assets/documents/docs/img/my logo.png>).\n',
    );
  });

  test('a reference-style link resolves at its definition, the use left to the engine', () => {
    const body = 'See [the decision][d1] and ![Logo][logo].\n\n[d1]: decisions/d.md\n[logo]: img/overview.png\n';
    const pages = documentsOf({ 'docs/a.md': body, 'docs/decisions/d.md': 'D.\n', 'docs/img/overview.png': 'png' });
    expect(pageOf(pages, 'docs/a.md').links).toEqual([
      { written: 'decisions/d.md', kind: 'page', pageId: 'document/docs/decisions/d' },
      { written: 'img/overview.png', kind: 'image', filePath: 'docs/img/overview.png' },
    ]);
    expect(documentImages(pages)).toEqual(['docs/img/overview.png']);
    // The definition's destination is what the engines render the use
    // from: rewritten there, the uses stand as written.
    expect(renderDocumentBody(pageOf(pages, 'docs/a.md'), REWRITER)).toBe(
      '# a\n\nSee [the decision][d1] and ![Logo][logo].\n\n[d1]: /document/docs/decisions/d/\n[logo]: /assets/documents/docs/img/overview.png\n',
    );
    expect(renderDocumentBody(pageOf(pages, 'docs/a.md'), starlightLinks)).toBe(
      '# a\n\nSee [the decision][d1] and ![Logo][logo].\n\n[d1]: /documents/docs/decisions/d/\n[logo]: /assets/documents/docs/img/overview.png\n',
    );
  });

  test('a reference definition with its destination on the next line is a definition like any other', () => {
    const pages = documentsOf({
      'docs/a.md': 'Use [x][r].\n\n[r]:\n  decisions/d.md\n  "the decision"\n',
      'docs/decisions/d.md': 'D.\n',
    });
    expect(pageOf(pages, 'docs/a.md').links).toEqual([{ written: 'decisions/d.md', kind: 'page', pageId: 'document/docs/decisions/d' }]);
    // The destination is rewritten where it stands, the indent and the
    // title riding along, so the engines still read one definition.
    expect(renderDocumentBody(pageOf(pages, 'docs/a.md'), REWRITER)).toBe(
      '# a\n\nUse [x][r].\n\n[r]:\n  /document/docs/decisions/d/\n  "the decision"\n',
    );
  });

  test('a split definition to a missing document leads to the host, named at the definition line', () => {
    const pages = documentsOf({ 'docs/a.md': 'Use [x][r].\n\n[r]:\n  missing.md\n' }, GITHUB);
    expect(pageOf(pages, 'docs/a.md').links).toEqual([
      { written: 'missing.md', kind: 'host', url: 'https://github.com/acme/shop/blob/c0ffee0/docs/missing.md', target: 'docs/missing.md', line: 3, missing: true },
    ]);
  });

  test('a reference definition to a missing document leads to the host, named at the definition line', () => {
    const pages = documentsOf({ 'docs/a.md': 'Text.\n\n[x][ref]\n\n[ref]: missing.md\n' }, GITHUB);
    expect(pageOf(pages, 'docs/a.md').links).toEqual([
      { written: 'missing.md', kind: 'host', url: 'https://github.com/acme/shop/blob/c0ffee0/docs/missing.md', target: 'docs/missing.md', line: 5, missing: true },
    ]);
  });

  test('a root-relative link names a repository path from the root', () => {
    const pages = documentsOf({
      'README.md': '# Read me\n\n[Guide](/docs/guide.md), ![Logo](/logo.png)\n',
      'docs/guide.md': 'Guide.\n',
      'docs/a.md': '# A\n\n[Guide](/docs/guide.md)\n',
      'logo.png': 'png bytes',
    });
    expect(pageOf(pages, 'README.md').links).toEqual([
      { written: '/docs/guide.md', kind: 'page', pageId: 'document/docs/guide' },
      { written: '/logo.png', kind: 'image', filePath: 'logo.png' },
    ]);
    // From a document in a folder, too: `/docs/guide.md` names
    // `docs/guide.md` from the root, wherever the link's document sits.
    expect(pageOf(pages, 'docs/a.md').links).toEqual([{ written: '/docs/guide.md', kind: 'page', pageId: 'document/docs/guide' }]);
    expect(documentImages(pages)).toEqual(['logo.png']);
  });

  test('an image anywhere inside the repository is copied: the README logo beside the model', () => {
    const pages = documentsOf({ 'README.md': '# Read me\n\n![logo](logo.png)\n', 'logo.png': 'png bytes' });
    expect(pageOf(pages, 'README.md').links).toEqual([{ written: 'logo.png', kind: 'image', filePath: 'logo.png' }]);
    expect(documentImages(pages)).toEqual(['logo.png']);
  });

  test('an empty destination is kept, for the built-site link check to judge', () => {
    const pages = documentsOf({ 'docs/a.md': '# A\n\n[Here]()\n' });
    expect(pageOf(pages, 'docs/a.md').links).toEqual([{ written: '', kind: 'keep' }]);
  });

  test('the links a document shows as text or links away are named in line order', () => {
    const pages = documentsOf({ 'docs/a.md': '# A\n\n[First](first-gone.md)\n\nText.\n\n[Second](second-gone.md)\n' }, GITHUB);
    expect(documentLinkWarnings(pages, GITHUB).map((warning) => [warning.line, warning.written])).toEqual([
      [3, 'first-gone.md'],
      [7, 'second-gone.md'],
    ]);
  });

  test('an image link that leaves the repository is shown as text, never copied', () => {
    const pages = documentsOf({ 'docs/a.md': '# A\n\n![x](../../evil.png)\n', 'evil.png': 'png' }, GITHUB);
    expect(pageOf(pages, 'docs/a.md').links).toEqual([{ written: '../../evil.png', kind: 'text', target: '../evil.png', reason: 'escapes-repository', line: 3 }]);
    expect(documentImages(pages)).toEqual([]);
  });

  test('external links, anchors and protocol-relative links are left as written', () => {
    const pages = documentsOf({
      'docs/a.md': '# A\n\n[Site](https://example.com), [Mail](mailto:a@b.c), [Here](#a), [Other](//host/x)\n',
    });
    expect(pageOf(pages, 'docs/a.md').links).toEqual([
      { written: 'https://example.com', kind: 'keep' },
      { written: 'mailto:a@b.c', kind: 'keep' },
      { written: '#a', kind: 'keep' },
      { written: '//host/x', kind: 'keep' },
    ]);
  });

  test('a link whose scheme the wiki does not keep is refused, never kept', () => {
    const pages = documentsOf({
      'docs/a.md':
        '# A\n\n[Run](javascript:alert(1)), [Case](JaVaScRiPt:alert(1)), [Data](data:text/html;base64,PGI+), [File]( file:///etc/passwd ), [Vb](vbscript:x), ![Logo](vbscript:y)\n',
    });
    // Only http, https and mailto are kept; every other scheme, in any
    // case, with the spaces a destination may carry, is refused: shown as
    // text, warned about by the build, never a link of the built site.
    expect(pageOf(pages, 'docs/a.md').links).toEqual([
      { written: 'javascript:alert(1)', kind: 'refused', line: 3 },
      { written: 'JaVaScRiPt:alert(1)', kind: 'refused', line: 3 },
      { written: 'data:text/html;base64,PGI+', kind: 'refused', line: 3 },
      { written: 'file:///etc/passwd', kind: 'refused', line: 3 },
      { written: 'vbscript:x', kind: 'refused', line: 3 },
      { written: 'vbscript:y', kind: 'refused', line: 3 },
    ]);
  });

  test('a query string is dropped when a document link resolves', () => {
    const pages = documentsOf({
      'docs/a.md': '# A\n\n[B](b.md?v=2)\n',
      'docs/b.md': 'B\n',
    });
    expect(pageOf(pages, 'docs/a.md').links).toEqual([{ written: 'b.md?v=2', kind: 'page', pageId: 'document/docs/b' }]);
  });

  test('links inside code fences and code spans are not links', () => {
    const pages = documentsOf({
      'docs/a.md': ['# A', '', '```text', 'not a link: [fake](also-missing.md)', '```', '', 'Inline `[fake](gone.md)` stays text.', ''].join('\n'),
    });
    expect(pageOf(pages, 'docs/a.md').links).toEqual([]);
  });

  test('a document that cannot be read is refused with its full path', () => {
    const root = writeRepo({ 'docs/secret.md': 'hidden\n' });
    chmodSync(join(root, 'docs', 'secret.md'), 0o000);
    try {
      expect(() => documentPages(root)).toThrow(join(root, 'docs', 'secret.md'));
    } finally {
      chmodSync(join(root, 'docs', 'secret.md'), 0o644);
    }
  });

  test('the same repository gives the same pages twice', () => {
    const files = { 'README.md': '# Read me\n', 'docs/a.md': '# A\n\n[B](b.md)\n', 'docs/b.md': 'B\n' };
    expect(documentPages(writeRepo(files))).toEqual(documentPages(writeRepo(files)));
  });

  test('a refused link whose label wraps over lines is among the refused links, at the line the link starts on', () => {
    const pages = documentsOf({ 'docs/wrapped.md': '# Wrapped\n\nDo [run\nthis](javascript:alert(1)) now.\n' });
    const page = pageOf(pages, 'docs/wrapped.md');
    expect(page.links).toEqual([]);
    expect(page.refusedWrapped).toEqual([{ written: 'javascript:alert(1)', line: 3 }]);
    expect(refusedDocumentLinks(pages)).toEqual([{ source: 'docs/wrapped.md', line: 3, written: 'javascript:alert(1)' }]);
  });
});

describe("document links to the repository's host", () => {
  test("a link to an existing file outside the documents leads to the repository's host, both writers emitting the URL unchanged", () => {
    const pages = documentsOf({ 'docs/guide.md': '[Code](../src/app.ts)\n', 'src/app.ts': 'export {};\n' }, GITHUB);
    expect(pageOf(pages, 'docs/guide.md').links).toEqual([
      { written: '../src/app.ts', kind: 'host', url: 'https://github.com/acme/shop/blob/c0ffee0/src/app.ts', target: 'src/app.ts', line: 1, missing: false },
    ]);
    // No rewrite through page paths: the full address stands as the
    // destination, whatever writer renders the body.
    expect(renderDocumentBody(pageOf(pages, 'docs/guide.md'), REWRITER)).toBe(
      '# guide\n\n[Code](https://github.com/acme/shop/blob/c0ffee0/src/app.ts)\n',
    );
    expect(renderDocumentBody(pageOf(pages, 'docs/guide.md'), starlightLinks)).toBe(
      '# guide\n\n[Code](https://github.com/acme/shop/blob/c0ffee0/src/app.ts)\n',
    );
  });

  test('a folder the repository holds links to its tree, a file to its blob', () => {
    const pages = documentsOf({ 'docs/guide.md': '[Src](../src), [Code](../src/app.ts)\n', 'src/app.ts': 'export {};\n' }, GITHUB);
    expect(pageOf(pages, 'docs/guide.md').links.map((link) => link.url)).toEqual([
      'https://github.com/acme/shop/tree/c0ffee0/src',
      'https://github.com/acme/shop/blob/c0ffee0/src/app.ts',
    ]);
  });

  test('a github origin is read in its ssh forms, the .git suffix dropped', () => {
    for (const origin of ['git@github.com:acme/shop.git', 'ssh://git@github.com/acme/shop.git', 'ssh://git@github.com:22/acme/shop.git', 'https://github.com/acme/shop']) {
      const pages = documentsOf({ 'docs/guide.md': '[Code](../src/app.ts)\n', 'src/app.ts': 'export {};\n' }, { commit: 'c0ffee0', origin });
      expect(pageOf(pages, 'docs/guide.md').links[0]!.url).toBe('https://github.com/acme/shop/blob/c0ffee0/src/app.ts');
    }
  });

  test('a gitlab origin links through its -/blob and -/tree addresses', () => {
    const pages = documentsOf(
      { 'docs/guide.md': '[Src](../src), [Code](../src/app.ts)\n', 'src/app.ts': 'export {};\n' },
      { commit: 'c0ffee0', origin: 'https://gitlab.com/acme/shop.git' },
    );
    expect(pageOf(pages, 'docs/guide.md').links.map((link) => link.url)).toEqual([
      'https://gitlab.com/acme/shop/-/tree/c0ffee0/src',
      'https://gitlab.com/acme/shop/-/blob/c0ffee0/src/app.ts',
    ]);
  });

  test('an anchor rides the full address, unslugged', () => {
    const pages = documentsOf({ 'docs/guide.md': '[Code](../src/app.ts#section)\n', 'src/app.ts': 'export {};\n' }, GITHUB);
    expect(pageOf(pages, 'docs/guide.md').links[0]!.url).toBe('https://github.com/acme/shop/blob/c0ffee0/src/app.ts#section');
  });

  test('a target the repository does not hold is linked to the host all the same, and named in a warning', () => {
    const pages = documentsOf({ 'docs/guide.md': '[Missing](missing.md)\n' }, GITHUB);
    expect(pageOf(pages, 'docs/guide.md').links).toEqual([
      { written: 'missing.md', kind: 'host', url: 'https://github.com/acme/shop/blob/c0ffee0/docs/missing.md', target: 'docs/missing.md', line: 1, missing: true },
    ]);
    expect(documentLinkWarnings(pages, GITHUB)).toEqual([
      { source: 'docs/guide.md', line: 1, written: 'missing.md', why: 'docs/missing.md is not in the repository; linked to the host' },
    ]);
  });

  test('a path that climbs out of the repository is shown as text, and warned about', () => {
    const pages = documentsOf({ 'docs/guide.md': '[Beyond](../../beyond.md)\n' }, GITHUB);
    expect(pageOf(pages, 'docs/guide.md').links).toEqual([
      { written: '../../beyond.md', kind: 'text', target: '../beyond.md', reason: 'escapes-repository', line: 1 },
    ]);
    expect(renderDocumentBody(pageOf(pages, 'docs/guide.md'), REWRITER)).toBe('# guide\n\n\\[Beyond](../../beyond.md)\n');
    expect(documentLinkWarnings(pages, GITHUB)).toEqual([
      { source: 'docs/guide.md', line: 1, written: '../../beyond.md', why: '../beyond.md climbs out of the repository; the link is shown as text' },
    ]);
  });

  test('a repository without an origin shows the link as text, and warns', () => {
    const pages = documentsOf({ 'docs/guide.md': '[Code](../src/app.ts)\n', 'src/app.ts': 'export {};\n' });
    expect(pageOf(pages, 'docs/guide.md').links).toEqual([
      { written: '../src/app.ts', kind: 'text', target: 'src/app.ts', reason: 'no-origin', line: 1 },
    ]);
    expect(documentLinkWarnings(pages)).toEqual([
      {
        source: 'docs/guide.md',
        line: 1,
        written: '../src/app.ts',
        why: 'src/app.ts is not a page of this wiki and the repository has no origin to link to; the link is shown as text',
      },
    ]);
  });

  test('an origin on a host the wiki does not link to shows the link as text, and warns naming the origin', () => {
    const host: DocumentHost = { commit: 'c0ffee0', origin: 'https://bitbucket.org/acme/shop.git' };
    const pages = documentsOf({ 'docs/guide.md': '[Code](../src/app.ts)\n', 'src/app.ts': 'export {};\n' }, host);
    expect(pageOf(pages, 'docs/guide.md').links).toEqual([
      { written: '../src/app.ts', kind: 'text', target: 'src/app.ts', reason: 'unlinked-host', line: 1 },
    ]);
    expect(documentLinkWarnings(pages, host)).toEqual([
      {
        source: 'docs/guide.md',
        line: 1,
        written: '../src/app.ts',
        why: 'src/app.ts is not a page of this wiki and the origin https://bitbucket.org/acme/shop.git is not a host the wiki links to; the link is shown as text',
      },
    ]);
  });
});

describe('documents and images that leave the repository', () => {
  const refused = (root: string, file: string, pointsAt: string): void => {
    expect(() => documentPages(root)).toThrow(`${join(root, file)} is a symlink to ${pointsAt}`);
  };

  test('a README that is a symlink out of the repository is refused, naming the file and where it points', () => {
    const root = writeRepo({ 'docs/a.md': '# A\n' });
    const outside = tempFolder('madarch-wiki-outside-');
    writeFileSync(join(outside, 'secret.md'), 'stolen\n');
    symlinkSync(join(outside, 'secret.md'), join(root, 'README.md'));
    refused(root, 'README.md', join(outside, 'secret.md'));
  });

  test('a docs document that is a symlink out of the repository is refused, naming the file and where it points', () => {
    const root = writeRepo({ 'README.md': '# Read me\n' });
    const outside = tempFolder('madarch-wiki-outside-');
    writeFileSync(join(outside, 'secret.md'), 'stolen\n');
    mkdirSync(join(root, 'docs'), { recursive: true });
    symlinkSync(join(outside, 'secret.md'), join(root, 'docs', 'leak.md'));
    refused(root, join('docs', 'leak.md'), join(outside, 'secret.md'));
  });

  test('the review report that is a symlink out of the repository is refused, naming the file and where it points', () => {
    const root = writeRepo({ 'README.md': '# Read me\n' });
    const outside = tempFolder('madarch-wiki-outside-');
    writeFileSync(join(outside, 'secret.md'), 'stolen\n');
    mkdirSync(join(root, 'madarch'), { recursive: true });
    symlinkSync(join(outside, 'secret.md'), join(root, 'madarch', 'review.md'));
    refused(root, join('madarch', 'review.md'), join(outside, 'secret.md'));
  });

  test('a referenced image that is a symlink out of the repository is refused, naming the file and where it points', () => {
    const root = writeRepo({ 'docs/a.md': '# A\n\n![Logo](img/logo.png)\n' });
    const outside = tempFolder('madarch-wiki-outside-');
    writeFileSync(join(outside, 'stolen.png'), 'png');
    mkdirSync(join(root, 'docs', 'img'), { recursive: true });
    symlinkSync(join(outside, 'stolen.png'), join(root, 'docs', 'img', 'logo.png'));
    expect(() => documentPages(root)).toThrow(`${join(root, 'docs', 'img', 'logo.png')} is a symlink to ${join(outside, 'stolen.png')}`);
  });

  test('a symlink whose real path is inside the repository is followed', () => {
    const root = writeRepo({ 'docs/readme-real.md': '# Real read me\n' });
    symlinkSync(join(root, 'docs', 'readme-real.md'), join(root, 'README.md'));
    const pages = documentPages(root);
    expect(pageOf(pages, 'README.md').body).toBe('# Real read me\n');
  });

  test('a symlinked document under docs/ is found and followed inside the repository', () => {
    const root = writeRepo({ 'docs/real.md': '# Real document\n' });
    symlinkSync('real.md', join(root, 'docs', 'alias.md'));
    const pages = documentPages(root);
    expect(pageOf(pages, join('docs', 'alias.md')).body).toBe('# Real document\n');
  });
});

describe('document titles', () => {
  test('a document without a level-1 heading takes its title from its first heading', () => {
    const pages = documentsOf({ 'docs/a.md': 'Intro.\n\n## Context\n\nBody.\n' });
    expect(pageOf(pages, 'docs/a.md').title).toBe('Context');
    expect(pageOf(pages, 'docs/a.md').insertTitle).toBe(false);
  });

  test('the first heading counts wherever the document puts it, fences and code spans aside', () => {
    const pages = documentsOf({
      'docs/a.md': ['```text', '# not a heading', '```', '', '## Real heading', ''].join('\n'),
      'docs/b.md': '# B\n',
    });
    expect(pageOf(pages, 'docs/a.md').title).toBe('Real heading');
    expect(pageOf(pages, 'docs/b.md').title).toBe('B');
  });
});

describe('scanDocument', () => {
  test('one scan finds the headings, the links and the mermaid fences', () => {
    const body = [
      '# Title',
      '',
      'See [other](other.md) and ![image](img.png).',
      '',
      '```mermaid',
      'flowchart LR',
      '  A[One] --> B[Two]',
      '```',
      '',
      '## Second: heading',
      '',
      '```text',
      '[not a link](x.md)',
      '```',
    ].join('\n');
    const scan = scanDocument(body);
    expect(scan.headings).toEqual([
      { level: 1, text: 'Title' },
      { level: 2, text: 'Second: heading' },
    ]);
    expect(scan.links.map((link) => link.written)).toEqual(['other.md', 'img.png']);
    // A mermaid fence's position covers the whole fence, source and all, so
    // the writers can replace it in place.
    expect(scan.mermaid).toEqual([{ source: 'flowchart LR\n  A[One] --> B[Two]', start: body.indexOf('```mermaid'), end: body.indexOf('\n\n## Second') }]);
  });

  test('an autolink the wiki keeps is a region of its own, brackets markup and all', () => {
    const body = 'See [page](page.md) and <https://example.com/x> and <a@b.c>.\n';
    const scan = scanDocument(body);
    expect(scan.links.map((link) => link.written)).toEqual(['page.md']);
    expect(scan.autolinks.map((span) => body.slice(span.start, span.end))).toEqual(['<https://example.com/x>', '<a@b.c>']);
  });

  test('every link occurrence is found, images and plain links alike', () => {
    const scan = scanDocument('[a](x.md) then ![b](y.png) then [c](z.md)\n');
    expect(scan.links.map((link) => link.written)).toEqual(['x.md', 'y.png', 'z.md']);
    // The positions delimit the URL inside the parentheses, for the writers'
    // in-place rewrite.
    const body = '[a](x.md) then ![b](y.png)\n';
    const scan2 = scanDocument(body);
    expect(body.slice(scan2.links[0]!.start, scan2.links[0]!.end)).toBe('x.md');
    expect(body.slice(scan2.links[1]!.start, scan2.links[1]!.end)).toBe('y.png');
  });

  test('a definition with its destination on the next line is an occurrence at the definition', () => {
    const body = 'Use [x][r].\n\n[r]:\n  b.md\n';
    const scan = scanDocument(body);
    expect(scan.links.map((link) => [link.written, link.line])).toEqual([['b.md', 3]]);
    expect(body.slice(scan.links[0]!.start, scan.links[0]!.end)).toBe('b.md');
  });

  test('a line after a bare `[label]:` that is no destination starts no definition', () => {
    expect(scanDocument('[r]:\n- item\n').links).toEqual([]);
    expect(scanDocument('[r]:\n## Heading\n').links).toEqual([]);
  });

  test('a title is no part of the destination, and an angle destination spans its brackets', () => {
    const body = '[a](b.md "t") ![c](<d e.md>)\n';
    const scan = scanDocument(body);
    expect(scan.links.map((link) => link.written)).toEqual(['b.md', 'd e.md']);
    expect(body.slice(scan.links[0]!.start, scan.links[0]!.end)).toBe('b.md');
    expect(body.slice(scan.links[1]!.start, scan.links[1]!.end)).toBe('<d e.md>');
  });

  test('a link reference definition is an occurrence with its line, a use is none', () => {
    const scan = scanDocument('[text][ref]\n\n[ref]: b.md\n');
    expect(scan.links.map((link) => [link.written, link.line])).toEqual([['b.md', 3]]);
  });

  test('a refused link whose label wraps over lines is recorded once, at the line the link starts on', () => {
    const scan = scanDocument('Do [run\nthis](javascript:alert(1)) now.\n');
    expect(scan.links).toEqual([]);
    expect(scan.refusedWrapped).toEqual([{ written: 'javascript:alert(1)', line: 1 }]);
  });

  test('only refused schemes are recorded for a wrapped label, and a single-line link never is', () => {
    const scan = scanDocument('[one](javascript:alert(1)) then [a\nb](https://example.com) and [c\nd](vbscript:x)\n');
    expect(scan.links.map((link) => link.written)).toEqual(['javascript:alert(1)']);
    expect(scan.refusedWrapped).toEqual([{ written: 'vbscript:x', line: 2 }]);
  });

  test('a label wrapping over several lines is named at the line the link starts on', () => {
    expect(scanDocument('Do [run\nthe\nthing](javascript:alert(1)) now.\n').refusedWrapped).toEqual([
      { written: 'javascript:alert(1)', line: 1 },
    ]);
  });

  test('a blank line or a destination that names no refused scheme warns nothing', () => {
    expect(scanDocument('Do [run\n\nthis](javascript:alert(1)) now.\n').refusedWrapped).toEqual([]);
    expect(scanDocument('Do [run\nthis](alert(1)) now.\n').refusedWrapped).toEqual([]);
  });

  test('documentHeadings adds the inserted title line to the body\'s own headings', () => {
    const [page] = documentPages(writeRepo({ 'docs/a.md': 'Body only.\n' }));
    expect(documentHeadings(page!)).toEqual(['a']);
    const [titled] = documentPages(writeRepo({ 'docs/b.md': '## Context\n' }));
    expect(documentHeadings(titled!)).toEqual(['Context']);
  });
});

describe('renderDocumentBody', () => {
  test('the prose is copied as it is apart from the rewrites, its raw markup escaped', () => {
    const body = ['# Architecture', '', 'A map {a, b} and a type <T> stay literal.', '', '| Table | Header |', '| --- | --- |', '| a | b |', ''].join('\n');
    expect(rewrite(body)).toBe(body.replace('<T>', '&lt;T>'));
  });

  test('a document link is rewritten to the writer\'s path, its anchor slugged', () => {
    expect(rewrite('See [the decision](<decisions/0001-x.md#More detail>) here.\n', { 'docs/decisions/0001-x.md': 'Decision.\n' })).toBe(
      '# doc\n\nSee [the decision](/document/docs/decisions/0001-x/#more-detail) here.\n',
    );
  });

  test('an image link is rewritten to the document asset route, on both writers', () => {
    expect(documentImageRoute('docs/img/overview.png')).toBe('/assets/documents/docs/img/overview.png');
    expect(rewrite('![Overview](img/overview.png)\n', { 'docs/img/overview.png': 'png bytes' })).toBe(
      '# doc\n\n![Overview](/assets/documents/docs/img/overview.png)\n',
    );
  });

  test('a mermaid block is drawn by the shipped runtime, not left as code', () => {
    const out = rewrite('```mermaid\nflowchart LR\n  A[One] --> B[Two]\n```\n');
    expect(out).toBe('# doc\n\n<div class="mermaid">\nflowchart LR\n  A[One] --&gt; B[Two]\n</div>\n');
  });

  test('raw HTML in a document is shown as text, not markup', () => {
    const out = rewrite('Before.\n\n<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n<T>\n');
    expect(out).toBe('# doc\n\nBefore.\n\n&lt;script>alert(1)&lt;/script>\n\n&lt;img src=x onerror="alert(2)">\n\n&lt;T>\n');
    expect(out.includes('<script')).toBe(false);
    expect(out.includes('<img')).toBe(false);
  });

  test('a link whose scheme the wiki does not keep is shown as text, never a link', () => {
    expect(rewrite('Do [run](javascript:alert(1)) and ![see](vbscript:msgbox) now.\n')).toBe(
      '# doc\n\nDo \\[run\\](javascript:alert(1)) and !\\[see\\](vbscript:msgbox) now.\n',
    );
    // An angle-bracket destination of a refused scheme is text too: its
    // `<` is escaped, so no engine reads an autolink out of it either.
    expect(rewrite('[x](<javascript:alert(1)>)\n')).toBe('# doc\n\n\\[x](&lt;javascript:alert(1)>)\n');
  });

  test('a refused link whose label wraps to its destination line is text too', () => {
    expect(rewrite('Do [run\nthis](javascript:alert(1)) now.\n')).toBe('# doc\n\nDo [run\nthis\\](javascript:alert(1)) now.\n');
  });

  test('an autolink is markup again: a kept scheme renders as a link, a refused one as text', () => {
    const body = 'See <https://example.com> and <mailto:a@b.c> and <a@b.c>.\n';
    expect(rewrite(body)).toBe(`# doc\n\n${body}`);
    expect(rewrite('No <javascript:alert(1)> here.\n')).toBe('# doc\n\nNo &lt;javascript:alert(1)> here.\n');
  });

  test('a refused reference definition stops being one, its uses plain text', () => {
    expect(rewrite('Use [x][r].\n\n[r]: javascript:alert(1)\n')).toBe('# doc\n\nUse [x][r].\n\n\\[r]: javascript:alert(1)\n');
  });

  test('a code span on a later line is spared by its true position, not by accident', () => {
    const body = 'First line.\n\nSecond line has `<script>x</script>` inline.\n';
    expect(rewrite(body)).toBe(`# doc\n\n${body}`);
  });

  test('a code span spares only its own extent: markup before it on the same line is still escaped', () => {
    const body = 'A <T> and `<script>x</script>` here.\n';
    expect(rewrite(body)).toBe('# doc\n\nA &lt;T> and `<script>x</script>` here.\n');
  });
  test('HTML inside code spans and fences stays code, for the engine to escape', () => {
    const body = 'Inline `<script>x</script>` stays code.\n\n```html\n<script>alert(1)</script>\n```\n';
    expect(rewrite(body)).toBe(`# doc\n\n${body}`);
  });

  test('a link target keeps its angle brackets', () => {
    expect(rewrite('[Site](https://example.com/a>b) here.\n')).toBe('# doc\n\n[Site](https://example.com/a>b) here.\n');
  });

  test('a titleless document gets its title line above the body', () => {
    const [page] = documentPages(writeRepo({ 'docs/0001-x.md': 'Decision text.\n' }));
    expect(renderDocumentBody(page!, REWRITER)).toBe('# 0001-x\n\nDecision text.\n');
  });

  test('the diagram module draws the document\'s own Mermaid blocks at load, outside any tabs', () => {
    // A document page has no .wiki-diagram holder, so the module must draw
    // whatever is visible when it loads — the block a browser walk proves.
    expect(diagramModuleJs('../assets/mermaid/mermaid.esm.min.mjs').trimEnd().endsWith('drawVisible();')).toBe(true);
  });

  test('the diagram module initialises Mermaid with strict security', () => {
    expect(diagramModuleJs('../assets/mermaid/mermaid.esm.min.mjs')).toContain("securityLevel: 'strict'");
  });

  test('a titled document is not given a second title', () => {
    const [page] = documentPages(writeRepo({ 'docs/a.md': '# A\n\nText.\n' }));
    expect(renderDocumentBody(page!, REWRITER)).toBe('# A\n\nText.\n');
  });
});

describe('the shipped Mermaid draws under strict security', () => {
  const decodeLabel = (label: string): string =>
    label
      .replace(/#(quot|amp|lt|gt);/g, (code) => ({ '#quot;': '"', '#amp;': '&', '#lt;': '<', '#gt;': '>' })[code]!)
      .replace(/#(\d+);/g, (_, digits) => String.fromCodePoint(Number(digits)));

  test('every label of the view pages survives the sanitizer that strict security runs its labels through', async () => {
    GlobalRegistrator.register();
    try {
      // happy-dom's globals must sit before the first import: DOMPurify
      // reads the window when it loads, the same way mermaid-check does.
      const { default: DOMPurify } = await import('dompurify');
      const folder = fileURLToPath(new URL('../examples/reference-system/views/mermaid', import.meta.url));
      const labels = new Set<string>();
      for (const page of readdirSync(folder).filter((name) => name.endsWith('.md'))) {
        const diagram = readFileSync(join(folder, page), 'utf8').split('```mermaid')[1]!.split('```')[0]!;
        for (const match of diagram.matchAll(/"([^"\n]+)"/g)) labels.add(decodeLabel(match[1]!));
      }
      expect(labels.size).toBeGreaterThan(10);
      expect([...labels].filter((label) => DOMPurify.sanitize(label) !== label)).toEqual([]);
    } finally {
      await GlobalRegistrator.unregister();
    }
  });
});

describe('the navigation keeps the folders', () => {
  const page = (id: string, title: string, nav: readonly string[]): AnyWikiPage =>
    ({ id, title, nav, blocks: [] }) as unknown as WikiPage;

  test('documents nest one group per folder under the Documents section', () => {
    const tree = navTree([
      page('document/README', 'Read me', ['Documents']),
      page('document/docs/architecture', 'Architecture', ['Documents', 'docs']),
      page('document/docs/decisions/0001-x', '0001-x', ['Documents', 'docs', 'decisions']),
      page('document/madarch/review', 'Review', ['Documents', 'madarch']),
    ]);
    expect(tree).toEqual([
      {
        title: 'Documents',
        entries: [
          { title: 'Read me', path: 'documents/README.md' },
          {
            title: 'docs',
            children: [
              { title: 'Architecture', path: 'documents/docs/architecture.md' },
              { title: 'decisions', children: [{ title: '0001-x', path: 'documents/docs/decisions/0001-x.md' }] },
            ],
          },
          { title: 'madarch', children: [{ title: 'Review', path: 'documents/madarch/review.md' }] },
        ],
      },
    ]);
  });

  test('model pages keep their flat and one-group shapes', () => {
    const tree = navTree([
      page('domain/ordering', 'Ordering', ['Domains']),
      page('element/checkout', 'Checkout', ['Domains', 'Ordering']),
      page('zones', 'Zones', ['Zones']),
      page('zone/internal', 'Internal', ['Zones']),
    ]);
    expect(tree).toEqual([
      {
        title: 'Domains',
        entries: [
          {
            title: 'Ordering',
            children: [
              { title: 'Ordering', path: 'domains/ordering.md' },
              { title: 'Checkout', path: 'elements/checkout.md' },
            ],
          },
        ],
      },
      { title: 'Zones', entries: [{ title: 'Zones', path: 'zones.md' }, { title: 'Internal', path: 'zones/internal.md' }] },
    ]);
  });
});
