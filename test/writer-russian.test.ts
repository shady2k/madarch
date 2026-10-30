/**
 * The pages of a product are written in the product's content language (madarch-m38l.4, remark 5): the agent is told,
 * the writer's checks read Russian as they read English, and a page in another language is not refused.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPage, type GroundResolver, type PageExpectation } from '../src/writer/format.js';
import { CONTENT_LANGUAGES, fixedPart } from '../src/writer/prompts.js';
import { unitsNeeded } from '../src/writer/run.js';
import { parseKinds, readKinds, setKindsLanguage } from '../src/knowledge/kinds.js';

const resolver: GroundResolver = {
  graphKey: async (key) => key === 'code.service:payments',
  docSection: async (path, anchor) => path === 'docs/requirements.md' && anchor === 'uc-2',
  sourceName: async () => true,
};
const expectation: PageExpectation = { id: 'domain:payments', kind: 'domain', domains: ['payments', 'ordering'], mustLinkDomains: false };
const front = ['---', 'id: domain:payments', 'kind: domain', 'title: Платежи', 'relates:', '  - code.service:payments', 'producer: agent', 'sources: []', '---'].join('\n');
const verdictOf = async (body: string) => checkPage(`${front}\n\n${body}\n`, expectation, resolver);

describe('the writer reads Russian', () => {
  const grounds = '[^1]: [платежи](madarch:code.service:payments), [UC-2](madarch:doc:docs/requirements.md#uc-2)';

  test('a page with grounded Russian sentences, a connecting line of links and abbreviations passes', async () => {
    const verdict = await verdictOf([
      '## Как проходят платежи', '',
      'Платежи принимает [сервис платежей](madarch:code.service:payments), т.е. отдельный сервис со своей базой.[^1]',
      'Возврат проверяется до выполнения, напр. по сумме списания.[^1]', '',
      '[заказы](madarch:domain:ordering).', '',
      grounds,
    ].join('\n'));
    expect(verdict.ok, verdict.ok ? '' : JSON.stringify(verdict.refusals)).toBe(true);
  });

  test('a Russian sentence with no footnote is refused as an ungrounded statement, naming its line', async () => {
    const verdict = await verdictOf(['## Платежи', '', 'Платежи принимает отдельный сервис.', '', grounds].join('\n'));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.refusals.map((r) => r.rule)).toContain('ungrounded-statement');
  });

  test('a statement hidden behind "См. также" is refused, as behind "See also", and as a statement, not as an unused footnote', async () => {
    const verdict = await verdictOf(['## Платежи', '', 'См. также что платежи принимает отдельный сервис со своей базой данных и очередью.', '', 'Платежи принимает отдельный сервис.[^1]', '', grounds].join('\n'));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.refusals.map((refusal) => [refusal.line, refusal.rule])).toContainEqual([expect.any(Number), 'ungrounded-statement']);
    expect(verdict.refusals.filter((refusal) => refusal.rule === 'ungrounded-statement')).toHaveLength(1);
  });

  test('an abbreviation that can end a sentence does not swallow the sentence end: the sentence before it needs its own ground', async () => {
    const verdict = await verdictOf(['## Платежи', '', 'Комиссия составляет 500 руб. Сервис принимает платежи.[^1]', '', grounds].join('\n'));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.refusals.map((refusal) => refusal.rule)).toContain('ungrounded-statement');
    // The same abbreviation inside a sentence, before a lowercase word, is not an end.
    const inside = await verdictOf(['## Платежи', '', 'Комиссия составляет 500 руб. за платёж, т.е. фиксированную сумму.[^1]', '', grounds].join('\n'));
    expect(inside.ok, inside.ok ? '' : JSON.stringify(inside.refusals)).toBe(true);
  });

  test('a page in English is not refused when the product speaks Russian: the check does not read the language', async () => {
    const verdict = await verdictOf(['## How payments work', '', 'Payments are charged through the payments service.[^1]', '', grounds].join('\n'));
    expect(verdict.ok, verdict.ok ? '' : JSON.stringify(verdict.refusals)).toBe(true);
  });
});

describe('the agent is told the language', () => {
  test('the fixed part says every sentence and heading are in the language, and what stays as it is', () => {
    expect(Object.keys(CONTENT_LANGUAGES)).toEqual(['en', 'ru']);
    const russian = fixedPart('ru');
    expect(russian).toContain('in Russian');
    expect(russian).toContain('every sentence and every heading');
    expect(russian).toContain('no words outside those links');
    expect(russian).toContain('Graph keys, file paths, identifiers');
    expect(fixedPart('en')).toContain('in English');
    expect(() => fixedPart('de')).toThrow('"de" is not a language the writer knows');
  });
});

describe('what needs an agent unit', () => {
  const product = '---\nid: product:x\n---\nSee [a](madarch:domain:alpha) and [b](madarch:domain:beta).\n';
  test('a missing product page needs the units; every page present and in the language asked needs none', () => {
    expect(unitsNeeded({ productPage: null, domainPages: [], languageChanged: false }).product).toBe(true);
    const settled = unitsNeeded({ productPage: product, domainPages: ['docs/domains/alpha.md', 'docs/domains/beta.md'], languageChanged: false });
    expect(settled.product).toBe(false);
    expect(settled.domain('docs/domains/alpha.md')).toBe(false);
  });
  test('a domain page that is missing needs the product unit again, which declares the domains, and only that domain is written', () => {
    const plan = unitsNeeded({ productPage: product, domainPages: ['docs/domains/alpha.md'], languageChanged: false });
    expect(plan.product).toBe(true);
    expect(plan.domain('docs/domains/alpha.md')).toBe(false);
    expect(plan.domain('docs/domains/beta.md')).toBe(true);
  });
  test('a changed language needs every page written again', () => {
    const plan = unitsNeeded({ productPage: product, domainPages: ['docs/domains/alpha.md', 'docs/domains/beta.md'], languageChanged: true });
    expect(plan.product).toBe(true);
    expect(plan.domain('docs/domains/alpha.md')).toBe(true);
  });
});

describe('the language is a setting of the manifest', () => {
  test('the manifest names it, a wrong one is a finding with its line, and writing it keeps the comments', () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-language-'));
    try {
      mkdirSync(join(folder, 'madarch'), { recursive: true });
      mkdirSync(join(folder, 'templates'), { recursive: true });
      writeFileSync(join(folder, 'templates', 'a.md'), ':::body\n');
      const text = '# a comment that stays\nkinds:\n  product:\n    template: templates/a.md\n    source: markdown\n    file: docs/product.md\n';
      writeFileSync(join(folder, 'madarch', 'kinds.yaml'), text);
      expect(setKindsLanguage(folder, 'ru')).toBeUndefined();
      const written = readFileSync(join(folder, 'madarch', 'kinds.yaml'), 'utf8');
      expect(written).toContain('# a comment that stays');
      expect(written).toContain('language: ru');
      const read = readKinds(folder);
      expect(read.present && read.manifest.language).toBe('ru');
      expect(setKindsLanguage(folder, 'de')).toContain('"de" is not a language of the wiki');
      const bad = parseKinds('language: de\nkinds: {}\n', 'madarch/kinds.yaml', folder);
      expect(bad.findings).toEqual([{ file: 'madarch/kinds.yaml', line: 1, message: '"language" is "de": the pages are written in en or ru' }]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
