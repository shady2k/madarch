/**
 * The home page (madarch-ztyq.7; decision 0032, sections 1, 7 and 11), without a graph: the eight sections a reader
 * opens the wiki by, in the order a reader reads them; the place each section points at and the one sentence about
 * it; the sentence a part says where the unit found nothing; and the page's front matter.
 *
 * What a unit gives is fields, never the page: it never chooses a section, never writes a heading and never names a
 * footnote. The same fields rendered in English and in Russian carry one structure and the same places, and a page
 * that cannot be written is refused with the field it stands in rather than written shorter.
 */
import { describe, expect, test } from 'bun:test';
import { EMPTY_PRODUCT_GAPS, HOME_SECTIONS, homeGrounds, homeRelates, homeSources, homeStatements, parseHomeFields, renderEmptyHomePage, renderHomePage, type HomeFields } from '../src/writer/home-page.js';
import { readEmptyProductGapMarker } from '../src/writer/empty-product-gap.js';

const labels: Record<string, string> = {
  'code.service:shop': 'Shop service',
  'doc:docs/use-cases.md#uc-1': 'Buy a thing',
  'doc:docs/vision.md#vision': 'Vision',
};
const labelOf = (target: string): string | undefined => labels[target];
const context = { language: 'en' as const, labelOf, page: { id: 'product:shop', kind: 'product', title: 'Shop' } };

const fields: HomeFields = {
  whatItIs: [{ text: 'A shop sells things to people.', grounds: ['doc:docs/vision.md#vision'] }],
  scenarios: [{ target: 'doc:docs/use-cases.md#uc-1', text: 'A buyer pays for an order.', grounds: ['doc:docs/vision.md#vision'] }],
  system: [{ target: 'code.service:shop', text: 'The shop service holds the catalogue.', grounds: ['doc:docs/vision.md#vision'] }],
  domains: [{ target: 'domain:payments', text: 'Payments take the money.', grounds: ['doc:docs/vision.md#vision'] }],
  rules: [],
  technology: [{ text: 'The product is TypeScript on Bun.', grounds: ['code.service:shop'] }],
  coverage: [],
  notConnected: [{ text: 'The storefront has no frontend.', grounds: ['doc:docs/vision.md#vision'] }],
};

const fieldsOf = (value: unknown): HomeFields => {
  const read = parseHomeFields(value);
  if (!read.ok) throw new Error(`refused: ${read.problems.map((problem) => `${problem.rule}: ${problem.message}`).join('; ')}`);
  return read.fields;
};

/** The body's sections, in the order they appear: each heading and the lines under it. */
const sectionsOf = (markdown: string): { heading: string; lines: string[] }[] => {
  const sections: { heading: string; lines: string[] }[] = [];
  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ')) { sections.push({ heading: line.slice(3), lines: [] }); continue; }
    if (sections.length > 0) sections[sections.length - 1]!.lines.push(line);
  }
  return sections.map((section) => ({ heading: section.heading, lines: section.lines.filter((line) => line.trim() !== '') }));
};

describe('the home page is eight sections in the order a reader reads them', () => {
  test('the declaration carries the eight ids, in that order', () => {
    expect(HOME_SECTIONS.map((section) => section.id)).toEqual(['what-it-is', 'scenarios', 'system', 'domains', 'rules', 'technology', 'coverage', 'not-connected']);
    expect(HOME_SECTIONS.map((section) => section.field)).toEqual(['whatItIs', 'scenarios', 'system', 'domains', 'rules', 'technology', 'coverage', 'notConnected']);
  });

  test('every section has its heading in both languages, and its gap where it has one', () => {
    for (const section of HOME_SECTIONS) {
      expect(section.heading.en.trim()).not.toBe('');
      expect(section.heading.ru.trim()).not.toBe('');
      if (section.id === 'what-it-is') expect(section.gap).toBeUndefined();
      else expect(section.gap?.en.trim()).not.toBe('');
    }
  });

  test('the page is the eight headings in order, each with its part', () => {
    const { markdown } = renderHomePage(fields, context);
    const sections = sectionsOf(markdown);
    expect(sections.map((section) => section.heading)).toEqual(HOME_SECTIONS.map((section) => section.heading.en));
    for (const section of sections) expect(section.lines.length).toBeGreaterThan(0);
  });

  test('the same fields in Russian carry the same structure and the same places', () => {
    const { markdown } = renderHomePage(fields, { ...context, language: 'ru' });
    const sections = sectionsOf(markdown);
    expect(sections.map((section) => section.heading)).toEqual(HOME_SECTIONS.map((section) => section.heading.ru));
    const links = markdown.split('\n').filter((line) => line.includes('](madarch:'));
    expect(links.some((line) => line.includes('[Buy a thing](madarch:doc:docs/use-cases.md#uc-1)'))).toBe(true);
  });

  test('a page without a grounded sentence of what the product is cannot be rendered while the product has evidence', () => {
    expect(() => renderHomePage({ ...fields, whatItIs: [] }, context)).toThrow('what the product is');
  });

  test('an omitted notConnected says connections were not assessed, never that nothing is unconnected', () => {
    const gap = HOME_SECTIONS.find((section) => section.id === 'not-connected')!.gap!;
    expect(gap.en).toContain('have not yet been assessed');
    expect(gap.en).not.toContain('leave nothing unconnected');
    expect(gap.ru).toContain('ещё не оценивались');
    const { markdown } = renderHomePage({ ...fields, notConnected: [] }, context);
    expect(markdown).toContain(gap.en);
    expect(markdown).not.toContain('leave nothing unconnected');
  });

  test('an empty product is written as eight gap sentences, with no invented ground', () => {
    const { markdown } = renderEmptyHomePage({ ...context, page: { ...context.page, title: 'Shop' } });
    const sections = sectionsOf(markdown);
    expect(sections.map((section) => section.heading)).toEqual(HOME_SECTIONS.map((section) => section.heading.en));
    for (const section of sections) {
      const id = section.heading === HOME_SECTIONS[0]!.heading.en ? 'what-it-is' as const : HOME_SECTIONS.find((one) => one.heading.en === section.heading)!.id;
      expect(section.lines).toHaveLength(2);
      expect(readEmptyProductGapMarker(section.lines[0]!)?.section).toBe(id);
      expect(section.lines[1]).toBe(EMPTY_PRODUCT_GAPS.en[id]);
    }
    expect(markdown).not.toMatch(/\[\^[A-Za-z0-9_-]+\]/);
    expect(markdown).toContain('<!-- madarch:empty-product-gap:what-it-is:');
    expect(markdown).toContain('sources: []');
  });
});

describe('a section points at the page that says it in full', () => {
  test('a place is its link, the sentence about it, and the grounds the sentence stands on', () => {
    const { markdown } = renderHomePage(fields, context);
    expect(markdown.split('\n')).toContain('- [Buy a thing](madarch:doc:docs/use-cases.md#uc-1) — A buyer pays for an order.[^2]');
    expect(markdown.split('\n')).toContain('[^2]: [Vision](madarch:doc:docs/vision.md#vision)');
  });

  test('a place without a label of its own shows the graph\'s name for it', () => {
    const { markdown } = renderHomePage(fields, context);
    expect(markdown.split('\n')).toContain('- [Shop service](madarch:code.service:shop) — The shop service holds the catalogue.[^3]');
  });

  test('a place the unit labels shows the label a reader reads', () => {
    const read = fieldsOf({ ...fields, rules: [{ target: 'domain:payments', label: 'Refunds', text: 'A refund returns the money.', grounds: ['doc:docs/vision.md#vision'] }] });
    const { markdown } = renderHomePage(read, context);
    expect(markdown.split('\n')).toContain('- [Refunds](madarch:domain:payments) — A refund returns the money.[^5]');
  });
});

describe('a part the unit found nothing for is said, never left empty', () => {
  test('every empty part says its gap, grounded on the page\'s own evidence', () => {
    const { markdown } = renderHomePage(fields, context);
    expect(markdown).toContain(HOME_SECTIONS.find((section) => section.id === 'rules')!.gap!.en);
    expect(markdown).toContain(HOME_SECTIONS.find((section) => section.id === 'coverage')!.gap!.en);
    // The gap stands on the same passage as the page's first statement: an absence is said of the document, never of the world.
    expect(markdown).toContain('[^5]: [Vision](madarch:doc:docs/vision.md#vision)');
  });

  test('a part the unit filled says no gap', () => {
    const { markdown } = renderHomePage(fields, context);
    expect(markdown).not.toContain(HOME_SECTIONS.find((section) => section.id === 'scenarios')!.gap!.en);
  });
});

describe('the fields a unit gives are parsed before a byte is written', () => {
  test('whatItIs is required, and at least one grounded sentence', () => {
    const missing = parseHomeFields({});
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.problems.map((problem) => problem.message).join(' ')).toContain('"whatItIs"');
    const ungrounded = parseHomeFields({ whatItIs: [{ text: 'A shop.', grounds: [] }] });
    expect(ungrounded.ok).toBe(false);
    if (!ungrounded.ok) expect(ungrounded.problems[0]!.message).toContain('no ground');
  });

  test('a field nothing declares is refused, naming the fields there are', () => {
    const read = parseHomeFields({ whatItIs: [{ text: 'A shop.', grounds: ['code.service:shop'] }], architecture: [] });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.problems[0]!.message).toContain('"architecture" names nothing: the fields are title, whatItIs, scenarios, system, domains, rules, technology, coverage, notConnected');
  });

  test('a place carries its target, its sentence and its grounds', () => {
    const noTarget = parseHomeFields({ whatItIs: [{ text: 'A shop.', grounds: ['code.service:shop'] }], scenarios: [{ text: 'Buying.', grounds: ['code.service:shop'] }] });
    expect(noTarget.ok).toBe(false);
    if (!noTarget.ok) expect(noTarget.problems[0]!.message).toContain('"scenarios[0].target"');
    const noText = parseHomeFields({ whatItIs: [{ text: 'A shop.', grounds: ['code.service:shop'] }], scenarios: [{ target: 'code.service:shop', grounds: ['code.service:shop'] }] });
    expect(noText.ok).toBe(false);
    if (!noText.ok) expect(noText.problems[0]!.message).toContain('"scenarios[0].text"');
    const noGrounds = parseHomeFields({ whatItIs: [{ text: 'A shop.', grounds: ['code.service:shop'] }], scenarios: [{ target: 'code.service:shop', text: 'Buying.' }] });
    expect(noGrounds.ok).toBe(false);
    if (!noGrounds.ok) expect(noGrounds.problems[0]!.message).toContain('"scenarios[0]" holds no ground');
  });

  test('a field of the wrong shape is a problem of its own, never a part that vanishes', () => {
    const read = parseHomeFields({ whatItIs: [{ text: 'A shop.', grounds: ['code.service:shop'] }], technology: 'TypeScript' });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.problems[0]!.message).toContain('"technology" is a list of statements');
  });
});

describe('the page\'s own identity and evidence', () => {
  test('the front matter says what the page is, the keys it relates and the documents it stands on', () => {
    const { markdown } = renderHomePage(fields, context);
    const end = markdown.indexOf('\n---\n', 4);
    expect(markdown.slice(0, end + 5)).toBe([
      '---',
      'id: product:shop',
      'kind: product',
      'title: "Shop"',
      'relates:',
      '  - "code.service:shop"',
      'producer: agent',
      'sources:',
      '  - "docs/use-cases.md"',
      '  - "docs/vision.md"',
      '---',
      '',
    ].join('\n'));
    expect(markdown.split('\n')).toContain('title: "Shop"');
  });

  test('a title with a colon reads back as the words it holds', () => {
    const read = fieldsOf({ ...fields, title: 'Shop: the store' });
    const { markdown } = renderHomePage(read, context);
    expect(markdown.split('\n')).toContain('title: "Shop: the store"');
  });

  test('the file shortcuts are not the keys a page relates', () => {
    const read = fieldsOf({
      whatItIs: [{ text: 'A shop.', grounds: ['doc:docs/vision.md#vision', 'code.file:src/a.ts', 'code.module:src'] }],
      technology: [{ text: 'One file.', grounds: ['code.service:shop', 'code.module:src'] }],
    });
    expect(homeRelates(read)).toEqual(['code.service:shop']);
    expect(homeSources(read)).toEqual(['docs/vision.md']);
  });

  test('every ground and every place is named once, in the order the page says them', () => {
    const read = fieldsOf({
      whatItIs: [{ text: 'A shop.', grounds: ['doc:docs/vision.md#vision'] }],
      scenarios: [{ target: 'doc:docs/use-cases.md#uc-1', text: 'Buying.', grounds: ['code.service:shop'] }],
      technology: [{ text: 'TypeScript.', grounds: ['doc:docs/vision.md#vision'] }],
    });
    expect(homeGrounds(read)).toEqual(['doc:docs/vision.md#vision', 'code.service:shop', 'doc:docs/use-cases.md#uc-1']);
    expect(homeStatements(read).map((statement) => statement.text)).toEqual(['A shop.', 'TypeScript.', 'Buying.']);
  });
});
