import { describe, expect, test } from 'bun:test';
import type { PageModel } from '../src/knowledge/model.js';
import { entityAddress } from '../src/knowledge/resolve.js';
import { pageFileAt, pageFileDocument, pageFileMarkdown } from '../src/knowledge/page-files.js';

const prefix = '/products/shop';

const page = (over: Partial<PageModel> = {}): PageModel => ({
  id: 'domain:home',
  kind: 'domain',
  title: 'Home',
  trail: [],
  blocks: [],
  resolutions: {},
  findings: [],
  notes: [],
  ...over,
});

const home = { state: 'ok' as const, target: 'madarch:domain:home', kind: 'domain', label: 'Home', href: entityAddress('domain:home'), entity: 'domain:home' };

describe('a page written for an agent keeps every address it holds', () => {
  test('an ordinary wiki link is written at the product mount, and the Markdown and the JSON name the same address', () => {
    const model = page({
      blocks: [{ type: 'markdown', markdown: 'See [Home](/k/e/domain%3Ahome) and [Shop](https://example.com/shop).' }],
    });
    const markdown = pageFileMarkdown(model, prefix);
    expect(markdown).toContain('[Home](/products/shop/k/e/domain%3Ahome)');
    expect(markdown).toContain('[Shop](https://example.com/shop)');
    expect(markdown).not.toContain('](/k/');
    const document = pageFileDocument(model, prefix);
    expect(document.sections[0]!.links).toEqual([
      { title: 'Home', url: '/products/shop/k/e/domain%3Ahome' },
      { title: 'Shop', url: 'https://example.com/shop' },
    ]);
    // A body that already carries the mount is not mounted twice.
    const mounted = page({ blocks: [{ type: 'markdown', markdown: '[Here](/products/shop/k/e/domain%3Ahome)' }] });
    expect(pageFileMarkdown(mounted, prefix)).toContain('[Here](/products/shop/k/e/domain%3Ahome)');
  });

  test('a reference link and an autolink are resolved through the definitions and written as the addresses they name', () => {
    const markdown = ['See [Home][h] and <madarch:domain:home>.', '', '[h]: madarch:domain:home'].join('\n');
    const model = page({ resolutions: { 'madarch:domain:home': home }, blocks: [{ type: 'markdown', markdown }] });
    const written = pageFileMarkdown(model, prefix);
    expect(written).toContain('[Home](/products/shop/k/e/domain%3Ahome)');
    expect(written).toContain('[madarch:domain:home](/products/shop/k/e/domain%3Ahome)');
    expect(written).not.toContain('](madarch:');
    expect(written).not.toContain('[h]: madarch:');
    const document = pageFileDocument(model, prefix);
    expect(document.sections[0]!.links).toEqual([
      { title: 'Home', url: '/products/shop/k/e/domain%3Ahome', kind: 'domain', id: 'domain:home' },
      { title: 'madarch:domain:home', url: '/products/shop/k/e/domain%3Ahome', kind: 'domain', id: 'domain:home' },
    ]);
    // A reference with no definition is text, not a link, and stays as the author wrote it.
    const dangling = page({ blocks: [{ type: 'markdown', markdown: '[Nope][x]\n\n[x]: https://example.com/x' }] });
    const text = pageFileMarkdown(dangling, prefix);
    expect(text).toContain('[Nope][x]');
    expect(pageFileDocument(dangling, prefix).sections[0]!.links).toEqual([
      { title: 'Nope', url: 'https://example.com/x' },
    ]);
  });

  test('a plain title and a relation label are text, so their backticks and pipes stay the characters they are', () => {
    const model = page({
      title: 'Use `bun` | now',
      blocks: [
        { type: 'related', title: 'Related `things`', groups: [{ relation: 'calls|`x`', direction: 'out', total: 1, rows: [{ entity: { id: 'domain:home', kind: 'domain', label: 'Home', href: entityAddress('domain:home') }, count: 1 }] }] },
        // An authored body is Markdown already: it is written as it was read.
        { type: 'markdown', markdown: 'The `bun` runtime | is fast.' },
      ],
    });
    const markdown = pageFileMarkdown(model, prefix);
    expect(markdown).toContain('# Use \\`bun\\` \\| now');
    expect(markdown).toContain('### calls\\|\\`x\\` (out, 1)');
    expect(markdown).toContain('The `bun` runtime | is fast.');
    expect(markdown).not.toContain('# Use `bun`');
  });

  test('a planned page says how it is planned, never the plan object', () => {
    const task = { id: 'madarch-1', slug: 'one', title: 'One', file: 'tasks/one.md' };
    const model = page({ planned: { entity: { how: 'scope', task }, statements: [], note: undefined } });
    const markdown = pageFileMarkdown(model, prefix);
    expect(markdown).toContain('This page (scope)');
    expect(markdown).not.toContain('[object Object]');
    expect(pageFileDocument(model, prefix).planned).toEqual({ entity: 'scope', statements: [] });
  });

  test('a destination holds no parenthesis that would end the link', () => {
    const odd = { id: 'domain:a)', kind: 'domain', label: 'Odd', href: '/k/e/domain%3Aa)' };
    const model = page({ blocks: [{ type: 'related', title: 'Related', groups: [{ relation: 'calls', direction: 'out', total: 1, rows: [{ entity: odd, count: 1 }] }] }] });
    const markdown = pageFileMarkdown(model, prefix);
    expect(markdown).toContain('(/products/shop/k/e/domain%3Aa%29)');
    expect(pageFileDocument(model, prefix).sections[0]!.groups![0]!.items[0]!.url).toBe('/products/shop/k/e/domain%3Aa)');
    // A product folder whose name holds one is mounted the same way.
    expect(pageFileMarkdown(page({ blocks: [{ type: 'markdown', markdown: '[Home](/k/e/domain%3Ahome)' }] }), '/products/shop)')).toContain('(/products/shop%29/k/e/domain%3Ahome)');
  });

  test('a member reader names the place it reads at, as the JSON does', () => {
    const reader = {
      id: 'code.symbol:src/a.ts#use',
      kind: 'code.symbol',
      label: 'use',
      href: '/k/e/code.symbol%3Asrc%2Fa.ts%23use',
      location: { repo: null, path: 'src/a.ts', lineStart: 4, lineEnd: 4, href: '/k/src?repo=&path=src%2Fa.ts&line=4' },
    };
    const model = page({
      blocks: [{
        type: 'members', title: 'Fields and properties', total: 1,
        rows: [{ entity: { id: 'code.field:src/a.ts#Store.value', kind: 'code.field', label: 'Store.value', href: null }, anchor: 'member-code.field%3Asrc%2Fa.ts%23Store.value', values: [], readers: [reader], writers: [] }],
      }],
    });
    const markdown = pageFileMarkdown(model, prefix);
    expect(markdown).toContain('Read by: [use](/products/shop/k/e/code.symbol%3Asrc%2Fa.ts%23use) — at [src/a.ts:4](/products/shop/k/src?repo=&path=src%2Fa.ts&line=4)');
    const document = pageFileDocument(model, prefix);
    expect(document.sections[0]!.members![0]!.readers[0]).toMatchObject({
      title: 'use',
      url: '/products/shop/k/e/code.symbol%3Asrc%2Fa.ts%23use',
      place: { path: 'src/a.ts', line: 4, url: '/products/shop/k/src?repo=&path=src%2Fa.ts&line=4' },
    });
  });

  test('an id that ends in .md or .json keeps its own HTML address, apart from the file suffix', () => {
    const model = page({ id: 'domain:a.md' });
    const document = pageFileDocument(model, prefix);
    expect(document.address).toBe('/products/shop/k/e/domain%3Aa%2Emd');
    expect(document.markdown).toBe('/products/shop/k/e/domain%3Aa%2Emd.md');
    expect(document.json).toBe('/products/shop/k/e/domain%3Aa%2Emd.json');
    expect(pageFileMarkdown(model, prefix)).toContain('](/products/shop/k/e/domain%3Aa%2Emd)');
    // The file routes read the two apart: the HTML address is not a file, and each file names its own entity.
    expect(pageFileAt('/k/e/domain%3Aa%2Emd')).toBeUndefined();
    expect(pageFileAt('/k/e/domain%3Aa%2Emd.md')).toEqual({ name: 'domain:a.md', format: 'markdown' });
    expect(pageFileAt('/k/e/domain%3Aa.md')).toEqual({ name: 'domain:a', format: 'markdown' });
    expect(entityAddress('domain:a')).toBe('/k/e/domain%3Aa');
  });
});
