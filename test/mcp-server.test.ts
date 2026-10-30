/**
 * `madarch mcp` (madarch-ztyq.10): the seven tools of decision 0032 served over
 * the Model Context Protocol from a checkout's own graph, read-only, with the
 * working tree's uncommitted edits preferred to the commit's facts and every
 * answer naming the revision it was read at.
 *
 * The cases run on a throwaway repository with neutral names, built here and
 * committed here: the tool listing, one answer of each tool, a query right after
 * an uncommitted edit (which must show the edit), a query after a deleted file
 * (which must not show it), the journal's counts, and one end-to-end run of the
 * command as a client spawns it and speaks to it over standard input and output.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { renderQuestion } from '../src/loop/entities.js';
import { readJournal, summarize } from '../src/mcp/journal.js';
import { RepositorySession } from '../src/mcp/session.js';
import { answerRepositoryMcpMessage } from '../src/mcp/server.js';
import { REPO_TOOL_NAMES } from '../src/mcp/tools.js';

const PROJECT = path.resolve(import.meta.dir, '..');
const REPOSITORY = mkdtempSync(path.join(tmpdir(), 'madarch-mcp-repo-'));
const STATE = mkdtempSync(path.join(tmpdir(), 'madarch-mcp-state-'));
const STORE = path.join(STATE, 'graph');
const COMMIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Ada Example', GIT_AUTHOR_EMAIL: 'ada@example.test', GIT_COMMITTER_NAME: 'Ada Example', GIT_COMMITTER_EMAIL: 'ada@example.test', TZ: 'UTC', LC_ALL: 'C' };

const git = (...args: string[]): string => execFileSync('git', args, { cwd: REPOSITORY, encoding: 'utf8', env: COMMIT_ENV });

function put(relativePath: string, text: string): void {
  mkdirSync(path.dirname(path.join(REPOSITORY, relativePath)), { recursive: true });
  writeFileSync(path.join(REPOSITORY, relativePath), text, 'utf8');
}

const STORE_SOURCE = `/** One item a person saves. */
export interface Item {
  readonly name: string;
  readonly amount: number;
}

/** Saves one item and answers the row it took. */
export function saveItem(item: Item): string {
  return item.name;
}
`;

const LIST_SOURCE = `import { saveItem, type Item } from './store.js';

/** Saves every item of a list, in the order the list reads. */
export function saveAll(items: Item[]): number {
  let saved = 0;
  for (const item of items) {
    saveItem(item);
    saved += 1;
  }
  return saved;
}
`;

const QUESTION = renderQuestion({
  slug: 'saved-items',
  title: 'Are items saved one at a time or in a batch?',
  type: 'gap',
  status: 'open',
  about: ['code.symbol:src/store.ts#saveItem'],
  askedIn: null,
  askedAt: null,
  question: 'Does saving an item write one row, or does the whole list arrive at once?',
  why: 'A report that sums saved rows reads one answer or the other.',
  sides: [{ claim: 'Saving an item answers the row it took.', grounds: ['code.symbol:src/store.ts#saveItem'] }],
  answer: null,
  resolvedBy: [],
  resolvedAt: null,
  writtenAt: [{ repository: 'atlas-kit', commit: 'a'.repeat(40), branch: 'main' }],
});

let session: RepositorySession;

beforeAll(async () => {
  git('init', '-q', '-b', 'main');
  put('package.json', `${JSON.stringify({ name: 'atlas-kit', version: '1.0.0', type: 'module' }, null, 2)}\n`);
  put('src/store.ts', STORE_SOURCE);
  put('src/list.ts', LIST_SOURCE);
  put('README.md', '# Atlas kit\n\nSaves items and counts them.\n');
  put('docs/notes/0001-shape.md', '# Note 0001: items are saved one at a time\n\n## Shape\n\nA list of items is saved one item at a time.\n');
  put('docs/questions/saved-items.md', QUESTION);
  git('add', '-A');
  git('commit', '-q', '-m', 'atlas-kit: save items');
  session = await RepositorySession.open({ repository: REPOSITORY, folder: STORE });
}, 180_000);

afterAll(async () => {
  await session.close();
  rmSync(REPOSITORY, { recursive: true, force: true });
  rmSync(STATE, { recursive: true, force: true });
});

/** One tool's answer, as the tool answers it: the body the protocol layer serialises. */
async function answerOf(tool: string, args: Record<string, unknown>): Promise<{ isError: boolean; answer: Record<string, unknown> }> {
  const answered = await session.call(tool, args);
  return { isError: answered.isError, answer: answered.answer as Record<string, unknown> };
}

const json = (value: unknown): string => JSON.stringify(value);

describe('the served tool surface', () => {
  test('lists the seven tools of decision 0032, in the decision\'s order, each with the writer\'s own schema', async () => {
    const listed = await answerRepositoryMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, session);
    const tools = ((listed?.['result'] as Record<string, unknown>)['tools'] ?? []) as { name: string; description: string; inputSchema: Record<string, unknown> }[];
    expect(tools.map((tool) => tool.name)).toEqual([...REPO_TOOL_NAMES]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema['type']).toBe('object');
    }
    // The tool that writes is not served: a server that could write through a person's checkout would write files they
    // never asked for.
    expect(tools.some((tool) => tool.name === 'write_page')).toBe(false);
  }, 60_000);

  test('initialize answers the protocol version and this server\'s own name', async () => {
    const answered = await answerRepositoryMcpMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, session);
    expect(answered?.['result']).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'madarch' } });
  }, 60_000);

  test('a tool this server does not serve is refused with the tools it does serve', async () => {
    const answered = await answerRepositoryMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'write_page', arguments: {} } }, session);
    expect(answered?.['error']).toMatchObject({ code: -32602 });
    expect(String((answered?.['error'] as Record<string, unknown>)['message'])).toContain('get_symbol');
  }, 60_000);
});

describe('each tool answers from the checkout', () => {
  test('get_symbol answers the declaration with its code, and names the commit it was read at', async () => {
    const { isError, answer } = await answerOf('get_symbol', { name: 'saveItem' });
    expect(isError).toBe(false);
    const head = git('rev-parse', 'HEAD').trim();
    expect((answer['source'] as Record<string, unknown>)['commit']).toBe(head);
    expect((answer['source'] as Record<string, unknown>)['dirty']).toEqual([]);
    expect(answer['selected']).toMatchObject({ key: 'code.symbol:src/store.ts#saveItem', symbolKind: 'function', path: 'src/store.ts' });
    expect(json(answer['selected'])).toContain('export function saveItem(item: Item): string {');
  }, 60_000);

  test('get_context answers the holders and the callers of one entity', async () => {
    const { isError, answer } = await answerOf('get_context', { entity: 'code.symbol:src/store.ts#saveItem', purpose: 'implementation' });
    expect(isError).toBe(false);
    expect(answer['entity']).toMatchObject({ key: 'code.symbol:src/store.ts#saveItem' });
    expect(json(answer)).toContain('code.symbol:src/list.ts#saveAll');
  }, 60_000);

  test('trace_flow walks from a function to the function it calls, with the site of the call', async () => {
    const { isError, answer } = await answerOf('trace_flow', { entry: 'saveAll' });
    expect(isError).toBe(false);
    expect(answer['steps']).toEqual([expect.objectContaining({ relation: 'code.calls', to: expect.objectContaining({ key: 'code.symbol:src/store.ts#saveItem' }), site: expect.objectContaining({ path: 'src/list.ts' }) })]);
  }, 60_000);

  test('get_document_sections answers the document section whose words were asked for', async () => {
    const { isError, answer } = await answerOf('get_document_sections', { intent: 'items saved one item at a time' });
    expect(isError).toBe(false);
    expect(json(answer['sections'])).toContain('doc:docs/notes/0001-shape.md#');
  }, 60_000);

  test('search_pages finds the pages that hold the words, and its evidence names them', async () => {
    const { isError, answer } = await answerOf('search_pages', { text: 'counts them' });
    expect(isError).toBe(false);
    expect((answer['pages'] as { path: string }[]).map((page) => page.path)).toContain('README.md');
    expect(answer['evidence']).toContain('README.md');
  }, 60_000);

  test('get_page answers a document of the checkout as written, by its path', async () => {
    const { isError, answer } = await answerOf('get_page', { page: 'docs/notes/0001-shape.md' });
    expect(isError).toBe(false);
    // The answer holds the document's lines; the file's last line break ends the last line and is not a line of it.
    expect(`${answer['text'] as string}\n`).toBe(readFileSync(path.join(REPOSITORY, 'docs/notes/0001-shape.md'), 'utf8'));
  }, 60_000);

  test('search_questions answers the question the checkout holds, with what it is about', async () => {
    const { isError, answer } = await answerOf('search_questions', {});
    expect(isError).toBe(false);
    expect(answer['total']).toBe(1);
    expect(answer['questions']).toEqual([expect.objectContaining({ id: 'question:saved-items', status: 'open' })]);
  }, 60_000);
});

describe('the working tree is preferred to the commit', () => {
  test('a symbol added without a commit is found at once, marked uncommitted, and named in the answer\'s source', async () => {
    put('src/store.ts', `${STORE_SOURCE}\n/** Drops one item by name. */\nexport function dropItem(name: string): void {\n  void name;\n}\n`);
    const { isError, answer } = await answerOf('get_symbol', { name: 'dropItem' });
    expect(isError).toBe(false);
    const source = answer['source'] as Record<string, unknown>;
    expect(source['dirty']).toEqual([{ path: 'src/store.ts', status: 'modified' }]);
    expect(source['reextracted']).toEqual(['src/store.ts']);
    expect(answer['selected']).toMatchObject({ key: 'code.symbol:src/store.ts#dropItem', uncommitted: true });
    // The code the answer quotes is the working tree's text, which the commit does not hold.
    expect(json(answer['selected'])).toContain('export function dropItem(name: string): void {');
    // The journal keeps what the call cost: the file the layer read again, and the file reads the answer saved.
    const entry = readJournal(session.stateFolder).at(-1)!;
    expect(entry.reextracted).toEqual(['src/store.ts']);
    expect(entry.readsSaved).toBeGreaterThan(0);
    expect(entry.answerBytes).toBeGreaterThan(100);
  }, 60_000);

  test('an edit to a symbol\'s own body is read from the working tree, not from the commit', async () => {
    // A rename of the parameter is read from the working tree's bytes: the signature the answer quotes is the
    // working tree's line, and the commit's line names the old parameter.
    put('src/store.ts', STORE_SOURCE.replace('saveItem(item: Item)', 'saveItem(entry: Item)'));
    const { isError, answer } = await answerOf('get_symbol', { name: 'saveItem' });
    expect(isError).toBe(false);
    expect(json(answer['selected'])).toContain('export function saveItem(entry: Item): string {');
    expect((answer['source'] as Record<string, unknown>)['reextracted']).toEqual(['src/store.ts']);
  }, 60_000);

  test('a file deleted without a commit is gone from the answers of its symbols', async () => {
    rmSync(path.join(REPOSITORY, 'src/list.ts'));
    const { isError, answer } = await answerOf('get_symbol', { name: 'saveAll' });
    expect(isError).toBe(true);
    expect(json(answer)).toContain('no-such-symbol');
    // The commit still holds the symbol; the answer must not.
    git('checkout', '--', 'src/list.ts');
    const back = await answerOf('get_symbol', { name: 'saveAll' });
    expect(back.isError).toBe(false);
  }, 60_000);

  test('a document edited without a commit is read as edited, and the answers say so', async () => {
    put('README.md', '# Atlas kit\n\nSaves items, counts them and trims their names.\n');
    const { isError, answer } = await answerOf('search_pages', { text: 'trims their names' });
    expect(isError).toBe(false);
    expect((answer['pages'] as { path: string }[]).map((page) => page.path)).toEqual(['README.md']);
    expect((answer['source'] as Record<string, unknown>)['dirty']).toContainEqual({ path: 'README.md', status: 'modified' });
    put('README.md', '# Atlas kit\n\nSaves items and counts them.\n');
  }, 60_000);
});

describe('the journal', () => {
  test('keeps one line per call, with the tool, its arguments, the answer\'s size and the files it re-extracted', async () => {
    // A call first, so the source this journal test reads is the one the served revision answers with.
    const warmed = await answerOf('get_page', { page: 'README.md' });
    const before = readJournal(session.stateFolder).length;
    await answerOf('get_symbol', { name: 'saveItem' });
    const entries = readJournal(session.stateFolder);
    expect(entries.length).toBe(before + 1);
    const last = entries.at(-1)!;
    expect(last.tool).toBe('get_symbol');
    expect(last.arguments).toEqual({ name: 'saveItem' });
    expect(last.answerBytes).toBeGreaterThan(100);
    // A file the layer read again is one the answer's source named as changed.
    const dirty = (warmed.answer['source'] as Record<string, unknown>)['dirty'] as { path: string }[];
    expect([...last.reextracted].every((file) => dirty.some((one) => one.path === file))).toBe(true);
    expect(last.readsSaved).toBeGreaterThan(0);
    const summary = summarize(session.stateFolder);
    expect(summary.calls).toBe(entries.length);
    expect(summary.tools.find((one) => one.tool === 'get_symbol')!.calls).toBeGreaterThan(0);
    // The re-extractions a freshness call made are counted where they happened.
    expect(summary.reextractions).toBe(entries.reduce((sum, entry) => sum + entry.reextracted.length, 0));
    expect(entries.filter((entry) => entry.reextracted.length > 0).length).toBeGreaterThan(0);
  }, 60_000);
});

describe('the command as a client starts it', () => {
  test('answers initialize, tools/list and a tool call over standard input and output, and exits 0 at the end of the input', async () => {
    const child = spawn(process.execPath, ['scripts/madarch.ts', 'mcp', '--repo', REPOSITORY, '--store', path.join(STATE, 'e2e')], {
      cwd: PROJECT,
      env: { ...process.env, XDG_STATE_HOME: STATE },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: child.stdout! });
    const waiting: ((line: string) => void)[] = [];
    let buffered: string[] = [];
    lines.on('line', (line) => {
      const next = waiting.shift();
      if (next === undefined) buffered.push(line);
      else next(line);
    });
    const nextLine = async (): Promise<Record<string, unknown>> => {
      const held = buffered.shift();
      const line = held ?? await new Promise<string>((resolve) => waiting.push(resolve));
      return JSON.parse(line) as Record<string, unknown>;
    };
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '0' } } })}\n`);
    const initialized = await nextLine();
    expect((initialized['result'] as Record<string, unknown>)['serverInfo']).toMatchObject({ name: 'madarch' });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    const listed = await nextLine();
    expect(((listed['result'] as Record<string, unknown>)['tools'] as { name: string }[]).map((tool) => tool.name)).toEqual([...REPO_TOOL_NAMES]);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_symbol', arguments: { name: 'saveItem' } } })}\n`);
    const called = await nextLine();
    const content = (called['result'] as Record<string, unknown>)['content'] as { type: string; text: string }[];
    expect(content[0]!.type).toBe('text');
    const body = JSON.parse(content[0]!.text) as Record<string, unknown>;
    expect((body['source'] as Record<string, unknown>)['repository']).toBe(REPOSITORY);
    expect(body['selected']).toMatchObject({ key: 'code.symbol:src/store.ts#saveItem' });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    child.stdin.end();
    expect(await exited).toBe(0);
  }, 180_000);
});
