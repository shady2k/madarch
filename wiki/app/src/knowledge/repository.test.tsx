/**
 * The repository's entity-page blocks (madarch-hsqs stage A), tested without a server: the repository's facts, a
 * folder's subfolders and files, a file's facts, the run page's steps, and the numbers and dates a page writes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setWikiLanguage } from '../i18n.js';
import { FileFactsBlock, FolderFileTable, FolderBlock, RepositoryFactsBlock, RunPage, bytesText, instantText, mbText, msText } from './repository.js';
import type { FileBlockData, FillRunView, FillStepView, FolderBlockData, RepositoryBlockData } from './types.js';

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

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = '';
  delete (globalThis as { fetch?: unknown }).fetch;
});

/** A fetch answering one path's body, and refusing everything else. */
const answer = (path: string, body: unknown): void => {
  (globalThis as { fetch?: unknown }).fetch = async (url: string) => (url.includes(path) ? new Response(JSON.stringify(body)) : new Response(JSON.stringify({ message: `no ${path} in ${url}` }), { status: 404 }));
};

const file = (over: Partial<FileBlockData> = {}): FileBlockData => ({
  repository: 'code', path: 'src/a.ts', id: 'code.file:code/src/a.ts', href: '/e/code.file%3Acode%2Fsrc%2Fa.ts',
  mode: '100644', blob: 'a'.repeat(40), bytes: 20, lines: 1, form: 'text', language: 'ambiguous', candidates: ['TypeScript', 'XML'],
  created: { date: '2026-11-07T13:00:00+03:00', offsetMin: 180, commit: 'a'.repeat(40), author: 'Ada', href: '/e/code.commit%3A' + 'a'.repeat(40) },
  modified: { date: '2026-11-07T14:00:00+03:00', offsetMin: 180, commit: 'b'.repeat(40), author: 'Ada', href: '/e/code.commit%3A' + 'b'.repeat(40) },
  commitCount: 2, authors: ['Ada'], ...over,
});

const repository = (over: Partial<RepositoryBlockData> = {}): RepositoryBlockData => ({
  nodeId: '1', id: 'code.repository:code', name: 'code', url: 'file:///work/code', defaultBranch: 'main',
  asIsCommit: 'b'.repeat(40), asIsHref: '/e/code.commit%3A' + 'b'.repeat(40),
  counts: { files: 4, commits: 2, folders: 3 }, gaps: [], steps: { tree: true, history: true }, ...over,
});

const folder = (over: Partial<FolderBlockData> = {}): FolderBlockData => ({
  repository: 'code', id: 'code.directory:code/src', folder: 'src', parent: { path: '', href: '/e/code.directory%3Acode%2F' },
  folders: [{ path: 'src/nested', href: '/e/code.directory%3Acode%2Fsrc%2Fnested' }], files: [file()], nextHref: '/e/code.directory%3Acode%2Fsrc?after=src%2Fz.ts', ...over,
});

describe('the numbers and names a page writes', () => {
  test('bytes, times, memory and a date with its offset read as a person reads them', () => {
    expect(bytesText(20)).toBe('20 B');
    expect(bytesText(1407)).toBe('1.4 kB');
    expect(bytesText(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(msText(5.5)).toBe('5.5 ms');
    expect(msText(1500)).toBe('1.50 s');
    expect(mbText(200 * 1024 * 1024)).toBe('200.0 MB');
    expect(instantText('2026-11-07T19:14:32+03:00', 180)).toBe('2026-11-07 19:14:32 +03:00');
    expect(instantText('2026-11-07T19:14:32-05:30', -330)).toBe('2026-11-07 19:14:32 -05:30');
    expect(instantText('2026-11-07T19:14:32+00:00', 0)).toBe('2026-11-07 19:14:32 +00:00');
    expect(instantText('2026-11-07T19:14:32', null)).toBe('2026-11-07 19:14:32 UTC');
  });

  test('a table of files links each one and says a binary blob holds no line count', async () => {
    const binary = file({ path: 'assets/picture.bin', href: '/e/code.file%3Acode%2Fassets%2Fpicture.bin', form: 'binary', lines: null, bytes: 6 });
    const container = into(createElement(FolderFileTable, { files: [file(), binary] }));
    await until(() => container.querySelector('[data-testid=file-rows]') !== null, 'the rows');
    const rows = [...container.querySelectorAll('[data-testid=file-row]')];
    expect(rows.map((row) => row.getAttribute('data-path'))).toEqual(['src/a.ts', 'assets/picture.bin']);
    expect(rows[0]!.textContent).toContain('TypeScript / XML');
    expect(rows[1]!.textContent).toContain('binary');
    expect(rows[1]!.textContent).toContain('—');
    expect(rows[0]!.querySelector('a')!.getAttribute('href')).toBe('/e/code.file%3Acode%2Fsrc%2Fa.ts');
  });
});

describe('the repository block', () => {
  test('states its facts, its counts, its steps and its as-is commit', async () => {
    const container = into(createElement(RepositoryFactsBlock, { data: repository() }));
    await until(() => container.querySelector('[data-testid=repository-block]') !== null, 'the block');
    expect(container.querySelector('[data-testid=repository-url]')!.textContent).toBe('file:///work/code');
    expect(container.textContent).toContain('Files: 4 · Commits: 2 · Folders: 3');
    expect(container.querySelector('[data-testid=repository-run-link]')!.textContent).toBe("The run's trace, step by step");
    expect(container.querySelector('[data-testid=as-is-link]')!.textContent).toBe('b'.repeat(12));
    expect(container.querySelector('[data-testid=as-is-link]')!.getAttribute('href')).toBe('/e/code.commit%3A' + 'b'.repeat(40));
  });

  test('a gap the fill recorded is stated, with what it is and why', async () => {
    const container = into(createElement(RepositoryFactsBlock, { data: repository({ gaps: [{ what: 'code at abc', reason: 'shallow-history' }] }) }));
    await until(() => container.querySelector('[data-testid=repository-gaps]') !== null, 'the gaps');
    expect(container.querySelector('[data-testid=repository-gap]')!.textContent).toBe('code at abc — shallow-history');
  });

  test('the last run and the repositories it could not read are stated', async () => {
    const container = into(createElement(RepositoryFactsBlock, {
      data: repository(),
      run: { finishedAt: '2026-11-07T10:00:01.000Z', wallMs: 1500 },
      unread: [{ repository: 'empty-code', path: '/work/products/shop/repos/empty-code', reason: 'the checkout holds no commit yet' }],
    }));
    await until(() => container.querySelector('[data-testid=repository-unread]') !== null, 'the unread note');
    expect(container.querySelector('[data-testid=repository-unread-row]')!.textContent).toBe('empty-code (/work/products/shop/repos/empty-code) — the checkout holds no commit yet');
    expect(container.textContent).toContain('1.50 s');
  });

  test('a store whose tree has not run says so and draws no list', async () => {
    const container = into(createElement(RepositoryFactsBlock, { data: repository({ asIsCommit: null, asIsHref: null, counts: { files: 0, commits: 0, folders: 0 }, steps: { tree: false, history: false } }) }));
    await until(() => container.querySelector('[data-testid=repository-empty]') !== null, 'the empty note');
    expect(container.textContent).toContain("the fill has not read this repository's tree");
    expect(container.querySelector('[data-testid=file-rows]')).toBeNull();
  });
});

describe('a folder and a file', () => {
  test('a folder lists its subfolders and its files, links one up and offers the next page', async () => {
    const container = into(createElement(FolderBlock, { data: folder() }));
    await until(() => container.querySelector('[data-testid=file-rows]') !== null, 'the folder');
    expect(container.querySelector('[data-testid=folder-parent]')!.textContent).toBe('Up one folder');
    expect([...container.querySelectorAll('[data-testid=folder-row]')].map((row) => row.textContent)).toEqual(['nested/']);
    expect(container.textContent).toContain('The next page');
    expect(container.querySelector('[data-testid=folder-link]')!.getAttribute('href')).toBe('/e/code.directory%3Acode%2Fsrc%2Fnested');
    expect(container.querySelector('[data-testid=folder-more]')!.getAttribute('href')).toBe('/e/code.directory%3Acode%2Fsrc?after=src%2Fz.ts');
  });

  test('a file states every fact the graph holds of it, its dates and its authors', async () => {
    const container = into(createElement(FileFactsBlock, { data: file() }));
    await until(() => container.querySelector('[data-testid=file-facts]') !== null, 'the facts');
    const text = container.textContent ?? '';
    for (const fact of ['100644', 'a'.repeat(40), '20', '1', 'text', 'ambiguous (TypeScript, XML)', 'Ada', '2']) expect(text).toContain(fact);
    expect(text).toContain('2026-11-07 13:00:00 +03:00');
    expect(text).toContain('2026-11-07 14:00:00 +03:00');
  });
});

describe('the run page', () => {
  test('names each step with its wall clock, its peak memory and its slowest names, read from the trace', async () => {
    const run: FillRunView = {
      runId: 'fill-1', startedAt: '2026-11-07T10:00:00.000Z', finishedAt: '2026-11-07T10:00:01.000Z', wallMs: 1000, spans: 42,
      slowest: [{ name: 'db.transaction', count: 3, selfMs: 200 }, { name: 'process.git', count: 2, selfMs: 150 }],
      agentUsage: { lines: [], inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: [], turns: 0, stops: [] },
      steps: [
        { step: 'repository-tree', wallMs: 400, peakRssBytes: 200 * 1024 * 1024, startRssBytes: 100 * 1024 * 1024, slowest: [{ name: 'db.INSERT', count: 10, selfMs: 120 }, { name: 'process.git', count: 1, selfMs: 80 }] },
        { step: 'repository-history', wallMs: 500, peakRssBytes: 220 * 1024 * 1024, startRssBytes: 200 * 1024 * 1024, slowest: [{ name: 'fill.unit', count: 1, selfMs: 300 }] },
      ],
    };
    run.agentUsage = {
      lines: [{ kind: 'doc.term', field: 'definition', model: 'sonnet', plugin: 'glossary', inputTokens: 800, outputTokens: 200, totalTokens: 1000, cost: [{ currency: 'USD', amount: 0.02 }], turns: 1, stopped: { bound: 'tokens', scope: 'plugin' } }],
      inputTokens: 800, outputTokens: 200, totalTokens: 1000, cost: [{ currency: 'USD', amount: 0.02 }], turns: 1,
      stops: [{ kind: 'doc.term', field: 'definition', model: 'sonnet', bound: 'tokens', scope: 'plugin' }],
    };
    answer('/api/run', { run });
    const container = into(createElement(RunPage, { run: null, version: 0 }));
    await until(() => container.querySelector('[data-testid=run-steps]') !== null, 'the steps');
    const firstStep: FillStepView = run.steps[0]!;
    expect(firstStep.step).toBe('repository-tree');
    const steps = [...container.querySelectorAll('[data-testid=run-step]')];
    expect(steps.map((step) => step.getAttribute('data-step'))).toEqual(['repository-tree', 'repository-history']);
    const cells = (step: Element): string[] => [...step.querySelectorAll('td')].map((cell) => cell.textContent ?? '');
    expect(cells(steps[0]!)[1]).toBe('400.0 ms');
    expect(cells(steps[0]!)[2]).toBe('200.0 MB');
    expect(cells(steps[0]!)[3]).toContain('db.INSERT');
    expect(cells(steps[1]!)[1]).toBe('500.0 ms');
    expect(container.textContent).toContain('1.00 s wall clock over 42 spans');
    expect(container.querySelector('[data-testid=run-memory-note]')!.textContent).toContain('highest resident memory the process reached while the step ran');
    // What the model calls cost, read from the same trace: the model, the tokens and the bound a turn stopped at.
    const usage = container.querySelector('[data-testid=run-usage]')!;
    expect(usage.textContent).toContain('800 in · 200 out · 1,000 total');
    expect(usage.textContent).toContain('0.02 USD');
    expect(usage.querySelector('[data-testid=run-usage-stop]')!.textContent).toBe('stopped: tokens bound');
  });

  test('a store with no trace says what the page would need, and never draws empty numbers', async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => new Response(JSON.stringify({ message: 'the store holds no trace' }), { status: 404 });
    const container = into(createElement(RunPage, { run: null, version: 0 }));
    await until(() => container.querySelector('[data-testid=run-error]') !== null, 'the refusal');
    expect(container.textContent).toContain('the store holds no trace');
  });
});
