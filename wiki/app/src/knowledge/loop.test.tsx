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
import { PlanList, ProblemsPage, QuestionPage, QuestionsPage } from './loop.js';
import { addressOfQuestion, kRouteOf } from './routes.js';
import type { Problem, ProblemCategories, ProblemCategory, ProblemItems, ProblemSources, QuestionDetail, QuestionListing, QuestionRow, RefreshPlan } from './types.js';

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

const row = (slug: string, state: QuestionRow['state'], extra: Partial<QuestionRow> = {}): QuestionRow => ({
  slug, id: `question:${slug}`, title: `Title of ${slug}?`, type: 'contradiction', state, askedIn: 'domain:orders', askedAt: '2026-10-23T10:00:00.000Z', about: ['domain:orders'],
  answeredBy: state === 'open' ? null : ADA, answeredAt: state === 'open' ? null : '2026-10-23T11:00:00.000Z', closedBy: state === 'closed' ? ['domain:orders'] : [], ...extra,
});

const detail = (state: QuestionRow['state'], extra: Partial<QuestionDetail> = {}): QuestionDetail => ({
  ...row('discount-percentage', state, { title: 'Is the discount ten percent or what the caller passes?' }),
  file: 'docs/questions/discount-percentage.md',
  question: 'Which discount does an order get?',
  why: 'A shopper is told one number and charged another.',
  sides: [{ claim: 'The README says every order gets ten percent.', grounds: ['doc:README.md#discounts'] }, { claim: 'The code applies the percentage its caller passes.', grounds: ['code.symbol\u003asrc/pricing.ts#discountFor', 'code.file\u003asrc/gone.ts'] }],
  answer: state === 'open' ? null : { text: 'Ten percent for every order.', by: ADA, at: '2026-10-23T11:00:00.000Z' },
  resolvedAt: state === 'closed' ? '2026-10-23T12:00:00.000Z' : null,
  resolutions: {
    'doc:README.md#discounts': { state: 'ok', target: 'madarch:doc:README.md#discounts', kind: 'document', label: 'README.md#discounts', href: '/k/doc?path=README.md#discounts' },
    'code.symbol\u003asrc/pricing.ts#discountFor': { state: 'ok', target: 'x', kind: 'code.symbol', label: 'discountFor', href: null, location: { repo: 'shop', path: 'src/pricing.ts', lineStart: 1, lineEnd: 3, href: '/k/src?repo=shop&path=src%2Fpricing.ts&line=1' } },
    'code.file\u003asrc/gone.ts': { state: 'broken', target: 'x', reason: 'no entity "code.file\u003asrc/gone.ts" in the graph' },
    'domain:orders': { state: 'ok', target: 'x', kind: 'domain', label: 'Orders', href: '/k/e/domain%3Aorders' },
  },
  ...extra,
});

describe('the questions page', () => {
  const listing = (rows: QuestionRow[], problems: string[] = []): QuestionListing => ({ rows, open: rows.filter((r) => r.state === 'open').length, answered: rows.filter((r) => r.state === 'answered').length, closed: rows.filter((r) => r.state === 'closed').length, problems });

  test('lists the questions in groups, open first, each a link to its page with its type, state and where it was asked', async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => json(listing([row('a-open', 'open'), row('b-open', 'open', { type: 'ambiguous-term' }), row('c-answered', 'answered'), row('d-closed', 'closed')]));
    const page = into(createElement(QuestionsPage, { version: 0 }));
    await until(() => page.querySelector('[data-testid=questions-page]') !== null, 'the questions');
    expect(page.querySelector('h1')!.textContent).toBe('Questions');
    expect([...page.querySelectorAll('[data-testid=questions-group]')].map((g) => [g.getAttribute('data-state'), g.querySelector('h2')!.textContent])).toEqual([
      ['open', 'Open (2)'], ['answered', 'Answered, waiting for a refresh (1)'], ['closed', 'Closed by a rewrite (1)'],
    ]);
    const rows = [...page.querySelectorAll('[data-testid=question-row]')];
    expect(rows.map((r) => r.getAttribute('data-question'))).toEqual(['a-open', 'b-open', 'c-answered', 'd-closed']);
    expect(rows[1]!.textContent).toContain('Ambiguous term');
    expect(rows[0]!.querySelector('a')!.getAttribute('href')).toBe('/k/questions/a-open');
    expect(rows[0]!.textContent).toContain('Asked while writing');
    expect(rows[2]!.textContent).toContain('the next refresh uses the answer');
    expect(rows[3]!.textContent).toContain('closed by');
    expect(rows[3]!.querySelector('a[href="/k/e/domain%3Aorders"]')).not.toBeNull();
  });

  test('no questions says when the agent asks one; files that could not be read are named, never left out', async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => json(listing([], ['docs/questions/broken.md:1: the file has no front matter']));
    const page = into(createElement(QuestionsPage, { version: 0 }));
    await until(() => page.querySelector('[data-testid=questions-empty]') !== null, 'the empty page');
    expect(page.querySelector('[data-testid=questions-empty]')!.textContent).toContain('The agent asks one when it finds two sources that disagree');
    expect(page.querySelector('[data-testid=questions-files]')!.textContent).toContain('docs/questions/broken.md:1: the file has no front matter');
  });

  test('is in Russian when the interface is', async () => {
    await setWikiLanguage('ru');
    (globalThis as { fetch?: unknown }).fetch = async () => json(listing([row('a-open', 'open')]));
    const page = into(createElement(QuestionsPage, { version: 0 }));
    await until(() => page.querySelector('[data-testid=questions-page]') !== null, 'the questions');
    expect(page.querySelector('h1')!.textContent).toBe('Вопросы');
    expect(page.querySelector('[data-testid=questions-group] h2')!.textContent).toBe('Открытые (1)');
    expect(page.querySelector('[data-testid=question-row]')!.textContent).toContain('Источники расходятся');
  });
});

describe('a question\'s page', () => {
  test('shows the question, why it matters and both sides with their grounds as links, a ground that does not resolve marked, and the form to answer', async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => json(detail('open'));
    const page = into(createElement(QuestionPage, { slug: 'discount-percentage', version: 0, refresh: () => undefined }));
    await until(() => page.querySelector('[data-testid=question-page]') !== null, 'the question');
    expect(page.querySelector('[data-testid=question-title]')!.textContent).toBe('Is the discount ten percent or what the caller passes?');
    expect(page.querySelector('[data-testid=question-state]')!.textContent).toBe('Open');
    expect(page.querySelector('[data-testid=question-text]')!.textContent).toBe('Which discount does an order get?');
    expect(page.querySelector('[data-testid=question-why]')!.textContent).toBe('A shopper is told one number and charged another.');
    const sides = [...page.querySelectorAll('[data-testid=question-side]')];
    expect(sides.every((side) => side.classList.contains('min-w-0'))).toBe(true);
    expect(sides[0]!.parentElement!.classList.contains('[overflow-wrap:anywhere]')).toBe(true);
    expect(sides.map((side) => side.querySelector('p')!.textContent)).toEqual(['The README says every order gets ten percent.', 'The code applies the percentage its caller passes.']);
    expect(sides[0]!.querySelector('a')!.getAttribute('href')).toBe('/k/doc?path=README.md#discounts');
    expect(sides[1]!.querySelector('[data-testid=code-place]')!.textContent).toBe('src/pricing.ts:1–3');
    expect(sides[1]!.querySelector('[data-testid=ref-broken]')!.getAttribute('title')).toBe('no entity "code.file\u003asrc/gone.ts" in the graph');
    expect(page.querySelector('[data-testid=question-affects]')!.textContent).toContain('Orders'.toLowerCase());
    expect(page.querySelector('[data-testid=answer-where]')!.textContent).toBe('The answer is saved in docs/questions/discount-percentage.md in the product repository and committed under your git name and email. It is marked local, not verified.');
    expect((page.querySelector('[data-testid=answer-save]') as HTMLButtonElement).disabled).toBe(true);
  });

  test('the answer is posted, the page is read again, and a refusal of the server is shown in its words', async () => {
    const calls: string[] = [];
    let refused = true;
    (globalThis as { fetch?: unknown }).fetch = async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}${init?.body === undefined ? '' : ` ${String(init.body)}`}`);
      if (url.endsWith('/api/k/answer')) {
        if (refused) { refused = false; return json({ error: { message: 'git has no user.name for /product, so the wiki cannot say who wrote this' } }, 409); }
        return json({ question: 'discount-percentage', state: 'answered', committed: false, note: 'the file was written but git could not commit it', by: ADA, at: '2026-10-23T11:00:00.000Z' });
      }
      return json(detail('open'));
    };
    let refreshed = 0;
    const page = into(createElement(QuestionPage, { slug: 'discount-percentage', version: 0, refresh: () => { refreshed += 1; } }));
    await until(() => page.querySelector('[data-testid=answer-text]') !== null, 'the form');
    const text = page.querySelector('[data-testid=answer-text]') as HTMLTextAreaElement;
    // The change handler React keeps on the element: happy-dom does not carry a typed value into React's change event.
    const type = (value: string): void => {
      const key = Object.keys(text).find((name) => name.startsWith('__reactProps$'));
      if (key === undefined) throw new Error('the textarea carries no React props');
      (text as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>)[key]!.onChange({ target: { value } });
    };
    type('Ten percent for every order.');
    await until(() => !(page.querySelector('[data-testid=answer-save]') as HTMLButtonElement).disabled, 'the enabled button');
    (page.querySelector('[data-testid=answer-save]') as HTMLButtonElement).click();
    await until(() => page.querySelector('[data-testid=answer-refused]') !== null, 'the refusal');
    expect(page.querySelector('[data-testid=answer-refused]')!.textContent).toBe('Could not save the answer: git has no user.name for /product, so the wiki cannot say who wrote this');
    expect(calls.at(-1)).toBe('POST /api/k/answer {"question":"discount-percentage","text":"Ten percent for every order."}');
    expect(refreshed).toBe(0);
    (page.querySelector('[data-testid=answer-save]') as HTMLButtonElement).click();
    await until(() => refreshed === 1, 'the refresh');
    await until(() => page.querySelector('[data-testid=answer-note]') !== null, 'the note');
    expect(page.querySelector('[data-testid=answer-note]')!.textContent).toBe('the file was written but git could not commit it');
  });

  test('an answered question shows the answer with who gave it and the mark, and says the next refresh uses it', async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => json(detail('answered'));
    const page = into(createElement(QuestionPage, { slug: 'discount-percentage', version: 0, refresh: () => undefined }));
    await until(() => page.querySelector('[data-testid=question-answer]') !== null, 'the answer');
    expect(page.querySelector('[data-testid=answer-form]')).toBeNull();
    expect(page.querySelector('[data-testid=answer-quote]')!.textContent).toBe('Ten percent for every order.');
    expect(page.querySelector('[data-testid=author-line]')!.textContent).toContain('Ada Reader <ada@example.test>');
    expect(page.querySelector('[data-testid=verified-mark]')!.textContent).toBe('local, not verified');
    expect(page.querySelector('[data-testid=answer-waiting]')!.textContent).toContain('The next refresh edits the pages this question touches');
  });

  test('a closed question names the page whose rewrite used the answer', async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => json(detail('closed'));
    const page = into(createElement(QuestionPage, { slug: 'discount-percentage', version: 0, refresh: () => undefined }));
    await until(() => page.querySelector('[data-testid=answer-closed]') !== null, 'the closed note');
    expect(page.querySelector('[data-testid=question-state]')!.textContent).toBe('Closed');
    expect(page.querySelector('[data-testid=answer-closed]')!.textContent).toContain('a refresh used this answer on');
    expect(page.querySelector('[data-testid=answer-closed] a')!.getAttribute('href')).toBe('/k/e/domain%3Aorders');
  });

  test('a question that is not there says why', async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => json({ error: { message: 'there is no question x' }, message: 'there is no question x' }, 404);
    const page = into(createElement(QuestionPage, { slug: 'x', version: 0, refresh: () => undefined }));
    await until(() => page.querySelector('[data-testid=question-error]') !== null, 'the error');
    expect(page.querySelector('[data-testid=question-error]')!.textContent).toContain('There is no such question');
  });
});

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
      if (url.endsWith('/api/k/problem-task')) return json({ task: { slug: 'fix-security-sql-input', id: 'task:fix-security-sql-input', file: 'docs/tasks/fix-security-sql-input.md', title: 'Fix', status: 'open' }, state: 'created', committed: true });
      if (url.endsWith('/api/k/problem-dismiss')) return json({ file: 'docs/problems/sql.md', committed: true });
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
          dismissed: 0, sections: { code: 0, documents: 0, wiki: 0 }, severities: { blocker: 0, critical: 0, major: 0, minor: 0, info: 0 }, notes, starter: [],
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
        place: { label: 'src/orders.ts:35', href: '/k/e/code.file%3Asrc%2Forders.ts', key: 'code.file:src/orders.ts' },
        entity: { label: 'db.query', href: '/k/e/code.sql-sink%3Asrc%2Forders.ts%2335', key: 'code.sql-sink:src/orders.ts#35' },
        evidence: [
          { label: 'req.query.q', href: '/k/e/code.input%3Areq.query.q', key: 'code.input:req.query.q' },
          { label: 'selectOrders', href: '/k/e/code.sql-build%3Asrc%2Forders.ts%2330', key: 'code.sql-build:src/orders.ts#30' },
          { label: 'db.query', href: '/k/e/code.sql-sink%3Asrc%2Forders.ts%2335', key: 'code.sql-sink:src/orders.ts#35' },
        ],
      }),
      id: 'security.sql-input\u0000code.sql-sink:src/orders.ts#35\u0000code.sql-build:src/orders.ts#30',
      scope: { type: 'file', path: 'src/orders.ts' },
    };
    const documents: Problem = {
      ...problem('document-contradiction', { id: 'd1', reason: 'The README says ten percent; the code applies what its caller passes.', file: 'docs/questions/discount-percentage.md', line: 1 }),
      place: { label: 'docs/questions/discount-percentage.md:1', href: '/k/src?path=docs%2Fquestions%2Fdiscount-percentage.md&line=1', key: null }, entity: { label: 'Which discount?', href: '/k/questions/discount-percentage', key: 'question:discount' },
      evidence: [{ label: 'Which discount?', href: '/k/questions/discount-percentage', key: 'question:discount' }],
    };
    const wiki = problem('broken-link', {
      id: 'w1',
      place: { label: 'domain:orders', href: '/k/e/domain%3Aorders', key: 'domain:orders' }, entity: { label: 'Orders', href: '/k/e/domain%3Aorders', key: 'domain:orders' },
    });
    let dismissed = false;
    const calls: string[] = [];
    const base = serve([code, documents, wiki]);
    (globalThis as { fetch?: unknown }).fetch = async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}${init?.body === undefined ? '' : ` ${String(init.body)}`}`);
      if (url.endsWith('/api/k/problem-dismiss')) dismissed = true;
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
    expect(row.querySelector('[data-testid=problem-place] a')!.getAttribute('href')).toBe('/k/e/code.file%3Asrc%2Forders.ts');
    expect(row.querySelector('[data-testid=problem-place] a:nth-of-type(2)')!.textContent).toBe('db.query');
    expect([...row.querySelectorAll('[data-testid=problem-evidence] a')].map((link) => link.textContent)).toEqual(['req.query.q', 'selectOrders', 'db.query']);
    expect(row.querySelector('[data-testid=problem-evidence]')!.textContent).toStartWith('Evidence: req.query.q → selectOrders → db.query');
    expect(row.querySelector('[data-testid=problem-task]')).not.toBeNull();
    expect(row.querySelector('[data-testid=problem-not-a-problem]')).not.toBeNull();
    (row.querySelector('[data-testid=problem-task]') as HTMLButtonElement).click();
    await until(() => row.querySelector('[data-testid=problem-done]') !== null, 'the created task');
    const problemId = 'security.sql-input\u0000code.sql-sink:src/orders.ts#35\u0000code.sql-build:src/orders.ts#30';
    expect(calls.at(-1)).toBe(`POST /api/k/problem-task ${JSON.stringify({ id: problemId })}`);
    expect(refreshed).toBe(1);
    (row.querySelector('[data-testid=problem-not-a-problem]') as HTMLButtonElement).click();
    await until(() => row.querySelector('[data-testid=problem-dismiss-reason]') !== null, 'the dismissal form');
    const text = row.querySelector('[data-testid=problem-dismiss-reason]') as HTMLTextAreaElement;
    const key = Object.keys(text).find((name) => name.startsWith('__reactProps$'));
    if (key === undefined) throw new Error('the textarea carries no React props');
    (text as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>)[key]!.onChange({ target: { value: 'The query is built from a constant.' } });
    await until(() => !(row.querySelector('[data-testid=problem-dismiss-confirm]') as HTMLButtonElement).disabled, 'the enabled dismissal');
    (row.querySelector('[data-testid=problem-dismiss-confirm]') as HTMLButtonElement).click();
    await until(() => row.querySelector('[data-testid=problem-done]') !== null, 'the dismissal');
    expect(calls.some((call) => call === `POST /api/k/problem-dismiss ${JSON.stringify({ id: problemId, reason: 'The query is built from a constant.' })}`)).toBe(true);
    expect(dismissed).toBe(true);
  });

  test('a product with no problem says so', async () => {
    (globalThis as { fetch?: unknown }).fetch = serve([]);
    const page = into(createElement(ProblemsPage, { version: 0 }));
    await until(() => page.querySelector('[data-testid=problems-empty]') !== null, 'the empty page');
    expect(page.querySelector('[data-testid=problems-empty]')!.textContent).toBe('No problems. Every ground and link resolves and nobody has recorded a correction.');
  });
});

describe('the refresh plan', () => {
  const plan = (over: Partial<RefreshPlan> = {}): RefreshPlan => ({
    languageChanged: false,
    pages: [
      { id: 'domain:orders', path: 'docs/domains/orders.md', reasons: [{ kind: 'answer', question: 'q', title: 'Which discount does an order get?' }, { kind: 'ground-changed', statement: 'tax-at-checkout', ground: 'doc:README.md#tax' }] },
      { id: 'product:shop', path: 'docs/product.md', reasons: [{ kind: 'new-service', services: ['code.service:shipping'] }, { kind: 'correction', correction: 'c', statement: 'product:shop#takes-orders' }] },
    ],
    unchanged: ['docs/domains/payments.md'], unplaced: [], problems: [], ...over,
  });

  test('lists the pages the agent will edit with why, and says how many stay as they are', async () => {
    const list = into(createElement(PlanList, { plan: plan() }));
    await until(() => list.querySelector('[data-testid=refresh-plan]') !== null, 'the plan');
    expect(list.querySelector('[data-testid=plan-summary]')!.textContent).toBe('The agent will edit 2 pages: 1 page stays as it is and costs no agent run.');
    expect([...list.querySelectorAll('[data-testid=plan-page]')].map((p) => p.getAttribute('data-path'))).toEqual(['docs/domains/orders.md', 'docs/product.md']);
    expect([...list.querySelectorAll('[data-testid=plan-reason]')].map((r) => r.textContent)).toEqual([
      'answer to «Which discount does an order get?»', 'doc:README.md#tax changed (statement tax-at-checkout)', 'new in the code and named by no page: code.service:shipping', 'corrected statement takes-orders',
    ]);
  });

  test('nothing to do says nothing needs the agent; an answer that reaches no page and a file that could not be read are told', async () => {
    const nothing = into(createElement(PlanList, { plan: plan({ pages: [], unchanged: ['docs/product.md'] }) }));
    await until(() => nothing.querySelector('[data-testid=plan-nothing]') !== null, 'the empty plan');
    expect(nothing.querySelector('[data-testid=plan-nothing]')!.textContent).toContain('Nothing needs the agent');
    rendered?.unmount();
    document.body.innerHTML = '';
    const told = into(createElement(PlanList, { plan: plan({ unplaced: [{ kind: 'question', slug: 'lost', title: 'Lost one', reason: 'no page of the product is about code.service:nowhere' }], problems: ['docs/questions/broken.md:1: the file has no front matter'] }) }));
    await until(() => told.querySelector('[data-testid=plan-unplaced]') !== null, 'the unplaced');
    expect(told.querySelector('[data-testid=plan-unplaced]')!.textContent).toBe('Not placed: «Lost one». no page of the product is about code.service:nowhere');
    expect(told.querySelector('[data-testid=plan-problem]')!.textContent).toBe('docs/questions/broken.md:1: the file has no front matter');
  });

  test('in Russian the counts take the Russian plural', async () => {
    await setWikiLanguage('ru');
    const many = plan({ pages: Array.from({ length: 5 }, (_, i) => ({ id: `domain:d${i}`, path: `docs/domains/d${i}.md`, reasons: [{ kind: 'language' as const, from: 'en', to: 'ru' }] })), unchanged: [] });
    const list = into(createElement(PlanList, { plan: many }));
    await until(() => list.querySelector('[data-testid=plan-summary]') !== null, 'the plan');
    expect(list.querySelector('[data-testid=plan-summary]')!.textContent).toBe('Агент поправит 5 страниц:');
    expect(list.querySelector('[data-testid=plan-reason]')!.textContent).toBe('перевести с en на ru, сохранив основания');
    rendered?.unmount();
    document.body.innerHTML = '';
    const two = into(createElement(PlanList, { plan: plan() }));
    await until(() => two.querySelector('[data-testid=plan-summary]') !== null, 'the plan');
    expect(two.querySelector('[data-testid=plan-summary]')!.textContent).toBe('Агент поправит 2 страницы: 1 страница остаётся как есть и не стоит запуска агента.');
  });

  });

describe('the routes of the loop', () => {
  test('questions, a question and the problems have addresses; a question or a correction opened as an entity opens the loop\'s page', () => {
    expect(kRouteOf('/k/questions')).toEqual({ name: 'questions' });
    expect(kRouteOf('/k/questions/discount-percentage')).toEqual({ name: 'question', slug: 'discount-percentage' });
    expect(kRouteOf('/k/problems')).toEqual({ name: 'problems' });
    expect(kRouteOf('/k/e/question%3Adiscount-percentage')).toEqual({ name: 'question', slug: 'discount-percentage' });
    expect(kRouteOf('/k/e/correction%3Ac')).toEqual({ name: 'problems' });
    expect(kRouteOf('/k/e/domain%3Aorders')).toEqual({ name: 'entity', id: 'domain:orders' });
    expect(addressOfQuestion('discount-percentage')).toBe('/k/questions/discount-percentage');
  });
});
