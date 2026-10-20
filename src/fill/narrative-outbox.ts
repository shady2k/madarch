/**
 * The pages outbox (decision 0026, "Pages"; decision 0027: "Git commits of pages are
 * a separate idempotent outbox step"; madarch-tzte.25.1): the step that carries a
 * published page's narrative fact into the product's git, where 0017 and 0023 keep
 * the truth of what agents and people write.
 *
 * **Separate.** The step runs after a run's units have settled, never inside a
 * publication's transaction: a publication lands facts in the graph, and the commit
 * that carries the same page into git is its own idempotent act over what stands
 * published. A run that published nothing narrated commits nothing; a step run
 * twice commits once.
 *
 * **Idempotent, and a person's edit wins.** For every published `narrative` fact of
 * this product's repository, the step renders the page's bytes
 * (`renderNarrativePage`, `src/fill/narrative-text.ts`) and compares them with the
 * file the checkout holds:
 *
 * - the same bytes stand there already — the page is committed, and the step does
 *   nothing;
 * - no file stands there — the page is written and committed;
 * - a file of the fill's own stands there (`writer: madarch-fill-agent` in its front
 *   matter) with other bytes — an earlier generation's page: the new page replaces
 *   it, and the commit carries the change;
 * - anything else stands there — a person's words, committed or not: the step
 *   writes nothing and names the file as kept. A person's edit wins over the
 *   agent's (the self-filling charter), and what acceptance does with it is stage
 *   25.2's.
 *
 * One commit carries every page the step wrote, so a fill of many pages is one
 * commit a person can read and revert whole.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SqlExecutor } from '../query/sql-driver.js';
import type { FactStoreDatabase } from './fact-store.js';
import { FACT_ID_PATTERN, type NarrativeValue } from './facts.js';
import { raise } from './fsm-core.js';
import { runGit } from '../product/git.js';
import { parseNarrativePage, narrativePagePath, renderNarrativePage, NARRATIVE_PAGE_WRITER } from './narrative-text.js';

/** Who a page's commit is authored by, where the caller names nobody. */
const FILL_AUTHOR = { name: 'madarch fill', email: 'madarch@localhost.invalid' } as const;

/** What one outbox step did: the pages it committed, the ones that stood already, and the ones a person's words kept out. */
export interface NarrativeOutboxResult {
  /** The pages this step wrote, each with the commit that carries it. */
  readonly committed: readonly { readonly path: string; readonly about: string; readonly commit: string }[];
  /** The pages whose bytes stood in the checkout already: committed before, nothing to do. */
  readonly unchanged: readonly string[];
  /** The pages the step did not write, each with why: a person's words stand in the file. */
  readonly kept: readonly { readonly path: string; readonly about: string; readonly reason: string }[];
}

/**
 * The bytes one page's file holds at HEAD, or `undefined` where HEAD holds no such
 * file: what the step compares the page against, so a step that crashed between its
 * write and its commit finds the commit still owed.
 */
function headBlob(folder: string, path: string): string | undefined {
  const read = runGit(folder, ['show', `HEAD:${path}`]);
  if (read.ok) return read.output;
  // git's own refusal for a path the tree does not hold; anything else is a failure of the checkout.
  // The output is git's trimmed one, so the caller compares pages with their trailing newline folded.
  if (read.output.includes('does not exist') || read.output.includes('exists on disk, but not in') || read.output.includes('path unknown')) return undefined;
  raise(`the page ${JSON.stringify(path)} could not be read at HEAD in ${folder}: git said ${read.output}`);
}

/** One published narrative fact of this product's repository, as the outbox reads it from the store. */
interface PublishedPage {
  readonly fact: string;
  readonly value: NarrativeValue;
}

/**
 * The published narrative facts of one product: the pages one of the product's units
 * published, each one row by its own id (the identity is the node the page is about),
 * so the table's row is the page that stands. The product's own holdings decide what
 * this step carries, never the page's bytes: a home's store carries every product's
 * facts, and two fills of one code hold pages of one id.
 */
async function publishedPages(database: FactStoreDatabase, product: string): Promise<readonly PublishedPage[]> {
  return await database.transaction('snapshot', async (executor: SqlExecutor) => {
    const { rows } = await executor.query<{ id: string; value: unknown }>(
      `SELECT f.id, f.value FROM fill_fact f
        WHERE f.kind = $1
          AND EXISTS (SELECT 1 FROM fill_fact_holding h JOIN fill_unit u ON u.unit_id = h.unit_id WHERE h.id = f.id AND u.product = $2)
        ORDER BY f.id`,
      ['narrative', product],
    );
    return rows.map((row) => ({ fact: row.id, value: row.value as NarrativeValue }));
  });
}

/**
 * Carries every published page of the product's repository into the checkout's git,
 * as the module doc spells out. The folder is the product repository's own checkout —
 * the pin a run read the product at — and the commit is authored by the fill, at the
 * caller's clock where it names one (a test's), so a run's commits read the same on
 * every machine that holds the same pages.
 */
export async function commitNarrativePages(options: {
  readonly database: FactStoreDatabase;
  /** The product repository's checkout: where a page's file stands and the commit is made. */
  readonly folder: string;
  /** The product whose pages this step carries, as its runs name it. */
  readonly product: string;
  /** The clock the commit's dates are read from; this process's own when it is left out. */
  readonly clock?: () => number;
  /** The author the commit names; the fill's own where it is left out. */
  readonly author?: { readonly name: string; readonly email: string };
  /** One line a watching log reads per outcome; nothing is logged where it is left out. */
  readonly log?: (line: string) => void;
}): Promise<NarrativeOutboxResult> {
  const pages = await publishedPages(options.database, options.product);
  const committed: { path: string; about: string; commit: string }[] = [];
  const unchanged: string[] = [];
  const kept: { path: string; about: string; reason: string }[] = [];
  const written: { path: string; about: string }[] = [];
  for (const page of pages) {
    const value = page.value;
    if (typeof value?.about !== 'string' || !FACT_ID_PATTERN.test(value.about)) {
      raise(`the narrative fact ${page.fact} names ${String(value?.about)} as the node it is about, which is no fact id: a page is about a node of the graph`);
    }
    const path = narrativePagePath(value.about);
    const bytes = renderNarrativePage(value);
    const file = join(options.folder, path);
    // The commit is what the step is judged by (decision 0027: the outbox carries pages into git), so the
    // comparison is against HEAD's blob and never against the working tree alone: a crash between this
    // step's write and its commit leaves the page's bytes in the checkout, and a step that compared the
    // working file would call them committed forever. The working file decides whose words stand: a file
    // that differs from HEAD by a person's hand — an uncommitted edit, or a committed one this step did
    // not write — is kept whatever the front matter says.
    const head = headBlob(options.folder, path);
    const working = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    // git's read is trimmed, so the page is compared with its own trailing whitespace folded: a
    // committed page stands whether its file ends in one newline or two.
    if (head === bytes.trimEnd() && working === bytes) {
      unchanged.push(path);
      continue;
    }
    // Words in the working file that are neither the page nor what HEAD holds cannot be the step's
    // own — the step's residue is always the page's bytes — so they are a person's uncommitted edit,
    // and they win whatever the front matter says.
    if (working !== undefined && working !== bytes && working.trimEnd() !== head) {
      const read = parseNarrativePage(working);
      kept.push({ path, about: value.about, reason: read.ok ? `the working file holds words the fill did not write in this state: a person's edit stands there, and it wins` : read.reason });
      continue;
    }
    // What HEAD holds decides the rest, by the hand that last touched the page: the fill's own
    // earlier page is replaced by the newer one, and a person's committed page keeps.
    if (head !== undefined) {
      const fillAuthor = options.author ?? FILL_AUTHOR;
      const last = runGit(options.folder, ['log', '-1', '--format=%an|%ae', '--', path]);
      const byFill = last.ok && last.output === `${fillAuthor.name}|${fillAuthor.email}`;
      if (!byFill) {
        kept.push({ path, about: value.about, reason: `the last commit that touched the page is ${JSON.stringify(last.output || 'none')}: a person's words stand there, and they win` });
        continue;
      }
    }
    // The page's folder may not stand yet: a product whose fill never narrated has no docs/graph.
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes, 'utf8');
    written.push({ path, about: value.about });
  }
  const log = options.log ?? (() => undefined);
  for (const page of kept) log(`narrative outbox: ${page.path} kept — ${page.reason}`);
  if (written.length === 0) {
    log(`narrative outbox: ${String(unchanged.length)} page${unchanged.length === 1 ? '' : 's'} stand committed, nothing to carry`);
    return { committed: [], unchanged, kept };
  }
  const at = (options.clock ?? (() => Date.now()))();
  const when = new Date(at).toISOString();
  const author = options.author ?? FILL_AUTHOR;
  const env = {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
    GIT_COMMITTER_DATE: when,
  };
  const add = runGit(options.folder, ['add', '--', ...written.map((page) => page.path)]);
  if (!add.ok) raise(`the pages of ${written.map((page) => page.path).join(', ')} could not be staged in ${options.folder}: git said ${add.output}`);
  const message = [
    `narrative: ${written.length === 1 ? 'one page' : `${written.length} pages`} proposed`,
    '',
    ...written.map((page) => `${page.path} — about ${page.about}`),
    '',
    'Written by the fill\'s pages stage (decision 0026, "Pages"): narrative text proposed, marked unverified, each sentence tied to the facts it stands on.',
    '',
  ].join('\n');
  const commit = runGit(options.folder, ['commit', '-m', message, '--', ...written.map((page) => page.path)], env);
  if (!commit.ok) raise(`the pages of ${written.map((page) => page.path).join(', ')} could not be committed in ${options.folder}: git said ${commit.output}`);
  const digest = runGit(options.folder, ['rev-parse', 'HEAD']);
  if (!digest.ok) raise(`the pages were committed in ${options.folder} and the commit could not be read: git said ${digest.output}`);
  for (const page of written) committed.push({ path: page.path, about: page.about, commit: digest.output.trim() });
  log(`narrative outbox: ${committed.length === 1 ? 'one page' : `${committed.length} pages`} committed as ${digest.output.trim()}`);
  return { committed, unchanged, kept };
}
