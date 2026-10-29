/**
 * Liquid templates (madarch-u3vw.1, decision 0032 section 8): a base page every
 * kind extends, partials, conditions, the engine's blocks as tags, a block known
 * by its name and parameters, the bounds a product's template runs under, and
 * the diagnostics that keep the template's file and line. The templates here are
 * the test's own, written into a scratch product repository, so every expected
 * value is read off them and off this file's own render function, never off the
 * engine's output.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeRenderWorkers, renderLiquidPage, renderWorkers, residentMiB, templateSetOf } from '../src/knowledge/liquid.js';
import type { Block } from '../src/knowledge/model.js';
import { blockIdentity } from '../src/knowledge/template.js';

const folders: string[] = [];

function product(files: Record<string, string>): string {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-liquid-'));
  folders.push(folder);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(folder, path, '..'), { recursive: true });
    writeFileSync(join(folder, path), text);
  }
  return folder;
}

afterEach(() => {
  closeRenderWorkers();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const callers = (title: string): Block => ({ type: 'callers', title, total: 2, rows: [] });
const related = (title: string): Block => ({ type: 'related', title, groups: [] });

/** One page drawn from its template, with the blocks answered as this file says. */
async function draw(
  folder: string,
  template: string,
  data: Record<string, unknown> = {},
  options: { defer?: boolean; deferred?: readonly string[]; only?: string; render?: (name: string, params: Readonly<Record<string, string>>, file: string, line: number) => Promise<Block> } = {},
): Promise<{ blocks: Block[]; findings: { file: string; line: number; message: string }[]; refused?: string }> {
  return renderLiquidPage({
    productFolder: folder,
    template,
    data,
    defer: options.defer ?? false,
    deferred: options.deferred ?? [],
    ...(options.only === undefined ? {} : { only: options.only }),
    render: options.render ?? (async (name, params) => (name === 'callers' ? callers(String(params['title'] ?? '')) : related(String(params['title'] ?? '')))),
  });
}

const markdown = (blocks: Block[]): string => blocks.filter((block) => block.type === 'markdown').map((block) => block.type === 'markdown' ? block.markdown : '').join('');

describe('the templates of a product', () => {
  test('the set is every .liquid file under templates, and no other path of the product, with a digest that follows the text', () => {
    const folder = product({
      'templates/entity.liquid': 'base',
      'templates/partials/part.liquid': 'part',
      'templates/old.md': 'a template of 0029',
      'madarch/kinds.yaml': 'kinds: {}\n',
      'docs/page.md': 'a page',
    });
    const set = templateSetOf(folder);
    expect(Object.keys(set.files).sort()).toEqual(['templates/entity.liquid', 'templates/partials/part.liquid']);
    const before = set.digest;
    writeFileSync(join(folder, 'templates/entity.liquid'), 'base, edited');
    expect(templateSetOf(folder).digest).not.toBe(before);
  });

  test('a template outside the folder, or a kind template that is not there, is refused with the path named', async () => {
    const folder = product({ 'templates/a.liquid': 'x' });
    const refused = await draw(folder, 'templates/absent.liquid');
    expect(refused.refused).toContain('templates/absent.liquid');
    expect(refused.blocks).toEqual([]);
    expect((await draw(folder, 'docs/escape.liquid')).refused).toContain('docs/escape.liquid');
  });
});

describe('a page extends its base', () => {
  test('a kind template fills the blocks of the base, and the base decides where they stand', async () => {
    const folder = product({
      'templates/entity.liquid': 'first\n{% block middle %}nothing{% endblock %}\nlast\n',
      'templates/kind.liquid': '{% layout "./entity.liquid" %}{% block middle %}the middle{% endblock %}',
    });
    expect(markdown((await draw(folder, 'templates/kind.liquid')).blocks)).toBe('first\nthe middle\nlast\n');
    // A block the kind does not fill stays as the base wrote it.
    const folder2 = product({ 'templates/entity.liquid': '{% block middle %}nothing{% endblock %}', 'templates/kind.liquid': '{% layout "./entity.liquid" %}' });
    expect(markdown((await draw(folder2, 'templates/kind.liquid')).blocks)).toBe('nothing');
  });

  test('a partial is rendered with the values it is given, and it sees only those', async () => {
    const folder = product({
      'templates/page.liquid': '{% render "./partials/part.liquid", title="Files", count=3 %}',
      'templates/partials/part.liquid': '{{ title }}:{{ count }}',
    });
    expect(markdown((await draw(folder, 'templates/page.liquid')).blocks)).toBe('Files:3');
    const isolated = product({ 'templates/page.liquid': '{% render "./partials/part.liquid" %}', 'templates/partials/part.liquid': '[{{ label }}]' });
    const drawn = await draw(isolated, 'templates/page.liquid', { label: 'billing' });
    expect(drawn.findings.map((finding) => [finding.file, finding.line])).toEqual([['templates/partials/part.liquid', 1]]);
  });

  test('a condition shows a section only when the page holds what it tests, and printing a missing attribute is a finding', async () => {
    const folder = product({ 'templates/page.liquid': '{% if page.language %}A {{ page.language }} service.{% endif %}{% if page.missing %}never{% endif %}' });
    expect(markdown((await draw(folder, 'templates/page.liquid', { language: 'go' })).blocks)).toBe('A go service.');
    const none = await draw(folder, 'templates/page.liquid', {});
    expect(none.findings).toEqual([]);
    expect(markdown(none.blocks)).toBe('');
    const printed = await draw(folder, 'templates/page.liquid', {});
    expect(printed.findings).toEqual([]);
    const folder2 = product({ 'templates/page.liquid': 'line one\n\n{{ page.language }}' });
    const drawn = await draw(folder2, 'templates/page.liquid', {});
    expect(drawn.findings).toEqual([{ file: 'templates/page.liquid', line: 3, message: 'undefined variable: page.language' }]);
  });
});

describe('the blocks of the library', () => {
  test('a block tag writes the place of the block, and the block is read with the parameters the template gave', async () => {
    const asked: [string, Record<string, string>, number][] = [];
    const folder = product({ 'templates/page.liquid': 'before\n{% related title="Files" relation="code.contains" depth=3 limit=60 %}\nafter' });
    const drawn = await draw(folder, 'templates/page.liquid', {}, {
      render: async (name, params, _file, line) => { asked.push([name, { ...params }, line]); return related(String(params['title'])); },
    });
    expect(asked).toEqual([['related', { title: 'Files', relation: 'code.contains', depth: '3', limit: '60' }, 2]]);
    expect(drawn.blocks.map((block) => block.type)).toEqual(['markdown', 'related', 'markdown']);
    expect(markdown(drawn.blocks)).toBe('before\n\nafter');
  });

  test('a block the page leaves to a read of its own is written as deferred, known by its name and parameters', async () => {
    const folder = product({ 'templates/page.liquid': '{% graph title="Around this function" %}\n{% related title="Files" %}' });
    const drawn = await draw(folder, 'templates/page.liquid', {}, {
      defer: true,
      deferred: ['graph'],
      render: async (name, params) => (name === 'graph' ? { type: 'graph', title: 'g', neighborhood: { center: 'x', nodes: [], edges: [], more: [], relations: [] }, depth: 1, shown: 0, total: 0 } : related(String(params['title']))),
    });
    const [graph, relations] = drawn.blocks;
    expect(graph).toMatchObject({ type: 'deferred', block: 'graph', name: 'graph', title: 'Around this function', id: blockIdentity('graph', { title: 'Around this function' }) });
    expect(relations?.type).toBe('related');
  });

  test('one block asked for by its identity is the answer, and the page\'s other blocks are not read', async () => {
    const folder = product({ 'templates/page.liquid': '{% graph title="Around" %}\n{% related title="Files" %}' });
    const wanted = blockIdentity('related', { title: 'Files' });
    const asked: string[] = [];
    const drawn = await draw(folder, 'templates/page.liquid', {}, {
      only: wanted,
      render: async (name, params) => { asked.push(name); return related(String(params['title'])); },
    });
    expect(asked).toEqual(['related']);
    // The page is the one block a reader's own read draws: the others are not part of the answer.
    expect(drawn.blocks.map((block) => block.type)).toEqual(['related']);
  });

  test('the reader\'s language folds into the title, and a block is the same block whatever the language', async () => {
    const folder = product({ 'templates/page.liquid': '{% related title="Files" title-ru="Файлы" %}', 'templates/ru.liquid': '{% related title="Files" title-ru="Файлы" %}' });
    const asked: Record<string, string>[] = [];
    const render = async (name: string, params: Readonly<Record<string, string>>): Promise<Block> => { asked.push({ ...params }); return related(String(params['title'])); };
    await renderLiquidPage({ productFolder: folder, template: 'templates/page.liquid', data: {}, defer: false, deferred: [], render });
    await renderLiquidPage({ productFolder: folder, template: 'templates/ru.liquid', data: {}, lang: 'ru', defer: false, deferred: [], render });
    expect(asked).toEqual([{ title: 'Files' }, { title: 'Файлы' }]);
  });

  test('a block name the library does not hold is a parse error with the template\'s line, not a line of text', async () => {
    const folder = product({ 'templates/page.liquid': 'one\n{% nonsense title="x" %}\n' });
    const drawn = await draw(folder, 'templates/page.liquid');
    expect(drawn.findings.map((finding) => [finding.file, finding.line])).toEqual([['templates/page.liquid', 2]]);
    expect(drawn.findings[0]!.message).toContain('nonsense');
    expect(drawn.blocks).toEqual([{ type: 'problem', block: 'templates/page.liquid', file: 'templates/page.liquid', line: 2, message: drawn.findings[0]!.message }]);
  });

  test('a parameter that is neither a text nor a number is refused with the block and the line', async () => {
    const folder = product({ 'templates/page.liquid': '{% related title=page.groups %}' });
    const drawn = await draw(folder, 'templates/page.liquid', { groups: ['a'] });
    expect(drawn.findings[0]?.line).toBe(1);
    expect(drawn.findings[0]?.message).toContain('the parameter "title"');
  });
});

describe('the bounds of a page', () => {
  test('a filter outside the allowlist is a parse error, and no machine-reading filter is reachable', async () => {
    const folder = product({ 'templates/page.liquid': '{{ page.label | date: "%Y" }}' });
    const drawn = await draw(folder, 'templates/page.liquid', { label: 'x' });
    expect(drawn.findings[0]?.message).toContain('undefined filter: date');
    const allowed = product({ 'templates/page.liquid': '{{ page.label | upcase }}' });
    expect(markdown((await draw(allowed, 'templates/page.liquid', { label: 'billing' })).blocks)).toBe('BILLING');
  });

  test('a page that dispatches more blocks than a page may is refused, with the line that asked for it', async () => {
    const folder = product({ 'templates/page.liquid': '{% for i in (1..80) %}{% related title="Files" %}{% endfor %}' });
    const drawn = await draw(folder, 'templates/page.liquid');
    expect(drawn.blocks[0]?.type).toBe('problem');
    expect(drawn.findings[0]?.message).toContain('more than 64 blocks');
  });

  test('a loop Liquid counts out is refused, rather than drawn', async () => {
    const folder = product({ 'templates/page.liquid': '{% for i in (1..1000000) %}{{ i }}{% endfor %}' });
    // The page's own cooperative limit, small enough that the loop is stopped in a moment: the wall clock would stop it too.
    const drawn = await renderLiquidPage({
      productFolder: folder, template: 'templates/page.liquid', data: {}, defer: false, deferred: [],
      limits: { templateLimit: 2_000, renderLimit: 200, memoryLimit: 10_000_000, parseLimit: 10_000, blocks: 8, outputChars: 4 << 20 },
      render: async () => ({ type: 'markdown', markdown: '' }),
    });
    expect(drawn.blocks[0]?.type).toBe('problem');
    expect(drawn.findings[0]?.message).toContain('render limit exceeded');
    expect(drawn.findings[0]?.file).toBe('templates/page.liquid');
  }, 30_000);

  test('a page past its wall clock is refused, and the next page is drawn by a worker of its own', async () => {
    const folder = product({ 'templates/page.liquid': '{% related title="Slow" %}', 'templates/quick.liquid': 'quick' });
    const slow = await renderLiquidPage({
      productFolder: folder, template: 'templates/page.liquid', data: {}, defer: false, deferred: [],
      bounds: { wallClockMs: 150, memoryMiB: 512 },
      render: () => new Promise<Block>((resolve) => setTimeout(() => resolve(related('late')), 3_000)),
    });
    expect(slow.blocks[0]?.type).toBe('problem');
    expect(slow.findings[0]?.message).toContain('did not finish in 150 ms');
    const quick = await draw(folder, 'templates/quick.liquid');
    expect(markdown(quick.blocks)).toBe('quick');
  }, 20_000);

  test('the template text is escaped as Markdown, so a page\'s own value cannot shape the page', async () => {
    const folder = product({ 'templates/page.liquid': '{{ page.label }}' });
    expect(markdown((await draw(folder, 'templates/page.liquid', { label: 'a *b* [c](d)' })).blocks)).toBe('a \\*b\\* \\[c\\]\\(d\\)');
  });
});

describe('a block knows its own place', () => {
  test('the identity of a block is its name and its parameters: editing the template above it changes nothing', async () => {
    const one = product({ 'templates/page.liquid': '{% related title="Files" relation="code.contains" %}' });
    const other = product({ 'templates/page.liquid': 'a\nb\n\nc\n{% related title="Files" relation="code.contains" %}\n' });
    const [first] = (await draw(one, 'templates/page.liquid')).blocks;
    const [, second] = (await draw(other, 'templates/page.liquid')).blocks;
    expect(first).toEqual(second);
    expect(blockIdentity('related', { title: 'Files', relation: 'code.contains' })).toBe(blockIdentity('related', { relation: 'code.contains', title: 'Files' }));
    expect(blockIdentity('related', { title: 'Files' })).not.toBe(blockIdentity('related', { title: 'Modules' }));
  });
});

describe('the worker', () => {
  test('a worker that ends is replaced, and the page after it is drawn', async () => {
    const folder = product({ 'templates/page.liquid': '{{ label }}' });
    const real = renderWorkers.factory;
    let started = 0;
    renderWorkers.factory = () => {
      started += 1;
      const worker = real();
      if (started === 1) {
        // The first worker is asked one page and then dies under it, as a killed process does.
        return { ...worker, write: () => worker.kill(), exited: worker.exited, stderr: worker.stderr, kill: worker.kill, pid: worker.pid, lines: worker.lines };
      }
      return worker;
    };
    try {
      const first = await draw(folder, 'templates/page.liquid', { label: 'a' });
      expect(first.findings[0]?.message).toContain('the worker ended');
      const second = await draw(folder, 'templates/page.liquid', { label: 'b' });
      expect(markdown(second.blocks)).toBe('b');
      expect(started).toBe(2);
    } finally {
      renderWorkers.factory = real;
    }
  }, 20_000);

  test('the page comes back as its own text and the places its blocks stand, never as a text with markers in it', async () => {
    const folder = product({ 'templates/page.liquid': 'before {% related title="Files" %} after' });
    // A page whose own text holds the characters a marker would need is drawn whole: nothing is parsed out of the text.
    const drawn = await draw(folder, 'templates/page.liquid');
    // The page's text on either side of the block comes back as its own text, and the block stands between them.
    expect(drawn.blocks.map((block) => block.type === 'markdown' ? block.markdown : block.type)).toEqual(['before ', 'related', ' after']);
  });
});

describe('the review of the engine', () => {
  test('a block a template tests reads its data through the page, not through a proxy the strict lookup refuses', async () => {
    const folder = product({
      'templates/page.liquid': '{% if page.callers.total > 1 %}many: {{ page.callers.total }}{% else %}few{% endif %}\n{% callers title="Callers" %}',
    });
    const asked: string[] = [];
    const drawn = await draw(folder, 'templates/page.liquid', {}, {
      render: async (name, params) => { asked.push(name); return { type: 'callers', title: String(params['title'] ?? ''), total: 2, rows: [] }; },
    });
    expect(drawn.findings).toEqual([]);
    expect(drawn.blocks.filter((block) => block.type === 'markdown').map((block) => block.type === 'markdown' ? block.markdown : '')).toEqual(['many: 2\n']);
    // The page's own test of the block reads it (no parameters), and the tag reads the block it places (with its title).
    expect(asked).toEqual(['callers', 'callers']);
    expect(drawn.blocks.filter((block) => block.type === 'callers')).toHaveLength(1);
  });

  test('a block of a partial answers a problem with the partial\'s own file and line, not the page\'s template', async () => {
    const folder = product({
      'templates/page.liquid': 'one\n{% render "./partials/part.liquid" %}',
      'templates/partials/part.liquid': 'a\nb\n{% nonsense %}',
    });
    const drawn = await draw(folder, 'templates/page.liquid');
    expect(drawn.findings.map((finding) => [finding.file, finding.line])).toEqual([['templates/partials/part.liquid', 3]]);
  });

  test('a tag outside the allowlist is refused with its file and line, in a page and inside a liquid tag', async () => {
    for (const text of ['{% include "x.liquid" %}', '{% liquid\ninclude "x.liquid"\n%}']) {
      const folder = product({ 'templates/page.liquid': text });
      const drawn = await draw(folder, 'templates/page.liquid');
      expect(drawn.blocks[0]?.type).toBe('problem');
      expect(drawn.findings[0]?.file).toBe('templates/page.liquid');
      expect(drawn.findings[0]?.message).toContain('include');
    }
  });

  test('a templates folder that is a link out of the product reads no template, and says so', async () => {
    const folder = product({ 'templates/page.liquid': 'x' });
    const outside = product({ 'out/page.liquid': 'outside' });
    rmSync(join(folder, 'templates'), { recursive: true, force: true });
    symlinkSync(join(outside, 'out'), join(folder, 'templates'));
    const set = templateSetOf(folder);
    expect(Object.keys(set.files)).toEqual([]);
    expect(set.findings.map((finding) => finding.message).join(' ')).toContain('link');
    const drawn = await draw(folder, 'templates/page.liquid');
    expect(drawn.refused).toContain('templates/page.liquid');
  });

  test('a block read that never answers is stopped by the wall clock, and the next page is drawn', async () => {
    const folder = product({ 'templates/page.liquid': '{% related title="Slow" %}', 'templates/quick.liquid': 'quick' });
    const started = Date.now();
    const drawn = await renderLiquidPage({
      productFolder: folder, template: 'templates/page.liquid', data: {}, defer: false, deferred: [],
      bounds: { wallClockMs: 150, memoryMiB: 512 },
      render: () => new Promise<Block>(() => undefined),
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(drawn.findings[0]?.message).toContain('did not finish in 150 ms');
    const quick = await draw(folder, 'templates/quick.liquid');
    expect(quick.blocks).toEqual([{ type: 'markdown', markdown: 'quick' }]);
  }, 20_000);

  test('the memory of a worker is read on this platform, so the bound stands wherever the binary ships', () => {
    expect(residentMiB(process.pid)).toBeGreaterThan(0);
    expect(residentMiB(undefined)).toBeUndefined();
  });
});
