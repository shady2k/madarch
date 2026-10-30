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

describe("a history figure is written in the words and the form the reader's language gives it", () => {
  const history = (language: string | undefined, figures: { kind: string; value: string }[]): PageModel => page({
    ...(language === undefined ? {} : { language }),
    blocks: [{ type: 'history', title: 'History', sections: [{ role: 'files', total: 1, rows: [{ text: 'src/a.ts', figures: figures as never }] }], notes: [] }],
  });
  const figures = (language: string | undefined, values: readonly string[]): string[] =>
    values.map((value) => pageFileMarkdown(history(language, [{ kind: 'commits', value }]), prefix).split('\n').find((line) => line.startsWith('- src/a.ts'))!);

  test('English says one commit, two commits and every numeral its own form', () => {
    expect(figures('en', ['0', '1', '2', '5', '11', '12', '14', '21', '101', '1.5'])).toEqual([
      '- src/a.ts — 0 commits',
      '- src/a.ts — 1 commit',
      '- src/a.ts — 2 commits',
      '- src/a.ts — 5 commits',
      '- src/a.ts — 11 commits',
      '- src/a.ts — 12 commits',
      '- src/a.ts — 14 commits',
      '- src/a.ts — 21 commits',
      '- src/a.ts — 101 commits',
      '- src/a.ts — 1.5 commits',
    ]);
  });

  test('Russian says один коммит, два коммита, пять коммитов, and a fraction takes the genitive singular', () => {
    expect(figures('ru', ['0', '1', '2', '5', '11', '12', '14', '21', '101', '1.5', '1.25'])).toEqual([
      '- src/a.ts — 0 коммитов',
      '- src/a.ts — 1 коммит',
      '- src/a.ts — 2 коммита',
      '- src/a.ts — 5 коммитов',
      '- src/a.ts — 11 коммитов',
      '- src/a.ts — 12 коммитов',
      '- src/a.ts — 14 коммитов',
      '- src/a.ts — 21 коммит',
      '- src/a.ts — 101 коммит',
      '- src/a.ts — 1.5 коммита',
      '- src/a.ts — 1.25 коммита',
    ]);
  });

  test('every counted kind is written as words, and a page with no language reads as English', () => {
    const kinds = ['symbols', 'commits', 'files', 'reachable', 'firstParent', 'merges', 'nonMerge', 'authors', 'both', 'onlyThis', 'onlyOther'];
    const line = (language: string | undefined, kind: string, value: string): string =>
      pageFileMarkdown(history(language, [{ kind, value }]), prefix).split('\n').find((held) => held.startsWith('- src/a.ts'))!;
    expect(kinds.map((kind) => line('en', kind, '2'))).toEqual([
      '- src/a.ts — 2 symbols',
      '- src/a.ts — 2 commits',
      '- src/a.ts — 2 files',
      '- src/a.ts — 2 reachable commits',
      '- src/a.ts — 2 first-parent commits',
      '- src/a.ts — 2 merges',
      '- src/a.ts — 2 non-merge commits',
      '- src/a.ts — 2 authors',
      '- src/a.ts — 2 shared changes',
      '- src/a.ts — 2 changes to this file alone',
      '- src/a.ts — 2 changes to the other file alone',
    ]);
    expect(kinds.map((kind) => line('ru', kind, '1'))).toEqual([
      '- src/a.ts — 1 символ',
      '- src/a.ts — 1 коммит',
      '- src/a.ts — 1 файл',
      '- src/a.ts — 1 достижимый коммит',
      '- src/a.ts — 1 коммит основной линии',
      '- src/a.ts — 1 слияние',
      '- src/a.ts — 1 коммит без слияний',
      '- src/a.ts — 1 автор',
      '- src/a.ts — 1 совместное изменение',
      '- src/a.ts — 1 изменение только этого файла',
      '- src/a.ts — 1 изменение только другого файла',
    ]);
    expect(line(undefined, 'commits', '1')).toBe('- src/a.ts — 1 commit');
  });

  test('an uncounted figure keeps its name and value, and the JSON keeps every figure structured', () => {
    const model = history('ru', [{ kind: 'added', value: '42' }, { kind: 'module', value: 'src/a.ts' }, { kind: 'commits', value: '1' }]);
    expect(pageFileMarkdown(model, prefix).split('\n').find((line) => line.startsWith('- src/a.ts'))).toBe('- src/a.ts — added: 42, module: src/a.ts, 1 коммит');
    expect(pageFileDocument(model, prefix).sections[0]!.groups![0]!.items[0]!.figures).toEqual([
      { kind: 'added', value: '42' },
      { kind: 'module', value: 'src/a.ts' },
      { kind: 'commits', value: '1' },
    ]);
  });
});
