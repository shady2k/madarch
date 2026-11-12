/**
 * The loop's pages in the app (madarch-m38l.7), tested without a server: the
 * questions and a question's page where a person answers, the problems with who
 * fixes each, and the refresh plan in both languages. Every request is answered
 * by a stub giving the server's own shapes (src/loop/views.ts, src/loop/plan.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setWikiLanguage } from '../i18n.js';
import { ProblemsPage } from './loop.js';
import { addressOfEntity, addressOfKind, wikiRouteOf, WIKI_QUESTIONS } from './routes.js';
import type { Problem, ProblemCategories, ProblemCategory, ProblemItems, ProblemSources } from './types.js';

type ProblemNote = { message: string; textKey?: string; textArgs?: Record<string, string | number> };

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  await setWikiLanguage('en');
});

afterAll(async () => {
  await new Promise((rest) => setTimeout(rest, 50));
  GlobalRegistrator.unregister();
});

let rendered: Root | undefined;
function into(element: ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  rendered = createRoot(container);
  rendered.render(element);
  return container;
}

async function until(holds: () => boolean | undefined, what: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (holds()) return;
    await new Promise((step) => setTimeout(step, 10));
  }
  throw new Error(`never came to ${what}; the tree holds: ${document.body.innerHTML.slice(0, 2000)}`);
}

afterEach(async () => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = '';
  delete (globalThis as { fetch?: unknown }).fetch;
  window.history.replaceState({}, '', '/');
  await setWikiLanguage('en');
});

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const ADA = { name: 'Ada Reader', email: 'ada@example.test', verified: 'local, not verified' };

describe('the problems page', () => {
  const RULE_OF: Record<string, { rule: string; section: ProblemCategory['section']; sonar: ProblemCategory['sonar']; severity: ProblemCategory['severity'] }> = {
    correction: { rule: 'wiki.correction', section: 'wiki', sonar: 'bug', severity: 'major' },
    'ground-removed': { rule: 'wiki.ground-removed', section: 'wiki', sonar: 'bug', severity: 'major' },
    'broken-link': { rule: 'wiki.broken-link', section: 'wiki', sonar: 'bug', severity: 'major' },
    'unreadable-file': { rule: 'wiki.unreadable-file', section: 'wiki', sonar: 'bug', severity: 'major' },
    'sql-input': { rule: 'security.sql-input', section: 'code', sonar: 'vulnerability', severity: 'blocker' },
    'document-contradiction': { rule: 'document.contradiction', section: 'documents', sonar: 'bug', severity: 'major' },
  };
  const problem = (kind: Problem['kind'], extra: Partial<Problem> = {}): Problem => {
    const meta = RULE_OF[kind] ?? { rule: kind, section: 'wiki' as const, sonar: 'code-smell' as const, severity: 'minor' as const };
    return {
      kind, fixer: kind === 'unreadable-file' || kind === 'unplaced' ? 'person' : 'agent', closed: false, page: 'domain:orders', pageTitle: 'Orders', statement: 'ten-percent-discount', sentence: 'Orders get a ten percent discount.',
      target: 'x', reason: 'a reason', file: 'docs/domains/orders.md', line: 12, by: null, at: null,
      section: meta.section, rule: meta.rule, sonar: meta.sonar, severity: meta.severity, ...extra,
    };
  };

  /** The server's three levels over one fixed set of problems, paged the way the real routes page them. */
  const serve = (problems: Problem[], notes: ProblemNote[] = []) => {
    const pageOf = <T extends { id?: string; key?: string }>(rows: T[], after: string | null, key: (row: T) => string): T[] => {
      const start = after === null ? 0 : rows.findIndex((row) => key(row) > after);
      return start < 0 ? [] : rows.slice(start, start + 100);
    };
    return async (url: string, _init?: RequestInit): Promise<Response> => {
      if (url.endsWith('/api/problem-dismiss')) return json({ file: 'docs/problems/sql.md', committed: true });
      const parsed = new URL(url, 'http://localhost');
      const rule = parsed.searchParams.get('rule');
      const source = parsed.searchParams.get('source');
      const after = parsed.searchParams.get('after');
      if (rule === null) {
        const byRule = new Map<string, Problem[]>();
        for (const row of problems) { const held = byRule.get(row.rule!); if (held === undefined) byRule.set(row.rule!, [row]); else held.push(row); }
        const categories: ProblemCategory[] = [...byRule.entries()].map(([id, rows]) => ({
          rule: id, kind: rows[0]!.kind, section: rows[0]!.section!, sonar: rows[0]!.sonar!, severity: rows[0]!.severity!, fixer: rows[0]!.fixer,
          count: rows.length, open: rows.filter((row) => !row.closed).length, closed: rows.filter((row) => row.closed).length,
        })).sort((a, b) => a.section.localeCompare(b.section) || a.rule.localeCompare(b.rule));
        const body: ProblemCategories = {
          categories, total: problems.length, open: problems.filter((row) => !row.closed).length, closed: problems.filter((row) => row.closed).length,
          dismissed: 0, sections: { code: 0, documents: 0, wiki: 0 }, severities: { blocker: 0, critical: 0, major: 0, minor: 0, info: 0 }, notes,
        };
        for (const row of problems) { body.sections[row.section!] += 1; body.severities[row.severity!] += 1; }
        return json(body);
      }
      const rows = problems.filter((row) => row.rule === rule);
      if (source === null) {
        const grouped = new Map<string, Problem[]>();
        for (const row of rows) { const key = row.page ?? row.file; const held = grouped.get(key); if (held === undefined) grouped.set(key, [row]); else held.push(row); }
        const all = [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, held]) => ({
          key, label: held[0]!.pageTitle ?? key, page: held[0]!.page, pageTitle: held[0]!.pageTitle, file: held[0]!.file,
          count: held.length, open: held.filter((row) => !row.closed).length,
        }));
        const shown = pageOf(all, after, (entry) => entry.key);
        const last = shown[shown.length - 1];
        const body: ProblemSources = {
          rule, kind: rows[0]!.kind, section: rows[0]!.section!, sonar: rows[0]!.sonar!, severity: rows[0]!.severity!,
          count: rows.length, open: rows.filter((row) => !row.closed).length, closed: rows.filter((row) => row.closed).length,
          totalSources: all.length, sources: shown, next: shown.length < all.length ? (last?.key ?? null) : null,
        };
        return json(body);
      }
      const held = rows.filter((row) => (row.page ?? row.file) === source).sort((a, b) => (a.id ?? '').localeCompare(b.id ?? ''));
      const shown = pageOf(held, after, (row) => row.id ?? '');
      const last = shown[shown.length - 1];
      const body: ProblemItems = {
        rule, source, count: held.length, open: held.filter((row) => !row.closed).length, closed: held.filter((row) => row.closed).length,
        problems: shown, next: shown.length < held.length ? (last?.id ?? null) : null,
      };
      return json(body);
    };
  };

  const openCategory = async (page: HTMLElement, rule: string): Promise<void> => {
    (page.querySelector(`[data-testid=problem-category][data-rule="${rule}"]`) as HTMLElement).click();
    await until(() => page.querySelector('[data-testid=problem-sources]') !== null, `the sources of ${rule}`);
  };
  const openSource = async (page: HTMLElement): Promise<HTMLElement> => {
    (page.querySelector('[data-testid=problem-source] summary') as HTMLElement).click();
    await until(() => page.querySelector('[data-testid=problem-items] [data-testid=problem-row]') !== null, 'the items');
    return page.querySelector('[data-testid=problem-items] [data-testid=problem-row]') as HTMLElement;
  };

  test('one row per category with its count; a source opens to the problems, which say what is wrong, where and who fixes it', async () => {
    (globalThis as { fetch?: unknown }).fetch = serve([
      problem('correction', { id: 'c1', reason: 'The discount is whatever the caller passes.', by: ADA, at: '2026-10-23T11:45:00.000Z', file: 'docs/corrections/c.md', line: null, target: 'c' }),
      problem('ground-removed', { id: 'g1', target: 'doc:README.md#tax', reason: 'doc:README.md#tax is no longer in shop at the commit the graph describes' }),
      problem('broken-link', { id: 'b1', target: 'code.file\u003asrc/gone.ts', reason: 'no entity "code.file\u003asrc/gone.ts" in the graph or among the product\'s Markdown pages' }),
      problem('unreadable-file', { id: 'u1', page: null, pageTitle: null, statement: null, sentence: null, reason: 'the file has no front matter', file: 'docs/questions/broken.md', line: 1 }),
      problem('correction', { id: 'c2', closed: true, reason: 'Old.', file: 'docs/corrections/old.md', line: null, by: ADA, at: '2026-10-22T11:45:00.000Z' }),
    ], [{ message: 'the pages name no single code repository' }]);
    const page = into(createElement(ProblemsPage, { version: 0 }));
    await until(() => page.querySelector('[data-testid=problems-page]') !== null, 'the problems');
    expect(page.querySelector('h1')!.textContent).toBe('Problems');
    expect(page.querySelector('[data-testid=problems-note]')!.textContent).toContain('no single code repository');
    const correctionCategory = page.querySelector('[data-testid=problem-category][data-rule="wiki.correction"]')!;
    expect(correctionCategory.querySelector('[data-testid=problem-category-count]')!.textContent).toBe('2');
    expect(page.querySelector('[data-testid=problem-categories]')!.textContent).toContain('wiki.correction');
    expect(page.querySelector('[data-testid=problems-total]')!.textContent).toBe('4 open of 5 problems');

    await openCategory(page, 'wiki.correction');
    expect(page.querySelector('[data-testid=problem-sources]')!.textContent).toContain('Orders');
    await openSource(page);
    const open = page.querySelector('[data-testid=problem-items] [data-testid=problem-row][data-closed="false"]') as HTMLElement;
    expect(open.textContent).toContain('A person says this statement is wrong');
    expect(open.querySelector('[data-testid=problem-sentence]')!.textContent).toBe('«Orders get a ten percent discount.»');
    expect(open.querySelector('[data-testid=problem-reason]')!.textContent).toBe('The discount is whatever the caller passes.');
    expect(open.querySelector('[data-testid=problem-fixer]')!.textContent).toBe('The agent fixes it');
    expect(open.querySelector('[data-testid=problem-who]')!.textContent).toContain('The agent fixes it at the next refresh: it edits this page using the reason above');
    expect(open.querySelector('[data-testid=verified-mark]')!.textContent).toBe('local, not verified');
    expect(page.querySelectorAll('[data-testid=problem-items] [data-testid=problem-row]').length).toBe(2);
  });

  test('words manifest findings in Russian and keeps raw diagnostics behind engineer details', async () => {
    await setWikiLanguage('ru');
    (globalThis as { fetch?: unknown }).fetch = serve([
      problem('unreadable-file', { id: 'm1', page: null, pageTitle: null, statement: null, sentence: null, reason: 'kind "question": "group" names a group of "groups" but has the wrong shape, got "product"', file: 'madarch/kinds.yaml', line: 8 }),
    ]);
    const page = into(createElement(ProblemsPage, { version: 0 }));
    await until(() => page.querySelector('[data-testid=problems-page]') !== null, 'the problems');
    await openCategory(page, 'wiki.unreadable-file');
    const row = await openSource(page);
    expect(row.querySelector('[data-testid=problem-reason]')!.textContent).toBe('Вид «Вопрос» ссылается на группу «product», которой нет в манифесте.');
    expect(row.querySelector('[data-testid=problem-details]')).not.toBeNull();
    expect(row.querySelector('[data-testid=problem-details]')!.textContent).toContain('names a group of');
    await setWikiLanguage('en');
  });

  test('a finding says its rule, Sonar kind and severity, place, entity, evidence and actions', async () => {
    const code: Problem = {
      ...problem('sql-input', {
        reason: 'req.query.q reaches selectOrders, which builds SQL text by joining strings, and db.query runs that text as it is.',
        file: 'src/orders.ts', line: 35, page: null, pageTitle: null, statement: null, sentence: null,
        place: { label: 'src/orders.ts:35', href: '/e/code.file%3Asrc%2Forders.ts', key: 'code.file:src/orders.ts' },
        entity: { label: 'db.query', href: '/e/code.sql-sink%3Asrc%2Forders.ts%2335', key: 'code.sql-sink:src/orders.ts#35' },
        evidence: [
          { label: 'req.query.q', href: '/e/code.input%3Areq.query.q', key: 'code.input:req.query.q' },
          { label: 'selectOrders', href: '/e/code.sql-build%3Asrc%2Forders.ts%2330', key: 'code.sql-build:src/orders.ts#30' },
          { label: 'db.query', href: '/e/code.sql-sink%3Asrc%2Forders.ts%2335', key: 'code.sql-sink:src/orders.ts#35' },
        ],
      }),
      id: 'security.sql-input\u0000code.sql-sink:src/orders.ts#35\u0000code.sql-build:src/orders.ts#30',
      scope: { type: 'file', path: 'src/orders.ts' },
    };
    const documents: Problem = {
      ...problem('document-contradiction', { id: 'd1', reason: 'The README says ten percent; the code applies what its caller passes.', file: 'docs/questions/discount-percentage.md', line: 1 }),
      place: { label: 'docs/questions/discount-percentage.md:1', href: '/src?path=docs%2Fquestions%2Fdiscount-percentage.md&line=1', key: null }, entity: { label: 'Which discount?', href: '/e/question%3Adiscount', key: 'question:discount' },
      evidence: [{ label: 'Which discount?', href: '/e/question%3Adiscount', key: 'question:discount' }],
    };
    const wiki = problem('broken-link', {
      id: 'w1',
      place: { label: 'domain:orders', href: '/e/domain%3Aorders', key: 'domain:orders' }, entity: { label: 'Orders', href: '/e/domain%3Aorders', key: 'domain:orders' },
    });
    let dismissed = false;
    const calls: string[] = [];
    const base = serve([code, documents, wiki]);
    (globalThis as { fetch?: unknown }).fetch = async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}${init?.body === undefined ? '' : ` ${String(init.body)}`}`);
      if (url.endsWith('/api/problem-dismiss')) dismissed = true;
      return await base(url, init);
    };
    let refreshed = 0;
    const page = into(createElement(ProblemsPage, { version: 0, refresh: () => { refreshed += 1; } }));
    await until(() => page.querySelector('[data-testid=problems-page]') !== null, 'the problems');
    await openCategory(page, 'security.sql-input');
    const row = await openSource(page);
    expect(row.getAttribute('data-rule')).toBe('security.sql-input');
    expect(row.querySelector('[data-testid=problem-rule]')!.textContent).toBe('Untrusted input reaches SQL');
    expect(row.querySelector('[data-testid=problem-sonar]')!.textContent).toBe('Vulnerability');
    expect(row.querySelector('[data-testid=problem-severity]')!.textContent).toBe('Blocker');
    expect(row.querySelector('[data-testid=problem-reason]')!.textContent).toContain('req.query.q reaches selectOrders');
    expect(row.querySelector('[data-testid=problem-place] a')!.getAttribute('href')).toBe('/e/code.file%3Asrc%2Forders.ts');
    expect(row.querySelector('[data-testid=problem-place] a:nth-of-type(2)')!.textContent).toBe('db.query');
    expect([...row.querySelectorAll('[data-testid=problem-evidence] a')].map((link) => link.textContent)).toEqual(['req.query.q', 'selectOrders', 'db.query']);
    expect(row.querySelector('[data-testid=problem-evidence]')!.textContent).toStartWith('Evidence: req.query.q → selectOrders → db.query');
    expect(row.querySelector('[data-testid=problem-task]')).toBeNull();
    expect(row.querySelector('[data-testid=problem-not-a-problem]')).not.toBeNull();
    const problemId = 'security.sql-input\u0000code.sql-sink:src/orders.ts#35\u0000code.sql-build:src/orders.ts#30';
    (row.querySelector('[data-testid=problem-not-a-problem]') as HTMLButtonElement).click();
    await until(() => row.querySelector('[data-testid=problem-dismiss-reason]') !== null, 'the dismissal form');
    const text = row.querySelector('[data-testid=problem-dismiss-reason]') as HTMLTextAreaElement;
    const key = Object.keys(text).find((name) => name.startsWith('__reactProps$'));
    if (key === undefined) throw new Error('the textarea carries no React props');
    (text as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>)[key]!.onChange({ target: { value: 'The query is built from a constant.' } });
    await until(() => !(row.querySelector('[data-testid=problem-dismiss-confirm]') as HTMLButtonElement).disabled, 'the enabled dismissal');
    (row.querySelector('[data-testid=problem-dismiss-confirm]') as HTMLButtonElement).click();
    await until(() => row.querySelector('[data-testid=problem-done]') !== null, 'the dismissal');
    expect(calls.some((call) => call === `POST /api/problem-dismiss ${JSON.stringify({ id: problemId, reason: 'The query is built from a constant.' })}`)).toBe(true);
    expect(dismissed).toBe(true);
    expect(refreshed).toBe(1);
  });

  test('a product with no problem says so', async () => {
    (globalThis as { fetch?: unknown }).fetch = serve([]);
    const page = into(createElement(ProblemsPage, { version: 0 }));
    await until(() => page.querySelector('[data-testid=problems-empty]') !== null, 'the empty page');
    expect(page.querySelector('[data-testid=problems-empty]')!.textContent).toBe('No problems. Every ground and link resolves and nobody has recorded a correction.');
  });
});

describe('questions and tasks use ordinary graph routes', () => {
  test('entry links open the declared kind lists', () => {
    expect(wikiRouteOf(WIKI_QUESTIONS)).toEqual({ name: 'kind', kind: 'question' });
    expect(wikiRouteOf(addressOfKind('task'))).toEqual({ name: 'kind', kind: 'task' });
  });
  test('question, correction and task references keep the ordinary entity detail', () => {
    for (const id of ['question:discount', 'correction:discount', 'task:discount']) {
      expect(wikiRouteOf(addressOfEntity(id))).toEqual({ name: 'entity', id, after: null });
    }
  });
  test('retired dedicated pages do not create a second path', () => {
    for (const path of ['/questions', '/questions/discount', '/tasks', '/task']) expect(wikiRouteOf(path)).toBeNull();
  });
});
