import { describe, expect, test } from 'bun:test';
import { ensureTemplateDeclarations, interpretTemplateDeclarations } from '../src/plugin/template-declarations.js';
import type { KindsManifest } from '../src/product/manifest/kinds.js';
import { snapshotFiles, type ProductFileRead } from '../src/plugin/product-files.js';
import { templatePartsOf, templatePartsFor } from '../src/knowledge/template.js';
import { TEMPLATES, STARTER_FILES } from '../src/knowledge/seed.js';
import { readKindsFrom } from '../src/product/manifest/kinds.js';
import { planManifestFill } from '../src/plugin/fill-declarations.js';

function compile(texts: Record<string, string>, paths = ['templates/page.liquid']) {
  const files: ProductFileRead = { has: (path) => path in texts, text: (path) => texts[path], size: (path) => texts[path]?.length ?? null };
  const manifest = { kinds: new Map(), declaredTemplates: paths } as unknown as KindsManifest;
  return interpretTemplateDeclarations(files, manifest);
}

describe('template declarations', () => {
  test('expands nested layouts and scoped partials in order, deduplicating references', () => {
    const read = compile({
      'templates/page.liquid': '{% layout "./middle.liquid" %}{% block lead %}# {{ page.title }}{% render "./part.liquid", title="Around" %}{% endblock %}',
      'templates/middle.liquid': '{% layout "./base.liquid" %}{% block tail %}tail{% endblock %}',
      'templates/base.liquid': 'before{% block lead %}default{% endblock %}{% block tail %}{% endblock %}after',
      'templates/part.liquid': '{% relations title=title %}',
    }, ['templates/page.liquid', 'templates/page.liquid']);
    expect(read.findings).toEqual([]);
    expect(read.vertices).toHaveLength(1);
    expect(read.paths).toEqual(['templates/base.liquid', 'templates/middle.liquid', 'templates/page.liquid', 'templates/part.liquid']);
    expect(read.vertices[0]!.values!.template_parts).toEqual([
      { type: 'text', text: 'before', line: 1 }, { type: 'text', text: '# ', line: 1 },
      { type: 'attribute', name: 'title', line: 1 }, { type: 'block', name: 'relations', params: { title: 'Around' }, line: 1 },
      { type: 'text', text: 'tail', line: 1 }, { type: 'text', text: 'after', line: 1 },
    ]);
  });

  test('prefetches pinned entrypoints and references from both conditional branches', async () => {
    const texts: Record<string, string> = {
      'templates/page.liquid': '{% layout "./base.liquid" %}{% block lead %}{% if page.x %}{% render "./yes.liquid" %}{% else %}{% render "./no.liquid" %}{% endif %}{% endblock %}',
      'templates/base.liquid': '{% block lead %}{% endblock %}',
      'templates/yes.liquid': 'yes', 'templates/no.liquid': 'no',
    };
    const files = await snapshotFiles({ entries: () => Object.keys(texts).map((path) => ({ path, mode: '100644', form: 'blob' })), readTexts: async (paths) => paths.map((path) => texts[path]!) });
    const manifest = { kinds: new Map(), declaredTemplates: ['templates/page.liquid'] } as unknown as KindsManifest;
    await ensureTemplateDeclarations(files, manifest);
    expect(interpretTemplateDeclarations(files, manifest).findings).toEqual([]);
  });

  test('keeps comparison operators and append words inside literals', () => {
    const read = compile({ 'templates/page.liquid': '{% if "a == b" == "a == b" %}same{% endif %}{% relations title="text | append: unchanged" %}' });
    expect(read.findings).toEqual([]);
    const parts = templatePartsOf(read.vertices[0]!.values!.template_parts)!;
    const selected = [...templatePartsFor(parts, () => undefined)];
    expect(selected[0]).toMatchObject({ type: 'text', text: 'same' });
    expect(selected[1]).toMatchObject({ params: { title: 'text | append: unchanged' } });
  });

  test('starter template fields belong only to the manifest producer, never the catalogue agent', () => {
    const texts = new Map(STARTER_FILES.map((file) => [file.path, file.content]));
    const files: ProductFileRead & { filesBelow(folder: string): string[] } = { has: (path) => texts.has(path), text: (path) => texts.get(path), size: (path) => texts.get(path)?.length ?? null, filesBelow: (folder) => [...texts.keys()].filter((path) => path.startsWith(`${folder}/`)).sort() };
    const read = readKindsFrom(files, '/neutral-product');
    expect(read.present).toBe(true);
    if (!read.present) throw new Error('starter kinds are missing');
    const kind = read.manifest.kinds.get('template')!;
    expect(kind.fields!.map((field) => field.producers)).toEqual([['manifest'], ['manifest']]);
    const agent = [...read.manifest.plugins!.values()].find((plugin) => plugin.contract?.agent?.catalogue === true)!;
    const plan = planManifestFill(read.manifest, '/neutral-product', ['template'], false);
    expect(plan.requiresAgent).toBe(false);
    // Manifest template publication is separate from executable plugin output planning.
    expect(plan.order).toEqual([]);
    expect(plan.outputs.has(agent.id)).toBe(false);
    expect(plan.unproducedKinds).toEqual([{
      kind: 'template', outcome: 'abstained',
      reason: 'kind template has no configured producer; configure an ordinary producer or kind.agent',
    }]);
    for (const field of kind.fields!) {
      expect(plan.producers('template', field.name)).toEqual([]);
      expect(plan.lastProducer('template', field.name)).toBeUndefined();
    }
    expect(read.manifest.findings).toEqual([]);
  });

  test('restores nested branch targets in both interface languages', () => {
    const read = compile({ 'templates/page.liquid': '{% if lang == "ru" %}RU{% if page.a %} A{% endif %}{% else %}EN{% if page.a %} A{% endif %}{% if page.b %} B{% endif %} END{% endif %}' });
    expect(read.findings).toEqual([]);
    const parts = templatePartsOf(read.vertices[0]!.values!.template_parts)!;
    const words = (lang: string) => [...templatePartsFor(parts, (name) => ({ lang, a: 'yes', b: 'yes' })[name as 'lang' | 'a' | 'b'])].map((one) => one.type === 'text' ? one.text : '').join('');
    expect(words('en')).toBe('EN A B END');
    expect(words('ru')).toBe('RU A');
  });

  test('refuses an override absent from the final layout with the override location', () => {
    const read = compile({ 'templates/page.liquid': '{% layout "./base.liquid" %}\n{% block typo %}lost{% endblock %}', 'templates/base.liquid': '{% block lead %}{% endblock %}' });
    expect(read.vertices).toEqual([]);
    expect(read.findings[0]).toMatchObject({ file: 'templates/page.liquid', line: 2 });
    expect(read.findings[0]!.message).toContain('no block typo');
  });

  test('compiles every starter template without evaluating page values', () => {
    const texts = Object.fromEntries(Object.entries(TEMPLATES).map(([path, text]) => [`templates/${path}`, text]));
    const entries = Object.keys(texts).filter((path) => !path.includes('/partials/'));
    const read = compile(texts, entries);
    expect(read.findings).toEqual([]);
    expect(read.vertices).toHaveLength(entries.length);
    for (const vertex of read.vertices) expect(templatePartsOf(vertex.values!.template_parts)).toBeDefined();
    const table = read.vertices.find((one) => one.key.path === 'templates/table.liquid')!;
    expect(JSON.stringify(table.values)).toContain('concat');
    const symbol = read.vertices.find((one) => one.key.path === 'templates/symbol.liquid')!;
    expect(JSON.stringify(symbol.values)).toContain('conditional');
  });

  test.each([
    ['first\n{% mystery %}', 2, 'unknown block'],
    ['{% if page.title %}text', 1, 'unclosed'],
    ['{% for item in page.items %}', 1, 'unsupported'],
    ['{{ page.title | escape }}', 1, 'unsupported attribute'],
    ['{% relations title="one" title="two" %}', 1, 'twice'],
    ['{% render "../../outside" %}', 1, 'within'],
    ['{% relations title=absent %}', 1, 'unresolved'],
    ['{% layout "./base.liquid" %}discarded', 1, 'discarded'],
    ['{% endblock %}', 1, 'does not match'],
    ['{% comment %}never closed', 1, 'unclosed'],
  ])('refuses invalid input with exact file and line: %s', (text, line, message) => {
    const read = compile({ 'templates/page.liquid': text });
    expect(read.vertices).toEqual([]);
    expect(read.findings[0]).toMatchObject({ file: 'templates/page.liquid', line });
    expect(read.findings[0]!.message).toContain(message);
  });

  test('refuses mutation scopes it cannot preserve instead of dropping assignments', () => {
    const conditional = compile({ 'templates/page.liquid': '{% if page.a %}{% assign title = "Changed" %}{% endif %}{{ title }}' });
    expect(conditional.vertices).toEqual([]);
    expect(conditional.findings[0]!.message).toContain('mutable runtime scope');
    const nested = compile({ 'templates/page.liquid': '{% if page.a %}{% block local %}{% assign title = "Changed" %}{% endblock %}{% endif %}' });
    expect(nested.vertices).toEqual([]);
    expect(nested.findings[0]!.message).toContain('mutable runtime scope');
    const leaked = compile({ 'templates/page.liquid': '{% block local %}{% assign title = "Changed" %}{% endblock %}{{ title }}' });
    expect(leaked.vertices).toEqual([]);
    expect(leaked.findings[0]!.message).toContain('lexical scope');
    const reassigned = compile({ 'templates/page.liquid': '{% assign x = "before" %}{% block local %}{% assign x = "after" %}{% endblock %}{{ x }}' });
    expect(reassigned.vertices).toEqual([]);
    expect(reassigned.findings[0]!.message).toContain('mutable section scope');
    const inherited = compile({ 'templates/page.liquid': '{% include "./part.liquid" %}', 'templates/part.liquid': '{% layout "./base.liquid" %}', 'templates/base.liquid': '{% assign title = "Changed" %}' });
    expect(inherited.vertices).toEqual([]);
    expect(inherited.findings[0]!.message).toContain('mutable assignment scope');
    const included = compile({ 'templates/page.liquid': '{% include "./part.liquid" %}{{ title }}', 'templates/part.liquid': '\n{% assign title = "Changed" %}' });
    expect(included.vertices).toEqual([]);
    expect(included.findings[0]).toMatchObject({ file: 'templates/part.liquid', line: 2 });
  });

  test('reports dependency cycles and missing partials, retaining the dependency path', () => {
    const cycle = compile({ 'templates/page.liquid': '{% render "./page.liquid" %}' });
    expect(cycle.findings[0]!.message).toContain('cycle');
    const missing = compile({ 'templates/page.liquid': '{% render "./missing.liquid" %}' });
    expect(missing.findings[0]).toMatchObject({ file: 'templates/missing.liquid', line: 1 });
    expect(missing.paths).toContain('templates/missing.liquid');
  });
});
