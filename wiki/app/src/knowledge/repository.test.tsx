/**
 * The repository pages of the wiki (madarch-8bdc.2.5, items 2, 3 and 4), tested
 * without a server: the repository with its counts, its gaps and its tree, a
 * folder's page, a file with every fact of it, its text and its history, a
 * commit with the paths it changed, the run page's steps, and the fill card's
 * trace progress and its failure's file and line.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setWikiLanguage } from '../i18n.js';
import { CommitPage, FilePage, FileRows, FolderPage, RepositoryPage, RunPage, bytesText, instantText, mbText, msText } from './repository.js';
import type { CommitPageModel, FilePageModel, FillRunView, FillStepView, FolderPageModel, PageHistoryRow, WikiStatus } from './types.js';

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

/** Two commits of a file's history, as the server states them. */
const HISTORY: PageHistoryRow[] = [
  { commit: 'b'.repeat(40), change: 'modified', added: 2, removed: 1, previousPath: null, date: '2026-11-07T14:00:00+03:00', offsetMin: 180, subject: 'grows', walk: 0 },
  { commit: 'a'.repeat(40), change: 'added', added: 1, removed: 0, previousPath: null, date: '2026-11-07T13:00:00+03:00', offsetMin: 180, subject: 'written', walk: 1 },
];

const FILE = { path: 'src/a.ts', mode: '100644', blob: 'a'.repeat(40), bytes: 20, lines: 1, form: 'text' as const, language: 'ambiguous', candidates: ['TypeScript', 'XML'] };

/** A text file's two lines, as the source view reads them back. */
const TEXT = 'export const a = 1;\nexport const b = 2;\n';

/** One file's page as the server states it: its facts, its as-is commit and its history. */
const page = (file: FilePageModel['file']): FilePageModel => ({
  repository: 'code', asIsCommit: 'b'.repeat(40), file,
  created: { date: '2026-11-07T13:00:00+03:00', offsetMin: 180, commit: 'a'.repeat(40), author: 'Ada' },
  modified: { date: '2026-11-07T14:00:00+03:00', offsetMin: 180, commit: 'b'.repeat(40), author: 'Ada' },
  commitCount: 2, authors: ['Ada'], history: HISTORY, next: null,
});

/**
 * The server as a file page reads it: its own answer, then the file's text (or the refusal the server answers in its
 * place). Every read of the text is kept, so a case can say that a binary file asked for none.
 */
function servingFile(file: FilePageModel, text: { status: number; body: unknown } | null): { reads: URL[] } {
  const reads: URL[] = [];
  (globalThis as { fetch?: unknown }).fetch = async (url: string) => {
    if (url.includes('/api/file')) return new Response(JSON.stringify({ file }));
    if (url.includes('/api/source')) {
      reads.push(new URL(url, 'http://localhost'));
      if (text === null) return new Response(JSON.stringify({ message: 'a binary file has no text to read' }), { status: 415 });
      return new Response(JSON.stringify(text.body), { status: text.status });
    }
    return new Response(JSON.stringify({ message: `no route for ${url}` }), { status: 404 });
  };
  return { reads };
}

const status = (over: Partial<WikiStatus> = {}): WikiStatus => ({
  product: { name: 'shop', id: 'x' }, manifest: 'ok', manifestFile: 'madarch/kinds.yaml', language: 'en', seeded: [], findingCount: 0, kinds: [], groups: [],
  repositories: [{ name: 'code', filled: true }], filled: true, incomplete: false,
  fill: { state: 'done' },
  writer: { state: 'idle', agent: null, units: [] },
  bounds: { turns: 30, minutes: 10, toolCalls: 80, writeAttempts: 5, maxDomains: 12, editorialRequestsPerPage: 2 },
  chosenAgent: null, home: null,
  repository: { name: 'code', url: 'file:///work/code', defaultBranch: 'main', asIsCommit: 'b'.repeat(40), counts: { files: 4, commits: 2, folders: 3 }, gaps: [], steps: { tree: true, history: true } },
  ...over,
});

describe('the numbers and names a page writes', () => {
  test('bytes, times, memory and a date with its offset read as a person reads them', () => {
    expect(bytesText(20)).toBe('20 B');
    expect(bytesText(1407)).toBe('1.4 kB');
    expect(bytesText(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(msText(5.5)).toBe('5.5 ms');
    expect(msText(1500)).toBe('1.50 s');
    expect(mbText(200 * 1024 * 1024)).toBe('200.0 MB');
    // The store states a git date as `%aI` states it: the author's clock and the offset it was written
    // at. The page writes those two numbers, never the clock with a foreign offset appended.
    expect(instantText('2026-11-07T19:14:32+03:00', 180)).toBe('2026-11-07 19:14:32 +03:00');
    expect(instantText('2026-11-07T19:14:32-05:30', -330)).toBe('2026-11-07 19:14:32 -05:30');
    expect(instantText('2026-11-07T19:14:32+00:00', 0)).toBe('2026-11-07 19:14:32 +00:00');
    expect(instantText('2026-11-07T19:14:32', null)).toBe('2026-11-07 19:14:32 UTC');
  });

  test('a table of files links each one and says a binary blob holds no line count', async () => {
    const binary = { ...FILE, path: 'assets/picture.bin', form: 'binary' as const, lines: null, bytes: 6 };
    const container = into(createElement(FileRows, { files: [FILE, binary] }));
    await until(() => container.querySelector('[data-testid=file-rows]') !== null, 'the rows');
    const rows = [...container.querySelectorAll('[data-testid=file-row]')];
    expect(rows.map((row) => row.getAttribute('data-path'))).toEqual(['src/a.ts', 'assets/picture.bin']);
    expect(rows[0]!.textContent).toContain('TypeScript / XML');
    expect(rows[1]!.textContent).toContain('binary');
    expect(rows[1]!.textContent).toContain('—');
  });
});

describe('the repository page', () => {
  test('states its facts, its counts and the root of its tree, with every link to the pages it leads to', async () => {
    const folder: FolderPageModel = { repository: 'code', asIsCommit: 'b'.repeat(40), folder: '', parent: null, folders: ['assets', 'src'], files: [FILE], next: null };
    answer('/api/folder', { folder });
    const container = into(createElement(RepositoryPage, { status: status(), version: 0 }));
    await until(() => container.querySelector('[data-testid=file-rows]') !== null, 'the root files');
    expect(container.querySelector('[data-testid=repository-url]')!.textContent).toBe('file:///work/code');
    expect(container.textContent).toContain('Files: 4 · Commits: 2 · Folders: 3');
    expect(container.querySelector('[data-testid=repository-run-link]')!.textContent).toBe("The run's trace, step by step");
    const folders = [...container.querySelectorAll('[data-testid=folder-row]')].map((row) => row.textContent);
    expect(folders).toEqual(['assets/', 'src/']);
    expect(container.querySelector('[data-testid=file-link]')!.textContent).toBe('a.ts');
    expect(container.querySelector('[data-testid=file-language]')!.textContent).toBe('TypeScript / XML');
    // Every page names the as-is commit it is true at.
    expect(container.querySelector('[data-testid=as-is-link]')!.textContent).toBe('b'.repeat(12));
  });

  test('a gap the fill recorded is stated, with what it is and why', async () => {
    const folder: FolderPageModel = { repository: 'code', asIsCommit: 'b'.repeat(40), folder: '', parent: null, folders: [], files: [], next: null };
    answer('/api/folder', { folder });
    const held = status();
    const container = into(createElement(RepositoryPage, { status: status({ repository: { ...held.repository!, gaps: [{ what: 'code at abc', reason: 'shallow-history' }] } }), version: 0 }));
    await until(() => container.querySelector('[data-testid=repository-gaps]') !== null, 'the gaps');
    expect(container.querySelector('[data-testid=repository-gap]')!.textContent).toBe('code at abc — shallow-history');
  });

  test('a repository the fill could not read is named with its path and its reason', async () => {
    const folder: FolderPageModel = { repository: 'code', asIsCommit: 'b'.repeat(40), folder: '', parent: null, folders: [], files: [], next: null };
    answer('/api/folder', { folder });
    const held = status({ fill: { state: 'done', unread: [{ repository: 'empty-code', path: '/work/products/shop/repos/empty-code', reason: 'the checkout holds no commit yet' }] } });
    const container = into(createElement(RepositoryPage, { status: held, version: 0 }));
    await until(() => container.querySelector('[data-testid=repository-unread]') !== null, 'the unread note');
    expect(container.querySelector('[data-testid=repository-unread-row]')!.textContent).toBe('empty-code (/work/products/shop/repos/empty-code) — the checkout holds no commit yet');
  });

  test('a store whose tree has not run says so and draws no list', async () => {
    const held = status();
    const container = into(createElement(RepositoryPage, { status: status({ repository: { ...held.repository!, asIsCommit: null, counts: { files: 0, commits: 0, folders: 0 }, steps: { tree: false, history: false } } }), version: 0 }));
    await until(() => container.querySelector('[data-testid=repository-empty]') !== null, 'the empty note');
    expect(container.textContent).toContain("the fill has not read this repository's tree");
    expect(container.querySelector('[data-testid=file-rows]')).toBeNull();
  });
});

describe('a folder and a file', () => {
  test('a folder lists its subfolders and its files, links one up and offers the next page', async () => {
    const folder: FolderPageModel = { repository: 'code', asIsCommit: 'b'.repeat(40), folder: 'src', parent: '', folders: ['src/nested'], files: [FILE], next: 'src/z.ts' };
    answer('/api/folder', { folder });
    const container = into(createElement(FolderPage, { path: 'src', after: null, version: 0 }));
    await until(() => container.querySelector('[data-testid=file-rows]') !== null, 'the folder');
    expect(container.querySelector('[data-testid=folder-parent]')!.textContent).toBe('Up one folder');
    expect([...container.querySelectorAll('[data-testid=folder-row]')].map((row) => row.textContent)).toEqual(['nested/']);
    expect(container.textContent).toContain('The next page');
  });

  test('a file states every fact the graph holds of it, its dates and authors, and the commits that touched it', async () => {
    const file: FilePageModel = {
      repository: 'code', asIsCommit: 'b'.repeat(40), file: FILE,
      created: { date: '2026-11-07T13:00:00+03:00', offsetMin: 180, commit: 'a'.repeat(40), author: 'Ada' },
      modified: { date: '2026-11-07T14:00:00+03:00', offsetMin: 180, commit: 'b'.repeat(40), author: 'Ada' },
      commitCount: 2, authors: ['Ada'],
      history: HISTORY,
      next: null,
    };
    answer('/api/file', { file });
    const container = into(createElement(FilePage, { path: 'src/a.ts', after: null, version: 0 }));
    await until(() => container.querySelector('[data-testid=file-facts]') !== null, 'the facts');
    const text = container.textContent ?? '';
    for (const fact of ['100644', 'a'.repeat(40), '20', '1', 'text', 'ambiguous (TypeScript, XML)', 'Ada', 'Commits touching it']) expect(text).toContain(fact);
    // The file's two dates are its commits' own clocks, each with the offset it was written at.
    expect(text).toContain('2026-11-07 13:00:00 +03:00');
    expect(text).toContain('2026-11-07 14:00:00 +03:00');
    expect([...container.querySelectorAll('[data-testid=history-row]')].map((row) => row.textContent)).toEqual([
      expect.stringContaining('2026-11-07'),
      expect.stringContaining('2026-11-07'),
    ]);
    expect(container.querySelectorAll('[data-testid=history-row]').length).toBe(2);
    expect([...container.querySelectorAll('[data-testid=history-row]')].map((row) => row.getAttribute('data-change'))).toEqual(['modified', 'added']);
  });

  test("a text file's page shows its text under the facts and before the history, at the as-is commit it names", async () => {
    const { reads } = servingFile(page({ ...FILE, bytes: TEXT.length, lines: 2, language: 'typescript', candidates: ['TypeScript'] }), { status: 200, body: { repo: 'code', path: 'src/a.ts', language: 'typescript', commit: 'b'.repeat(40), text: TEXT } });
    const container = into(createElement(FilePage, { path: 'src/a.ts', after: null, version: 0 }));
    await until(() => container.querySelector('[data-testid=file-text] [data-testid=source-code]') !== null, 'the text');
    const text = container.querySelector('[data-testid=file-text]')!;
    // The text is read at the as-is commit alone: a file page's address carries `at` for the page of its history it
    // walks, and no such date travels with the text's request.
    expect(text.getAttribute('data-commit')).toBe('b'.repeat(40));
    expect(reads).toHaveLength(1);
    expect(reads[0]!.searchParams.get('repo')).toBe('code');
    expect(reads[0]!.searchParams.get('path')).toBe('src/a.ts');
    expect(reads[0]!.searchParams.has('at')).toBe(false);
    // The lines are the source view's own, numbered from one, with the anchors a `#L12` link opens.
    expect([...text.querySelectorAll('.source-line')].map((line) => line.id)).toEqual(['L1', 'L2']);
    expect(text.querySelector('#L2 .source-text')!.textContent!.trimEnd()).toBe('export const b = 2;');
    // The facts stand above the text and the history below it.
    expect([...container.querySelectorAll('[data-testid=file-facts], [data-testid=file-text], [data-testid=file-history]')].map((one) => one.getAttribute('data-testid')))
      .toEqual(['file-facts', 'file-text', 'file-history']);
    // A commit of the fill elsewhere reads the page again and not its text: what a commit holds never changes.
    rendered!.render(createElement(FilePage, { path: 'src/a.ts', after: null, version: 1 }));
    await new Promise((step) => setTimeout(step, 50));
    expect(reads).toHaveLength(1);
    expect(container.querySelector('[data-testid=file-text] #L2')).not.toBeNull();
  });

  test('a binary file says it is binary and its size in one line, and asks for no text', async () => {
    const { reads } = servingFile(page({ ...FILE, path: 'assets/picture.bin', form: 'binary', lines: null, bytes: 6 }), null);
    const container = into(createElement(FilePage, { path: 'assets/picture.bin', after: null, version: 0 }));
    await until(() => container.querySelector('[data-testid=file-binary]') !== null, 'the binary line');
    expect(container.querySelector('[data-testid=file-binary]')!.textContent).toBe('A binary file, 6 B. Its text is not shown.');
    expect(container.querySelector('[data-testid=source-code]')).toBeNull();
    expect(reads).toHaveLength(0);
    expect(container.querySelector('[data-testid=file-facts]')).not.toBeNull();
    expect(container.querySelector('[data-testid=file-history]')).not.toBeNull();
  });

  test('a refused text is stated in place of the text, and the facts and the history still stand', async () => {
    const refused = 'the file src/a.ts is 5000000 bytes, past the 2097152 the source view shows';
    const { reads } = servingFile(page(FILE), { status: 413, body: { field: 'path', message: refused } });
    const container = into(createElement(FilePage, { path: 'src/a.ts', after: null, version: 0 }));
    await until(() => container.querySelector('[data-testid=file-text-refused]') !== null, 'the refusal');
    expect(container.querySelector('[data-testid=file-text-refused]')!.textContent).toContain(refused);
    expect(container.querySelector('[data-testid=source-code]')).toBeNull();
    expect(reads).toHaveLength(1);
    expect(container.querySelector('[data-testid=file-facts]')).not.toBeNull();
    expect(container.querySelector('[data-testid=file-history]')).not.toBeNull();
  });

  test("a large text file's page opens without freezing it: the project's own violations file is drawn whole", async () => {
    const text = readFileSync(new URL('../../../../.architecture/violations.json', import.meta.url), 'utf8');
    const lines = text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
    const bytes = Buffer.byteLength(text);
    servingFile(page({ ...FILE, path: '.architecture/violations.json', bytes, lines, language: 'json', candidates: ['JSON'] }), { status: 200, body: { repo: 'code', path: '.architecture/violations.json', language: 'json', commit: 'b'.repeat(40), text } });
    const started = performance.now();
    const container = into(createElement(FilePage, { path: '.architecture/violations.json', after: null, version: 0 }));
    await until(() => container.querySelectorAll('[data-testid=file-text] .source-line').length === lines, 'the whole text');
    const opened = performance.now() - started;
    // Every line of the file stands in the page: the source view does not window a long file. Measured on this machine.
    expect(container.querySelector(`#L${lines}`)).not.toBeNull();
    console.log(`[measure] a ${bytesText(bytes)} text file of ${lines} lines opens in ${msText(opened)}`);
    expect(opened).toBeLessThan(10_000);
  }, 120_000);

  test('a deleted path in a commit is not a link to a file page that cannot stand', async () => {
    const commit: CommitPageModel = {
      repository: 'code', asIsCommit: 'b'.repeat(40), hash: 'b'.repeat(40),
      author: { name: 'Ada', email: 'ada@example.test' },
      authorDate: '2026-11-07T14:00:00+03:00', authorOffsetMin: 180,
      commitDate: '2026-11-07T14:00:00+03:00', commitOffsetMin: 180, subject: 'a file goes',
      parents: ['a'.repeat(40)],
      changed: [
        { path: 'src/kept.ts', change: 'modified', added: 1, removed: 1, previousPath: null },
        { path: 'src/gone.ts', change: 'deleted', added: 0, removed: 3, previousPath: null },
      ],
    };
    answer('/api/commit', { commit });
    const container = into(createElement(CommitPage, { hash: 'b'.repeat(40), version: 0 }));
    await until(() => container.querySelector('[data-testid=commit-changed]') !== null, 'the changed paths');
    const links = [...container.querySelectorAll('[data-testid=changed-file]')].map((link) => link.textContent);
    expect(links).toEqual(['src/kept.ts']);
    expect(container.textContent).toContain('14:00:00 +03:00');
    expect(container.textContent).not.toContain('14:00:00+03:00 +03:00');
    expect(container.querySelectorAll('[data-testid=changed-row]').length).toBe(2);
  });
});

describe('the run page', () => {
  test('names each step with its wall clock, its peak memory and its slowest names, read from the trace', async () => {
    const run: FillRunView = {
      runId: 'fill-1', startedAt: '2026-11-07T10:00:00.000Z', finishedAt: '2026-11-07T10:00:01.000Z', wallMs: 1000, spans: 42,
      slowest: [{ name: 'db.transaction', count: 3, selfMs: 200 }, { name: 'process.git', count: 2, selfMs: 150 }],
      steps: [
        { step: 'repository-tree', wallMs: 400, peakRssBytes: 200 * 1024 * 1024, startRssBytes: 100 * 1024 * 1024, slowest: [{ name: 'db.INSERT', count: 10, selfMs: 120 }, { name: 'process.git', count: 1, selfMs: 80 }] },
        { step: 'repository-history', wallMs: 500, peakRssBytes: 220 * 1024 * 1024, startRssBytes: 200 * 1024 * 1024, slowest: [{ name: 'fill.unit', count: 1, selfMs: 300 }] },
      ],
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
    // The memory column says what it measures: the highest resident memory the process reached while the step ran.
    expect(container.querySelector('[data-testid=run-memory-note]')!.textContent).toContain('highest resident memory the process reached while the step ran');
  });

  test('a store with no trace says what the page would need, and never draws empty numbers', async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => new Response(JSON.stringify({ message: 'the store holds no trace' }), { status: 404 });
    const container = into(createElement(RunPage, { run: null, version: 0 }));
    await until(() => container.querySelector('[data-testid=repository-refused]') !== null, 'the refusal');
    expect(container.textContent).toContain('the store holds no trace');
  });
});
