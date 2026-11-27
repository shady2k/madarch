/**
 * The logs page on the packaged wiki (madarch-64o5.200, ALX-1936): the page reads `Query.logs` through `POST /graphql`
 * (madarch-64o5.88), and the api role answers it in the read worker. The worker needs the product's store folder and the
 * knowledge root its logs stand under; a descriptor that left them out answered `data: { logs: null }`, and the
 * non-nullable field turned that into `Cannot return null for non-nullable field Query.logs` — the "Журналы" screen of
 * a fresh packaged product showed an error in place of the machine's logs. How each log is parsed, filtered and paged is
 * `logs.test.ts`; this file covers the one production entry point that answers the page.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { knowledgeRootOf } from '../src/product/store.js';
import { gitEnv } from './git-env.js';
import { writeFolderManifest } from './catalog-folder-fixture.js';
import { activateTestProduct, retainTestStorePreparationOwner } from './prepared-server.js';

const IDENTITY = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };

/**
 * The product's one kind: the page asks for logs, and a product's schema is derived from the catalogue it publishes, so
 * the fixture declares a kind without plugins — the read below needs no catalogue entity.
 */
const MANIFEST = `kinds:
  product:
    source: graph
    title: title
    key: [slug]
    fields:
      - { name: slug, type: text, producers: [start] }
      - { name: title, type: text, producers: [start] }
`;

/**
 * One page of every log, as the page's own operation asks for it: a JSON field, no selection set. The operation mirrors
 * `wiki/app/src/components/logs-query.ts`, and a moment is epoch milliseconds there too, so `from` and `before` are the
 * schema's `Float` (madarch-64o5.200): a 32-bit `Int` refuses a real date before the read starts.
 */
const LOGS_QUERY = 'query Logs($sources: [String!], $level: String, $run: String, $q: String, $from: Float, $before: Float, $limit: Int) { logs(sources: $sources, level: $level, run: $run, q: $q, from: $from, before: $before, limit: $limit) }';

/**
 * What the page sends when a reader leaves every filter alone (madarch-64o5.200): each filter the page does not hold is
 * an explicit null, which GraphQL's nullable arguments pass to the reader as it came. The page sends this at its first
 * load and when the level filter is reset, and the reader must read it as no filter at all.
 */
const NO_FILTER: Readonly<Record<string, unknown>> = { sources: null, level: null, run: null, q: null, from: null, before: null, limit: null };

/** The two engine records' own moments, in epoch milliseconds: a real time, past what a 32-bit GraphQL `Int` carries. */
const STARTED = Date.parse('2026-11-27T18:00:00.000Z');
const WARNED = Date.parse('2026-11-27T18:00:01.000Z');

interface LogsAnswer {
  readonly entries: readonly { readonly at: number | null; readonly source: string; readonly level: string; readonly message: string; readonly code: string | null }[];
  readonly more: boolean;
  readonly scanned: number;
  readonly truncated: boolean;
  readonly runs: readonly string[];
  readonly sources: readonly string[];
  readonly levels: readonly string[];
}

let work = '';
let home = '';
let folder = '';
let closeOwner: (() => Promise<void>) | undefined;

/** The engine's own records, where the api role keeps the trace of the process it serves from. */
function writeEngineLog(knowledgeRoot: string): void {
  mkdirSync(join(knowledgeRoot, 'traces'), { recursive: true });
  const records = [
    { time: '2026-11-27T18:00:00.000Z', level: 'info', message: 'fill started' },
    { time: '2026-11-27T18:00:01.000Z', level: 'warn', message: 'the plugin read a file its parser does not know' },
  ];
  writeFileSync(join(knowledgeRoot, 'traces', 'server-77.log.jsonl'), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
}

/** One ask of the production entry point the page uses, refused loudly rather than read as an empty page. */
async function logsOf(product: KnowledgeProduct, variables: Record<string, unknown>): Promise<LogsAnswer> {
  const answer = await product.graphql({ query: LOGS_QUERY, variables });
  const body = answer.body as { data?: { logs?: LogsAnswer | null }; errors?: readonly { message: string }[] };
  if (body.errors !== undefined) throw new Error(`the graph refused the logs read: ${body.errors.map((error) => error.message).join('; ')}`);
  if (body.data?.logs === undefined || body.data.logs === null) throw new Error(`the graph answered no logs page: ${JSON.stringify(body.data)}`);
  return body.data.logs;
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'madarch-logs-graphql-'));
  home = join(work, 'products');
  folder = join(home, 'logs-case');
  mkdirSync(join(folder, 'madarch'), { recursive: true });
  writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: logs-case\nname: logs-case\n');
  writeFolderManifest(folder, MANIFEST);
  execFileSync('git', ['init', '-q', folder], { env: gitEnv(IDENTITY) });
  execFileSync('git', ['-C', folder, '-c', 'commit.gpgsign=false', 'add', '-A'], { env: gitEnv(IDENTITY) });
  execFileSync('git', ['-C', folder, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'the fixture product'], { env: gitEnv(IDENTITY) });
  closeOwner = await retainTestStorePreparationOwner();
  await activateTestProduct(folder, home);
  writeEngineLog(knowledgeRootOf(home));
}, 60_000);

afterAll(async () => {
  await closeOwner?.();
  if (work !== '') rmSync(work, { recursive: true, force: true });
});

test('the logs page answers a real record through the product\'s one read API', async () => {
  const api = new KnowledgeProduct({ productFolder: folder, storeRoot: knowledgeRootOf(home) });
  try {
    const page = await logsOf(api, {});
    // The page holds both records oldest first, and the engine's own message carries the code the page words.
    expect(page.entries.map((entry) => entry.message)).toEqual(['fill started', 'the plugin read a file its parser does not know']);
    expect(page.entries[0]).toMatchObject({ source: 'engine', level: 'info', code: 'fill-started' });
    expect(page.more).toBe(false);
    expect(page.sources).toEqual(['engine', 'fill', 'plugin', 'agent', 'store', 'trace']);
    expect(page.levels).toEqual(['debug', 'info', 'warn', 'error']);
    // A page keeps the newest of what it read and says what it left behind it.
    const newest = await logsOf(api, { limit: 1 });
    expect(newest.entries).toHaveLength(1);
    expect(newest.entries[0]).toMatchObject({ level: 'warn', message: 'the plugin read a file its parser does not know' });
    expect(newest.more).toBe(true);
    // The page words the two records by their own level: a quietest level keeps warnings and errors.
    const warnings = await logsOf(api, { sources: ['engine'], level: 'warn' });
    expect(warnings.entries.map((entry) => entry.message)).toEqual(['the plugin read a file its parser does not know']);
    expect(warnings.more).toBe(false);
  } finally { await api.close(); }
}, 60_000);

test('a read that matches no record answers a structured empty page, not an error', async () => {
  const api = new KnowledgeProduct({ productFolder: folder, storeRoot: knowledgeRootOf(home) });
  try {
    const page = await logsOf(api, { q: 'text no log holds' });
    expect(page.entries).toEqual([]);
    expect(page.more).toBe(false);
    expect(page.truncated).toBe(false);
    // The reader still learns which sources and levels the page can ask for; no fill run stands behind the store yet.
    expect(page.runs).toEqual([]);
    expect(page.sources).toEqual(['engine', 'fill', 'plugin', 'agent', 'store', 'trace']);
    // The typed empty page answers the page's own shape, so the screen draws its empty state rather than a failure.
    expect(page.levels).toEqual(['debug', 'info', 'warn', 'error']);
  } finally { await api.close(); }
}, 60_000);

test('the page\'s own explicit nulls answer the whole page, for All levels and a reset filter alike', async () => {
  const api = new KnowledgeProduct({ productFolder: folder, storeRoot: knowledgeRootOf(home) });
  try {
    // The first load of the screen: every filter null. Before the correction the reader refused `level: null` with
    // `"level" is one of debug, info, warn, error, got null`, so the screen failed before it drew a row.
    const all = await logsOf(api, { ...NO_FILTER });
    expect(all.entries.map((entry) => entry.message)).toEqual(['fill started', 'the plugin read a file its parser does not know']);
    // A selected level beside the same nulls keeps the entries that level and louder.
    const warnings = await logsOf(api, { ...NO_FILTER, level: 'warn' });
    expect(warnings.entries.map((entry) => entry.message)).toEqual(['the plugin read a file its parser does not know']);
    // A reset back to All is the same ask again, and answers the whole page.
    const reset = await logsOf(api, { ...NO_FILTER, level: null });
    expect(reset.entries.map((entry) => entry.message)).toEqual(['fill started', 'the plugin read a file its parser does not know']);
  } finally { await api.close(); }
}, 60_000);

test('a window carries epoch milliseconds: the lower bound, the older page and the live tail', async () => {
  const api = new KnowledgeProduct({ productFolder: folder, storeRoot: knowledgeRootOf(home) });
  try {
    // A date filter sends a real moment in milliseconds, which a 32-bit GraphQL `Int` could not carry: the page's own
    // "from" and "to" arguments would have been refused with `Int cannot represent non 32-bit signed integer value`.
    expect(STARTED).toBeGreaterThan(2 ** 31 - 1);
    // The lower bound excludes what stands at or before it and keeps what is after: `from` is exclusive.
    const after = await logsOf(api, { ...NO_FILTER, from: STARTED });
    expect(after.entries.map((entry) => entry.message)).toEqual(['the plugin read a file its parser does not know']);
    const fromBeforeBoth = await logsOf(api, { ...NO_FILTER, from: STARTED - 1 });
    expect(fromBeforeBoth.entries.map((entry) => entry.message)).toEqual(['fill started', 'the plugin read a file its parser does not know']);
    // The second page asks for what is older than the oldest moment the first one holds (`older()` in the screen).
    const first = await logsOf(api, { ...NO_FILTER, limit: 1 });
    expect(first.entries.map((entry) => entry.message)).toEqual(['the plugin read a file its parser does not know']);
    expect(first.more).toBe(true);
    const older = await logsOf(api, { ...NO_FILTER, before: first.entries[0]!.at! });
    expect(older.entries.map((entry) => entry.message)).toEqual(['fill started']);
    expect(older.more).toBe(false);
    // The live tail asks for what is newer than the newest moment the page holds, and answers a page, not a refusal.
    const newest = first.entries[0]!.at!;
    expect(newest).toBe(WARNED);
    const tail = await logsOf(api, { ...NO_FILTER, from: newest });
    expect(tail.entries).toEqual([]);
    expect(tail.more).toBe(false);
    // The page size stays the schema's bounded `Int`: a larger ask is answered, and the reader caps it.
    const wide = await logsOf(api, { ...NO_FILTER, limit: 5_000 });
    expect(wide.entries.map((entry) => entry.message)).toEqual(['fill started', 'the plugin read a file its parser does not know']);
  } finally { await api.close(); }
}, 60_000);
