import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brokenLinks, readSiteFiles, type BrokenLink } from '../src/wiki/links.js';

/**
 * The link checker over a built site (docs/changes/wiki/capabilities/wiki.md,
 * requirement `links`): a pure function from the site's files and their text
 * to every broken internal link, each naming the page and the link as
 * written, all of them, sorted by code point. Links outside the site — a
 * scheme and host, `mailto:`, the engine's own 404 page — are not checked.
 */

const page = (name: string, body: string): [string, string] => [name, body];

function pairs(broken: readonly BrokenLink[]): [string, string][] {
  return broken.map((entry) => [entry.page, entry.link]);
}

describe('brokenLinks', () => {
  test('a site whose links all land is clean', () => {
    const files = new Map<string, string>([
      page(
        'index.html',
        [
          '<html><body>',
          '<a href="./guide/">the guide</a>',
          '<a href="./guide/#intro">intro</a>',
          '<a href="">self</a>',
          '<a href="#">top</a>',
          '<script src="./assets/site.js"></script>',
          '<link rel="stylesheet" href="./assets/site.css">',
          '<img src="./logo.png">',
          '</body></html>',
        ].join('\n'),
      ),
      page('guide/index.html', '<h1 id="intro">Guide</h1>'),
      page('assets/site.js', 'console.log(1)'),
      page('assets/site.css', 'body{}'),
      page('logo.png', 'png-bytes'),
    ]);
    expect(brokenLinks(files)).toEqual([]);
  });

  test('a link to a missing file names the page and the link as written', () => {
    const files = new Map<string, string>([
      page('index.html', '<a href="./ghost/">ghost</a><script src="./missing.js"></script>'),
      page('real/index.html', 'real'),
    ]);
    expect(brokenLinks(files)).toEqual([
      { page: 'index.html', link: './ghost/', problem: 'no file "ghost/index.html" in the site' },
      { page: 'index.html', link: './missing.js', problem: 'no file "missing.js" in the site' },
    ]);
  });

  test('a link to a missing anchor names the page, the link and the anchor', () => {
    const files = new Map<string, string>([
      page('index.html', '<a href="./guide/#nope">guide</a>'),
      page('guide/index.html', '<h1 id="real">Guide</h1>'),
    ]);
    expect(brokenLinks(files)).toEqual([
      { page: 'index.html', link: './guide/#nope', problem: 'no anchor "nope" in "guide/index.html"' },
    ]);
  });

  test('every broken link is named, sorted by code point, not just the first', () => {
    const files = new Map<string, string>([
      page('index.html', '<a href="Zebra/">Z</a> <a href="apple/">a</a> <a href="./ghost/">g</a>'),
      page('sub/page.html', '<a href="../also-gone/">x</a>'),
    ]);
    // Code-point order: "." (46) and "/" sort before "Z" (90) before "a" (97);
    // a locale-aware sort would put "apple" before "Zebra".
    expect(pairs(brokenLinks(files))).toEqual([
      ['index.html', './ghost/'],
      ['index.html', 'Zebra/'],
      ['index.html', 'apple/'],
      ['sub/page.html', '../also-gone/'],
    ]);
  });

  test("the engine's own 404 page is outside the check", () => {
    const files = new Map<string, string>([
      page('404.html', '<a href="/ghost/">gone</a><a href="#nowhere">n</a>'),
      page('index.html', 'home'),
    ]);
    expect(brokenLinks(files)).toEqual([]);
  });

  test('links to other sites, mailto and other schemes are outside the check', () => {
    const files = new Map<string, string>([
      page(
        'index.html',
        [
          '<a href="https://example.com/x">site</a>',
          '<a href="http://example.com">site</a>',
          '<a href="HTTPS://EXAMPLE.COM/UP">site</a>',
          '<a href="mailto:me@example.com">mail</a>',
          '<a href="tel:+123">phone</a>',
          '<a href="javascript:void(0)">do</a>',
          '<a href="data:text/plain,hi">data</a>',
          '<a href="//cdn.example.com/lib.js">cdn</a>',
        ].join('\n'),
      ),
    ]);
    expect(brokenLinks(files)).toEqual([]);
  });

  test('text inside comments, scripts and styles is not link-checked', () => {
    const files = new Map<string, string>([
      page(
        'index.html',
        [
          '<!-- <a href="./commented/">c</a> -->',
          '<script>const snippet = "<a href=\'./scripted/\'>s</a>";</script>',
          '<style>a::after { content: "./styled/"; }</style>',
          '<a href="#real">real anchor</a>',
          '</body>',
        ].join('\n'),
      ),
    ]);
    // only the real link is judged: #real misses, because the page carries no id
    expect(pairs(brokenLinks(files))).toEqual([['index.html', '#real']]);
  });

  test('directory links, root-relative links, query strings and bare names resolve to the built files', () => {
    const files = new Map<string, string>([
      page(
        'deep/nested/page.html',
        [
          '<a href="../../other/">up two</a>',
          '<a href="/assets/pic.png">root-relative</a>',
          '<a href="../../up/">plain</a>',
          '<a href="../../up?v=2">query</a>',
        ].join('\n'),
      ),
      page('other/index.html', 'x'),
      page('assets/pic.png', 'png'),
      page('up/index.html', 'x'),
    ]);
    expect(brokenLinks(files)).toEqual([]);
  });

  test('a link out of the site is broken, not silently external', () => {
    const files = new Map<string, string>([
      page('deep/page.html', '<a href="../../../../escape/">e</a>'),
    ]);
    expect(pairs(brokenLinks(files))).toEqual([['deep/page.html', '../../../../escape/']]);
  });

  test('anchors and paths match after percent-decoding', () => {
    const files = new Map<string, string>([
      page('index.html', '<a href="./my%20notes/#caf%C3%A9">notes</a><a href="./gone%20one/">g</a>'),
      page('my notes/index.html', '<h1 id="café">Notes</h1>'),
    ]);
    expect(pairs(brokenLinks(files))).toEqual([['index.html', './gone%20one/']]);
  });

  test("a same-page anchor link checks the page's own ids", () => {
    const files = new Map<string, string>([
      page('index.html', '<h2 id="here">h</h2><a href="#here">ok</a><a href="#not-there">bad</a>'),
    ]);
    expect(pairs(brokenLinks(files))).toEqual([['index.html', '#not-there']]);
  });

  test('uppercase tags, single quotes and unquoted attribute values are links too, as written', () => {
    const files = new Map<string, string>([
      page(
        'index.html',
        '<A HREF="./upper/">u</A><a href=\'./single/\'>s</a><a id=bare></a><script src=unquoted.js></script>',
      ),
    ]);
    expect(pairs(brokenLinks(files))).toEqual([
      ['index.html', './single/'],
      ['index.html', './upper/'],
      ['index.html', 'unquoted.js'],
    ]);
  });

  test('a value in a quote of the other kind and angled brackets inside values do not end the tag', () => {
    const files = new Map<string, string>([
      page('index.html', '<a title=\'say "hi"\' href="./quoted/">q</a><img alt="a > b" src="./pic.png">'),
      page('quoted/index.html', 'x'),
      page('pic.png', 'png'),
    ]);
    expect(brokenLinks(files)).toEqual([]);
  });

  test('the same broken link twice on one page is reported once', () => {
    const files = new Map<string, string>([
      page('index.html', '<a href="./ghost/">a</a><a href="./ghost/">b</a>'),
    ]);
    expect(brokenLinks(files)).toEqual([
      { page: 'index.html', link: './ghost/', problem: 'no file "ghost/index.html" in the site' },
    ]);
  });

  test("the same links give the same broken links, whatever the map's order", () => {
    const build = (): Map<string, string> =>
      new Map<string, string>([
        page('index.html', '<a href="b/">b</a><a href="a/">a</a>'),
        page('b/index.html', 'x'),
      ]);
    const forward = brokenLinks(build());
    const reversed = brokenLinks(new Map([...build()].reverse()));
    expect(forward).toEqual(reversed);
    expect(pairs(forward)).toEqual([['index.html', 'a/']]);
  });
});

describe('readSiteFiles', () => {
  test('a site folder that does not exist is an error naming the path', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'madarch-links-')), 'no-such-site');
    try {
      readSiteFiles(missing);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain(missing);
    }
  });

  test('an unreadable file in the site is an error naming the file', () => {
    const site = join(mkdtempSync(join(tmpdir(), 'madarch-links-')), 'site');
    mkdirSync(site);
    const file = join(site, 'index.html');
    writeFileSync(file, '<html></html>');
    chmodSync(file, 0o000);
    try {
      readSiteFiles(site);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain(file);
    } finally {
      chmodSync(file, 0o644);
      rmSync(site, { recursive: true, force: true });
    }
  });

  test('reads every file of the site under its site-relative path', () => {
    const site = join(mkdtempSync(join(tmpdir(), 'madarch-links-')), 'site');
    mkdirSync(join(site, 'guide'), { recursive: true });
    writeFileSync(join(site, 'index.html'), '<html>home</html>');
    writeFileSync(join(site, 'guide', 'index.html'), '<html>guide</html>');
    try {
      const files = readSiteFiles(site);
      expect(files.get('index.html')).toBe('<html>home</html>');
      expect(files.get('guide/index.html')).toBe('<html>guide</html>');
      expect(files.size).toBe(2);
    } finally {
      rmSync(site, { recursive: true, force: true });
    }
  });
});
