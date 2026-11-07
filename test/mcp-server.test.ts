/**
 * `madarch mcp` (madarch-ztyq.10; madarch-8bdc.2.5, item 3): the seven tools of decision
 * 0032 served over the Model Context Protocol from the store the one fill published,
 * read-only, and every answer naming the as-is commit the store was filled from and the
 * paths the working tree changed since it.
 *
 * The cases run on a throwaway repository with neutral names, built here and
 * committed here: the tool listing, one answer of each tool, the source an edit and a
 * deletion name (the facts stay the filled commit's, and the changed path is said), the
 * journal's counts, and one end-to-end run of the command as a client spawns it and
 * speaks to it over standard input and output.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { renderQuestion } from '../src/loop/entities.js';
import { readJournal, summaryLines, summarize } from '../src/mcp/journal.js';
import { RepositorySession } from '../src/mcp/session.js';
import { answerRepositoryMcpMessage } from '../src/mcp/server.js';
import { SERVED_TOOL_NAMES } from '../src/mcp/server.js';

const PROJECT = path.resolve(import.meta.dir, '..');
const REPOSITORY = mkdtempSync(path.join(tmpdir(), 'madarch-mcp-repo-'));
const STATE = mkdtempSync(path.join(tmpdir(), 'madarch-mcp-state-'));
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
  session = await RepositorySession.open({ repository: REPOSITORY });
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
  test('lists this step\'s five tools and the seven of decision 0032, in the served order, each with its own schema', async () => {
    const listed = await answerRepositoryMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, session);
    const tools = ((listed?.['result'] as Record<string, unknown>)['tools'] ?? []) as { name: string; description: string; inputSchema: Record<string, unknown> }[];
    expect(tools.map((tool) => tool.name)).toEqual([...SERVED_TOOL_NAMES]);
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

describe('each tool of this step answers from the store', () => {
  test('list_files pages the store\'s files, and names the as-is commit it was read at', async () => {
    const { isError, answer } = await answerOf('list_files', { prefix: 'src/' });
    expect(isError).toBe(false);
    const head = git('rev-parse', 'HEAD').trim();
    expect((answer['source'] as Record<string, unknown>)['commit']).toBe(head);
    expect((answer['source'] as Record<string, unknown>)['changed']).toEqual([]);
    expect((answer['files'] as { path: string }[]).map((file) => file.path)).toEqual(['src/list.ts', 'src/store.ts']);
  }, 60_000);

  test('get_file answers one file with every fact of it, its dates and its authors', async () => {
    const { isError, answer } = await answerOf('get_file', { path: 'src/store.ts' });
    expect(isError).toBe(false);
    expect(answer).toMatchObject({ path: 'src/store.ts', mode: '100644', form: 'text', authors: ['Ada Example'] });
    expect((answer['created'] as Record<string, unknown>)['commit']).toBe(git('rev-parse', 'HEAD').trim());
  }, 60_000);

  test('get_file_history answers the commit that wrote the file, and get_commit names its changed paths', async () => {
    const history = await answerOf('get_file_history', { path: 'src/store.ts' });
    expect(history.isError).toBe(false);
    const commits = history.answer['commits'] as { commit: string; change: string }[];
    expect(commits).toEqual([expect.objectContaining({ commit: git('rev-parse', 'HEAD').trim(), change: 'added' })]);
    const commit = await answerOf('get_commit', { hash: commits[0]!.commit });
    expect(commit.isError).toBe(false);
    expect((commit.answer['changed'] as { path: string }[]).map((one) => one.path)).toEqual(['README.md', 'docs/notes/0001-shape.md', 'docs/questions/saved-items.md', 'package.json', 'src/list.ts', 'src/store.ts']);
  }, 60_000);

  test('get_repository answers the repository\'s facts, its counts and its gaps', async () => {
    const { isError, answer } = await answerOf('get_repository', {});
    expect(isError).toBe(false);
    expect(answer).toMatchObject({ repository: path.basename(REPOSITORY), asIsCommit: git('rev-parse', 'HEAD').trim(), counts: { files: 6, commits: 1, folders: 4 }, gaps: [] });
  }, 60_000);

  test('the seven tools of decision 0032 name the step that has not run, rather than an empty answer', async () => {
    for (const [tool, step] of [['get_symbol', 'syntax'], ['trace_flow', 'semantic-resolution'], ['get_page', 'document-index']] as const) {
      const { isError, answer } = await answerOf(tool, { name: 'saveItem', entry: 'saveAll', page: 'README.md' });
      expect(isError).toBe(true);
      expect(answer['error']).toMatchObject({ code: 'step-not-run', step });
      expect((answer['source'] as Record<string, unknown>)['commit']).toBe(git('rev-parse', 'HEAD').trim());
    }
  }, 60_000);
});

describe('the checkout is named, and the facts stay the filled commit\'s', () => {
  test('a file added without a commit is not a fact of the store, and the answer names the changed path', async () => {
    put('src/extra.ts', '/** A file the commit does not hold. */\nexport const extra = 1;\n');
    const { isError, answer } = await answerOf('get_file', { path: 'src/extra.ts' });
    // The store is the fill's at the commit: a file the working tree added is not re-read by a second path.
    expect(isError).toBe(true);
    expect((answer['error'] as Record<string, unknown>)['code']).toBe('no-such-file');
    const source = answer['source'] as Record<string, unknown>;
    expect(source['commit']).toBe(git('rev-parse', 'HEAD').trim());
    expect(source['changed']).toEqual([{ path: 'src/extra.ts', status: 'untracked' }]);
    // The journal keeps what the call cost: no file was re-extracted, and the answer's size is counted.
    const entry = readJournal(session.stateFolder).at(-1)!;
    expect(entry.tool).toBe('get_file');
    expect(entry.answerBytes).toBeGreaterThan(50);
    rmSync(path.join(REPOSITORY, 'src/extra.ts'));
  }, 60_000);

  test('an edit to a file is not read: the store\'s bytes answer, and the file is named as changed', async () => {
    put('src/store.ts', STORE_SOURCE.replace('saveItem(item: Item)', 'saveItem(entry: Item)'));
    const { isError, answer } = await answerOf('get_file', { path: 'src/store.ts' });
    expect(isError).toBe(false);
    expect((answer['blob'] as string).length).toBe(40);
    expect((answer['source'] as Record<string, unknown>)['changed']).toEqual([{ path: 'src/store.ts', status: 'modified' }]);
    git('checkout', '--', 'src/store.ts');
  }, 60_000);

  test('a file deleted without a commit is still the commit\'s record, and the deletion is named', async () => {
    rmSync(path.join(REPOSITORY, 'src/list.ts'));
    const { isError, answer } = await answerOf('get_file', { path: 'src/list.ts' });
    expect(isError).toBe(false);
    expect((answer['path'] as string)).toBe('src/list.ts');
    expect((answer['source'] as Record<string, unknown>)['changed']).toContainEqual({ path: 'src/list.ts', status: 'deleted' });
    git('checkout', '--', 'src/list.ts');
    const back = await answerOf('get_file', { path: 'src/list.ts' });
    expect(back.isError).toBe(false);
  }, 60_000);
});

describe('the journal', () => {
  test('keeps one line per call, with the tool, its arguments, the answer\'s size and the commit it was read at', async () => {
    const warmed = await answerOf('list_files', { prefix: 'src/' });
    expect(warmed.isError).toBe(false);
    const before = readJournal(session.stateFolder).length;
    await answerOf('get_file', { path: 'README.md' });
    const entries = readJournal(session.stateFolder);
    expect(entries.length).toBe(before + 1);
    const last = entries.at(-1)!;
    expect(last.tool).toBe('get_file');
    expect(last.arguments).toEqual({ path: 'README.md' });
    expect(last.answerBytes).toBeGreaterThan(100);
    // The entry names the commit the store is the graph of; no file is re-extracted, because the store is the facts.
    expect(last.revision.commit).toBe(git('rev-parse', 'HEAD').trim());
    expect((last as unknown as Record<string, unknown>)['reextracted']).toBeUndefined();
    const summary = summarize(session.stateFolder);
    expect(summary.calls).toBe(entries.length);
    expect(summary.tools.find((one) => one.tool === 'get_file')!.calls).toBeGreaterThan(0);
  }, 60_000);
});

describe('the command as a client starts it', () => {
  test('answers initialize, tools/list and a tool call over standard input and output, and exits 0 at the end of the input', async () => {
    const child = spawn(process.execPath, ['scripts/madarch.ts', 'mcp', '--repo', REPOSITORY], {
      cwd: PROJECT,
      // The store the button fills lives under the madarch home: this run's own, so it never reads another.
      env: { ...process.env, MADARCH_HOME: path.join(STATE, 'madarch') },
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
    expect(((listed['result'] as Record<string, unknown>)['tools'] as { name: string }[]).map((tool) => tool.name)).toEqual([...SERVED_TOOL_NAMES]);
    // A client that asks while the graph is building is told so and asks again (madarch-ztyq.10 review): the server
    // answers its handshake at once and builds in the background.
    let body: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 120; attempt++) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3 + attempt, method: 'tools/call', params: { name: 'get_file', arguments: { path: 'src/store.ts' } } })}\n`);
      const called = await nextLine();
      const content = (called['result'] as Record<string, unknown>)['content'] as { type: string; text: string }[];
      expect(content[0]!.type).toBe('text');
      body = JSON.parse(content[0]!.text) as Record<string, unknown>;
      if ((body['error'] as Record<string, unknown> | undefined)?.['code'] !== 'graph-building') break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(body['error']).toBeUndefined();
    expect((body['source'] as Record<string, unknown>)['repository']).toBe(REPOSITORY);
    expect(body).toMatchObject({ path: 'src/store.ts', form: 'text', mode: '100644' });
    // The seven tools of decision 0032 name the step that has not run, rather than an empty answer.
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 200, method: 'tools/call', params: { name: 'get_symbol', arguments: { name: 'saveItem' } } })}\n`);
    const later = await nextLine();
    const laterBody = JSON.parse(((later['result'] as Record<string, unknown>)['content'] as { text: string }[])[0]!.text) as Record<string, unknown>;
    expect((laterBody['error'] as Record<string, unknown>)['code']).toBe('step-not-run');
    expect((laterBody['error'] as Record<string, unknown>)['step']).toBe('syntax');
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    child.stdin.end();
    expect(await exited).toBe(0);
  }, 180_000);
});
