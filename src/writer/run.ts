/**
 * The knowledge writer (decision 0029; decision 0032, section 1): after the deterministic fill the
 * writer runs as a GRAPH OF UNITS — graph validation, the documents read by meaning, the product
 * page, rules and decisions, scenarios, the domain pages, the guides, the home page last, and the
 * editorial pass. Each kind declares what it reads and what it writes (`src/writer/graph.ts`), the
 * order is the topological order of those declarations, and a unit of a later kind is handed the
 * pages the kinds before it wrote.
 *
 * Every unit is resumable (decision 0027): its generation is recorded in the fill's own unit tables
 * with the digest of what it read (`src/writer/graph-state.ts`), so an interrupted run leaves the
 * finished units published and the next run writes only what is left. Enrichment of a person's
 * document is stored apart from it, keyed by the source entity's identity (`src/writer/enrichment.ts`),
 * and a document of the product is not a page this writer may write at all.
 *
 * The agent is an interface (`UnitAgent`): a real one drives an ACP agent (`acp-agent.ts`), a
 * scripted one answers a test. Around it the core is deterministic: the order comes from the
 * declarations, the prompts come from the graph, the tools answer in code-point order, and a checked
 * page is written in canonical form, so the same graph, prompts and answers give the same files.
 */
import { lstat, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { GraphStore } from '../graph/index.js';
import { byCodePoint } from '../model/order.js';
import type { McpToolDefinition } from '../fill/unit-mcp.js';
import { parse as parseYaml } from 'yaml';
import { splitFrontMatter } from '../knowledge/markdown.js';
import { KINDS_FILE, readKinds } from '../knowledge/kinds.js';
import { parseQuestion, parseStatementRef, QUESTIONS_FOLDER, readCorrections, readQuestions, type Correction, type Question } from '../loop/entities.js';
import { writtenAtOf } from './basis.js';
import type { DocEntity } from '../knowledge/doc-entities.js';
import { detectDocumentLanguage, localizedSourcePath, localizedSourcePrompt, parseLocalizedSource, renderLocalizedSource, LOCALIZED_SOURCE_SCHEMA } from './localized-source.js';
import { includedNotes, type ChangeNote, type EditBrief } from './edit.js';
import { statementsOf } from './sentences.js';
import { MAX_SLUG_LENGTH, SLUG } from './format.js';
import { domainPrompt, editorialPrompt, enrichmentPrompt, ENRICHMENT_TASKS, overviewPrompt, productPrompt, validationPrompt, type UnitContext, type WriterArtifactRead } from './prompts.js';
import { documentMentionNames, type MentionName } from './mentions.js';
import { DEFAULT_UNIT_BOUNDS, UnitTools, type DomainDeclaration, type PageSink, type ToolAnswer, type UnitBounds, type UnitOutcome, type UnitSpec } from './tools.js';
import { GraphView, ingestContent, type ContentReport } from './view.js';
import { textDigest, WRITER_UNIT_KINDS, writerUnitDigest, writerUnitKind, writerUnitOrder, type WriterArtifact, type WriterUnitKindName } from './graph.js';
import { NO_WRITER_STATE, type WriterState, type WriterUnitRecord } from './graph-state.js';
import { enrichmentOverwriteProblem, enrichmentPath, frontMatterId, isAgentPage, type EnrichmentDraft } from './enrichment.js';
import { GUIDE_OUTPUTS, registeredGuideOutput, type GuideWriterHost } from './guides/host-contract.js';
import { guidePageCount, currentGuidePath } from './guides/prepared.js';
import { formatGuidePreparationError, type GuidePreparationStage } from './guides/preparation-error.js';
import { guidePrompt } from './prompts.js';

export const PRODUCT_PATH = 'docs/product.md';
export const DOMAINS_FOLDER = 'docs/domains';
/** The graph-validation unit's page (decision 0032, section 3). */
export const VALIDATION_PATH = 'docs/validation.md';
/** The home page the overview unit writes last (0032, section 11; its content is madarch-ztyq.7's). */
export const OVERVIEW_PATH = 'docs/overview.md';
/** The editorial pass's page (0032, section 6; its requests are madarch-ztyq.9's). */
export const EDITORIAL_PATH = 'docs/editorial.md';

/** What an agent is handed for one unit. */
export interface UnitRequest {
  readonly id: string;
  readonly prompt: string;
  readonly tools: ToolClient;
}

export interface ToolClient {
  readonly definitions: readonly McpToolDefinition[];
  call(tool: string, argumentsValue: unknown): Promise<ToolAnswer>;
  /** True once the unit wrote its page or has no attempts or calls left. */
  finished(): boolean;
}

/** Drives one unit to its end; it reports nothing, the tools' session holds the result. */
/**
 * How a run ended. A run that was stopped by a bound or a cancellation is not an answer: a judge that reuses the
 * writer's agent must not accept what the tools took before the stop (madarch-j6ho.2).
 */
export interface UnitRunStatus {
  readonly completed: boolean;
  /** What stopped it, in words, when it did not complete. */
  readonly stopped?: string;
}

export interface UnitAgent {
  run(request: UnitRequest): Promise<UnitRunStatus | void>;
  /** Things the agent told the reader while starting a session, such as a saved model it no longer offers. */
  warnings?(): readonly string[];
}

/**
 * A run that a person paused or stopped: thrown before a page is taken up, so the page in progress is finished and the
 * page after it is never started. The message says which page was left as it was and which was not begun.
 */
export class WriterHalted extends Error {
  constructor(readonly how: 'pause' | 'stop', message: string) {
    super(message);
    this.name = 'WriterHalted';
  }
}

export interface WriterOptions {
  /** Checked guide preparation/publication supplied by the production owner; absent preserves legacy callers. */
  readonly guides?: GuideWriterHost;
  readonly owner: DatabaseOwner;
  readonly store: GraphStore;
  /** The code repository the graph was filled from (its path, as the driver was given it). */
  readonly repository: string;
  /** The revision the fill walked; `HEAD` by default. */
  readonly ref?: string;
  /** The product repository the pages are written into (its working tree, not a commit). */
  readonly output: string;
  /** The product's name; its slug is the product page's id. */
  readonly productName: string;
  readonly agent: UnitAgent;
  readonly bounds?: UnitBounds;
  /** Replaces the filesystem writes; tests read the pages from memory with it. */
  readonly sink?: PageSink;
  /** The language the pages are written in (`en` or `ru`); `en` when absent. The agent is told, and a page in another language is not refused. */
  readonly language?: string;
  /** The content language was changed by this run: every page is written again. */
  readonly languageChanged?: boolean;
  /** Extracted document entities of the product and its code repositories to localize with agent units. */
  readonly documentEntities?: readonly DocEntity[];
  /** Names the product's documents give their entities, when a caller already holds them; the default reads `documentEntities`. */
  readonly mentions?: readonly MentionName[];
  /**
   * Which pages need an agent unit. The seam of the incremental update (madarch-m38l.7): given the pages already
   * written, it answers what to write. The default is `unitsNeeded`: a page that is missing, and every page when the
   * language changed. The incremental update will replace it with a decision on the pages whose grounds changed.
   */
  readonly needed?: (input: UnitsInput) => UnitsNeeded;
  /** Called with each unit's outcome as it ends. */
  readonly onUnit?: (outcome: UnitOutcome) => void;
  /** The repository's name as the product declares it, recorded in each page's `written-at`; the folder's name by default. */
  readonly repositoryName?: string;
  /** Called after each page is written to the sink, with its path: the graph index is published here. A failure is reported in `indexErrors`, never hidden. */
  readonly afterWrite?: (written: { readonly path: string }) => Promise<void>;
  /** Called with a unit's id and page as the unit starts, so a reader can see which unit is writing now. */
  readonly onUnitStart?: (unit: { readonly unit: string; readonly path: string }) => void;
  /**
   * Called with how many pages the run means to write in total (madarch-m38l.23): before its first unit, and again
   * when the product page declares its domains. It is the denominator a reader sees in «12/18».
   */
  readonly onTotal?: (total: number) => void;
  /** Called once an answer or a correction was used by every page it touched and all of them were written. A failure is reported in `loopProblems`. */
  readonly resolved?: (resolved: ResolvedEntity) => Promise<void>;
  /** The clock questions are stamped with; tests inject. */
  readonly clock?: () => Date;
  /**
   * Asked before a page is taken up (madarch-m38l.17): answers `pause` or `stop` when a person asked for one, and then
   * the run throws `WriterHalted` before starting anything, so the page being written is finished and the next page is
   * never begun. A page whose unit is kept is not asked about: nothing is written for it either way.
   */
  readonly halt?: () => 'pause' | 'stop' | undefined;
  /**
   * Where the units are kept between runs (decision 0027; `src/writer/graph-state.ts`). Absent, every
   * unit runs and nothing is remembered; the fill passes the state of its own store, and an interrupted
   * run then resumes instead of starting over.
   */
  readonly state?: WriterState;
}

export interface WriterReport {
  readonly content: ContentReport;
  /** The product unit's outcome; when every page was there and no unit ran, the page as kept: written, with no attempt and no call. */
  readonly product: UnitOutcome;
  readonly domains: readonly UnitOutcome[];
  /** Localized source statements written for document entities. */
  readonly localizedSources: readonly UnitOutcome[];
  /** The two guide units, when the run wires their checked production host. */
  readonly guides: readonly UnitOutcome[];
  /** The number of agent units that ran. */
  readonly units: number;
  readonly ok: boolean;
  /** Domain pages already in the output that this run did not write: left alone, named here. */
  readonly stale: readonly string[];
  /** What `afterWrite` raised, with the page it was told about; the run is not `ok` while this is not empty. */
  readonly indexErrors: readonly string[];
  /** Question and correction files that could not be read, and what `resolved` raised, each with its file and line: told, never hidden. */
  readonly loopProblems: readonly string[];
  /** The ids of the questions the units asked in this run, in the order they were asked. */
  readonly questions: readonly string[];
  /** The order the kinds ran in, derived from their declared reads and writes (`writerUnitOrder`). */
  readonly order: readonly WriterUnitKindName[];
  /**
   * What every kind of the graph did: the units it ran, the units it kept from an earlier run, and —
   * for a kind that ran none — the reason. A kind is never skipped quietly, so a reader of the report
   * can tell "nothing to do" from "could not run".
   */
  readonly graph: readonly WriterKindRun[];
  /** The enrichments this run wrote: one page per passage, stored apart from the person's document. */
  readonly enrichments: readonly UnitOutcome[];
  /**
   * What the writer's state could not record, each with its page and the reason. The units ran and their pages stand;
   * the next run will not skip what was not published, and this list says so rather than leaving it to a guess.
   */
  readonly stateProblems: readonly string[];
  /** The graph-validation unit's outcome, or the reason it did not run. */
  readonly validation: WriterKindRun;
  /** The home page's unit, written last of the pages a reader opens first. */
  readonly overview: WriterKindRun;
  /** The editorial pass's unit. */
  readonly editorial: WriterKindRun;
}

/** How one unit of the graph ended: it wrote, it was kept from an earlier run, or it ended without its page. */
export interface WriterUnitRun {
  readonly unit: string;
  readonly kind: WriterUnitKindName;
  readonly path: string;
  readonly status: UnitOutcome['status'] | 'kept';
  /** What a kept or an unfinished unit is kept for or ended on; absent for a written one. */
  readonly reason?: string;
}

/** How one kind of the graph ran: the units it knew how to run and what became of them. */
export interface WriterKindRun {
  readonly kind: WriterUnitKindName;
  /** The kind's place in the run's order, from 0. */
  readonly position: number;
  /**
   * `ran`: the kind's units ran or were kept. `nothing-found`: its inputs hold nothing to run, and
   * `reason` says what was looked for. `blocked`: an artifact it requires was not produced, and
   * `reason` names that artifact.
   */
  readonly state: 'ran' | 'nothing-found' | 'blocked';
  readonly reason?: string;
  readonly units: readonly WriterUnitRun[];
}

/** One artifact this run produced: the kind that wrote it, the page it stands in, and the title a later unit reads it by. */
export interface ProducedArtifact {
  readonly artifact: WriterArtifact;
  readonly kind: WriterUnitKindName;
  readonly unit: string;
  readonly path: string;
  readonly title: string;
  /** The page as it was written, for the units that read it; the report does not carry it. */
  readonly text?: string;
}

/** What the seam is given: the pages that exist and whether the content language was changed by this run. */
export interface UnitsInput {
  /** `docs/product.md`'s text, or null when there is none. */
  readonly productPage: string | null;
  /** The domain pages that exist, by path. */
  readonly domainPages: readonly string[];
  readonly languageChanged: boolean;
}

export interface UnitsNeeded {
  /** The product unit runs: it also declares the domains, so it runs whenever a page it declares is new. */
  readonly product: boolean;
  /** A domain page is written when this says so for its path. */
  readonly domain: (path: string) => boolean;
  /** What a unit is told about the page it edits, by the page's path; absent for a page written from the graph. */
  readonly brief?: (path: string) => EditBrief | undefined;
}

/** An answer or a correction a rewrite used: the pages (ids) it touched, all written. */
export interface ResolvedEntity {
  readonly kind: 'question' | 'correction';
  readonly slug: string;
  readonly pages: readonly string[];
}

/**
 * Today's decision: the pages that are missing, or every page when the language changed. A product page that exists
 * but links a domain whose page is missing needs the product unit again, because only that unit declares the
 * domains' summaries and evidence.
 */
export function unitsNeeded(input: UnitsInput): UnitsNeeded {
  if (input.languageChanged || input.productPage === null) return { product: true, domain: () => true };
  const linked = [...input.productPage.matchAll(/\(madarch:domain:([a-z][a-z0-9-]*)\)/g)].map((match) => `${DOMAINS_FOLDER}/${match[1]}.md`);
  const missing = linked.some((path) => !input.domainPages.includes(path));
  return { product: missing, domain: (path) => !input.domainPages.includes(path) };
}

export function productSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!SLUG.test(slug) || slug.length > MAX_SLUG_LENGTH) throw new Error(`src/writer/run.ts: the product name ${JSON.stringify(name)} gives the id slug ${JSON.stringify(slug)}, which is not lower-case words joined by hyphens of at most ${MAX_SLUG_LENGTH} characters`);
  return slug;
}

/**
 * The families of file the writer writes inside a product: one per kind of page, so a path is judged by
 * what it is rather than by one pattern that grows with every kind. A path outside these is refused
 * outright — a person's document (`docs/requirements.md`, `docs/architecture/…`) is no family here, which
 * is the first half of "never overwrites the person's text" (decision 0032, section 1).
 */
export type WriterPageFamily = 'product' | 'domain' | 'question' | 'localized-source' | 'enrichment' | 'validation' | 'overview' | 'editorial';

/** The slug a page file may be named by, as everywhere else in the writer. */
const familySlug = (part: string): boolean => SLUG.test(part) && part.length <= MAX_SLUG_LENGTH;

/** The family a product-relative path belongs to, or undefined when the writer may not write there. */
export function writerPageFamily(relativePath: string): WriterPageFamily | undefined {
  const parts = relativePath.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('\\'))) return undefined;
  if (relativePath === PRODUCT_PATH) return 'product';
  if (relativePath === 'docs/validation.md') return 'validation';
  if (relativePath === 'docs/overview.md') return 'overview';
  if (relativePath === 'docs/editorial.md') return 'editorial';
  if (parts[0] !== 'docs' || !parts[parts.length - 1]!.endsWith('.md')) return undefined;
  const folder = parts[1]!;
  // A page of its own under `docs/<folder>/<slug>.md`: a domain page, or a question a person answers.
  if (parts.length === 3) {
    const name = parts[2]!.slice(0, -'.md'.length);
    if (folder === 'domains') return familySlug(name) ? 'domain' : undefined;
    if (folder === 'questions') return familySlug(name) ? 'question' : undefined;
    return undefined;
  }
  // A file filed under a kind of its own, `docs/<folder>/<kind>/<name>.md` (`localizedSourcePath`,
  // `enrichmentPath`): the kind may carry a dot, and the name is a digest of the entity's identity.
  if (parts.length === 4) {
    const kind = parts[2]!;
    const name = parts[3]!.slice(0, -'.md'.length);
    if (folder === 'sources') return kind !== '' && name !== '' ? 'localized-source' : undefined;
    return undefined;
  }
  return undefined;
}

/** The families an enrichment lives in: a folder per entity kind under `docs/enrichment`. */
const ENRICHMENT_FOLDER = 'docs/enrichment';

/** The families a file the writer did not write is refused in (`isAgentPage`, `src/writer/enrichment.ts`). */
const OWNED_BY_THE_WRITER: readonly WriterPageFamily[] = ['product', 'domain', 'validation', 'overview', 'editorial'];

/** The family of an enrichment path: `docs/enrichment/<entity kind>/<digest>.md`, three parts inside a folder. */
export function enrichmentFamilyOf(relativePath: string): boolean {
  const parts = relativePath.split('/');
  if (parts.length !== 4 || parts[0] !== 'docs' || parts[1] !== 'enrichment') return false;
  const kind = parts[2]!;
  const name = parts[3]!;
  return kind !== '' && kind !== '.' && kind !== '..' && name.endsWith('.md') && name.slice(0, -3) !== '';
}

/** Writes pages under a folder; a page lands whole or not at all. */
let counter = 0;

export function fsSink(root: string): PageSink {
  return {
    async write(relativePath: string, content: string): Promise<void> {
      const absoluteRoot = path.resolve(root);
      const target = path.resolve(root, relativePath);
      const family = writerPageFamily(relativePath);
      const enrichment = family === undefined && enrichmentFamilyOf(relativePath);
      if (!target.startsWith(`${absoluteRoot}${path.sep}`) || relativePath.split(/[\\/]/).some((part) => part === '.' || part === '..') || (family === undefined && !enrichment)) {
        throw new Error(`${absoluteRoot}/${relativePath}:1: the writer may not write this path: it writes ${PRODUCT_PATH}, ${VALIDATION_PATH}, ${OVERVIEW_PATH}, ${EDITORIAL_PATH}, the pages under ${DOMAINS_FOLDER}, docs/questions and docs/sources, and the enrichments under ${ENRICHMENT_FOLDER}; a document a person wrote is never a page the writer overwrites`);
      }
      const rootStat = await lstat(absoluteRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`src/writer/run.ts: ${JSON.stringify(root)} is not a real product directory`);
      let cursor = absoluteRoot;
      for (const part of path.relative(absoluteRoot, path.dirname(target)).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        try {
          const stat = await lstat(cursor);
          if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`src/writer/run.ts: ${JSON.stringify(cursor)} is not a real directory`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await mkdir(cursor);
        }
      }
      // What the writer did not write, it does not replace: a page whose front matter does not name the
      // producer `agent` is a person's text (or a file of another shape), and the write is refused with the
      // file, its line and its full path rather than overwriting it (decision 0032, section 1).
      if ((family !== undefined && OWNED_BY_THE_WRITER.includes(family)) || enrichment) {
        const existing = await readFile(target, 'utf8').catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? undefined : Promise.reject(error)));
        if (existing !== undefined && !isAgentPage(existing)) {
          throw new Error(`${target}:1: the writer does not overwrite a page it did not write: the file holds no page whose front matter names the producer "agent", so it is a person's text (decision 0032, section 1)`);
        }
        if (existing !== undefined && enrichment) {
          // An enrichment stands at a path derived from one entity's identity: the file there must be that entity's page, or
          // an outside hand has rewritten it, and it is refused rather than replaced.
          const held = frontMatterId(existing);
          const next = frontMatterId(content);
          if (held === undefined || next === undefined || held !== next) {
            throw new Error(`${target}:2: the writer does not replace this file: it holds the page ${JSON.stringify(held ?? 'of no id')} and this write is ${JSON.stringify(next ?? 'of no id')}, and an enrichment is replaced only by the page of the same entity (decision 0032, section 1)`);
          }
        }
      }
      const temporary = `${target}.${process.pid}.${(counter += 1)}.writing`;
      await writeFile(temporary, content, 'utf8');
      await rename(temporary, target);
    },
    read: (relativePath) => readFile(path.resolve(root, relativePath), 'utf8'),
    list: async (folder) => {
      try {
        return (await readdir(path.resolve(root, folder))).filter((name) => name.endsWith('.md')).map((name) => `${folder}/${name}`).sort(byCodePoint);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    },
  };
}

/** A sink that keeps the pages in a map. */
export function memorySink(): PageSink & { readonly pages: Map<string, string> } {
  const pages = new Map<string, string>();
  return {
    pages,
    write: async (relativePath, content) => { pages.set(relativePath, content); },
    read: async (relativePath) => {
      const page = pages.get(relativePath);
      if (page === undefined) throw new Error(`the sink holds no ${relativePath}`);
      return page;
    },
    list: async (folder) => [...pages.keys()].filter((key) => key.startsWith(`${folder}/`)).sort(byCodePoint),
  };
}

async function runUnit(agent: UnitAgent, tools: UnitTools, prompt: string): Promise<UnitOutcome> {
  const client: ToolClient = { definitions: tools.tools, call: (tool, args) => tools.call(tool, args), finished: () => tools.finished };
  try {
    await agent.run({ id: tools.unit.id, prompt, tools: client });
  } catch (error) {
    const outcome = tools.outcome();
    const message = tools.unit.kind === 'administrator-guide' || tools.unit.kind === 'user-guide' ? 'guide agent failed; sensitive details withheld' : error instanceof Error ? error.message : String(error);
    return { ...outcome, status: outcome.status === 'written' ? 'written' : 'failed', refusals: [...outcome.refusals, { line: 0, rule: 'agent', message: `the agent failed: ${message}` }] };
  }
  return tools.outcome();
}

async function existingDomainPages(output: string): Promise<string[]> {
  try {
    return (await readdir(path.join(output, DOMAINS_FOLDER))).filter((name) => name.endsWith('.md')).map((name) => `${DOMAINS_FOLDER}/${name}`).sort(byCodePoint);
  } catch {
    return [];
  }
}

/** A domain's declaration as its page gives it now: the title, a summary from its first statement, the keys it relates to. */
export function declarationOf(path: string, text: string, language?: string): DomainDeclaration {
  const slug = path.replace(/^.*\//, '').replace(/\.md$/, '');
  const { front, body, bodyLine } = splitFrontMatter(text.replace(/\r\n/g, '\n'));
  let record: Record<string, unknown> = {};
  try {
    const raw: unknown = front === null ? {} : parseYaml(front);
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) record = raw as Record<string, unknown>;
  } catch (error) {
    throw new Error(`src/writer/run.ts: ${path}:2: the front matter of the domain page is no YAML, so the domain cannot be declared again: ${(error as Error).message.split('\n')[0]}`);
  }
  const statements = statementsOf(body, bodyLine, language);
  const title = typeof record['title'] === 'string' && record['title'].trim() !== '' ? record['title'].trim() : slug;
  const relates = Array.isArray(record['relates']) ? (record['relates'] as unknown[]).filter((entry): entry is string => typeof entry === 'string') : [];
  const evidence = relates.length > 0 ? relates : [...new Set(statements.flatMap((statement) => statement.grounds))];
  return { slug, title, summary: statements[0]?.text ?? title, evidence: [...evidence].sort(byCodePoint) };
}

const entityKey = (kind: string, slug: string): string => `${kind}:${slug}`;

/** The page a kept unit left: read back from the sink, so a page that vanished is written again. */
async function pageKept(sink: PageSink, path: string): Promise<boolean> {
  try { await sink.read(path); return true; } catch { return false; }
}

/** The reason a unit that wrote nothing carries into the report and the state. */
export function unitEndedOn(outcome: UnitOutcome): string {
  const refusal = outcome.refusals[0];
  return refusal === undefined ? 'the unit ended without writing its page and said nothing about why' : `${outcome.path}:${refusal.line}: ${refusal.rule}: ${refusal.message}`;
}

/**
 * Runs one unit of the graph, or keeps it (decision 0027): a unit whose generation stands published
 * with the same inputs digest and whose page is still there is kept and not run again; every other
 * unit is opened in the fill's own unit state, runs, and is published or left blocked with the reason
 * it ended on, so the run after this one takes up exactly what is left.
 */
export async function runGraphUnit(input: {
  readonly id: string;
  readonly kind: WriterUnitKindName;
  readonly scope: string;
  readonly digest: string;
  readonly path: string;
  readonly state: WriterState;
  readonly resumed: ReadonlyMap<string, WriterUnitRecord>;
  readonly sink: PageSink;
  readonly now: () => number;
  /**
   * True when the run's plan asked for this unit: a plan that names a page owns it, so the unit runs whatever the
   * state remembers (a person asked for the page again), and the page's own incremental logic is what keeps a page
   * that stands. False where no plan names the unit — the graph's own pages and the enrichments — and the state then
   * decides: a unit an earlier run published with the same inputs and whose page still stands is kept.
   */
  readonly asked?: boolean;
  readonly onUnitStart?: (unit: { readonly unit: string; readonly path: string }) => void;
  readonly onUnit?: (outcome: UnitOutcome) => void;
  /** True for the graph's own pages, whose writing the run's plan does not name: a page that stands and that no earlier run recorded is kept. */
  readonly pageStandingKeepsTheUnit?: boolean;
  /** Builds the unit's tools and runs its agent; called only when the unit is neither kept nor blocked. */
  readonly start: () => Promise<UnitOutcome>;
  /** What the state could not record, told to the run: the unit ran and its page stands, and the next run will not skip it. */
  readonly stateProblem?: (message: string) => void;
  /** Throws `WriterHalted` when a person asked for a pause or a stop: asked before anything is read, kept or written. */
  readonly halt?: (what: string) => void;
}): Promise<{ readonly run: WriterUnitRun; readonly outcome?: UnitOutcome }> {
  // Before the page is read, kept or written: a run a person halted starts no page at all, so the page in progress is
  // exactly what it was before the run and no unit is recorded as begun.
  input.halt?.(`writing the page ${input.path}`);
  const report = (message: string): void => input.stateProblem?.(`${input.path}:1: ${message}`);
  /** One step on the run's state, which never fails the run: its refusal is told, and the unit goes on. */
  const recorded = async <T>(what: string, work: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await work();
    } catch (error) {
      report(`the writer's state could not record ${what} for the unit ${JSON.stringify(input.id)}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };
  // A page that stands is a page of this run too: the reader counts it, and its row says the page was kept. A unit that
  // ends kept told nothing before this change, so a resumed run's bar never reached its end (madarch-m38l.23).
  const announceKept = (): UnitOutcome => {
    const outcome: UnitOutcome = { unit: input.id, status: 'written', path: input.path, writeAttempts: 0, calls: 0, refusals: [], domains: [], grounds: [], links: [], filesRead: [], questions: [], merged: [] };
    input.onUnitStart?.({ unit: input.id, path: input.path });
    input.onUnit?.(outcome);
    return outcome;
  };
  const runOnly = async (): Promise<{ readonly run: WriterUnitRun; readonly outcome?: UnitOutcome }> => {
    input.onUnitStart?.({ unit: input.id, path: input.path });
    const outcome = await input.start();
    input.onUnit?.(outcome);
    return {
      run: outcome.status === 'written'
        ? { unit: input.id, kind: input.kind, path: input.path, status: 'written' }
        : { unit: input.id, kind: input.kind, path: input.path, status: outcome.status, reason: unitEndedOn(outcome) },
      outcome,
    };
  };
  // A unit the run's plan names is the plan's: the page's own incremental logic keeps a page that stands, and the state
  // never keeps a page a person asked to be written again.
  const asked = input.asked === true;
  const kept = asked ? undefined : input.resumed.get(input.id);
  if (kept !== undefined && kept.digest === input.digest && await pageKept(input.sink, input.path)) {
    return { run: { unit: input.id, kind: input.kind, path: input.path, status: 'kept', reason: `published by an earlier run of the same inputs (${input.digest.slice(0, 12)})` }, outcome: announceKept() };
  }
  // A standing page is kept only where the run keeps no state at all: with a state, the state decides — an attempt that
  // never ended is recovered and its page published, which is not the same as a page nobody recorded.
  if (kept === undefined && input.pageStandingKeepsTheUnit === true && input.state === NO_WRITER_STATE && await pageKept(input.sink, input.path)) {
    return { run: { unit: input.id, kind: input.kind, path: input.path, status: 'kept', reason: 'the page stands and no earlier run of this writer recorded it: this run wrote nothing over it' }, outcome: announceKept() };
  }
  const entry: WriterUnitRecord = { unit: input.id, kind: input.kind, scope: input.scope, digest: input.digest };
  const attempt = await recorded('the opening of its generation', async () => await input.state.begin(entry, input.now()));
  if (attempt === undefined) {
    // No lease, no authority: a page written now could never be published, and the next run would write it again. The
    // unit is not run, and the run says why rather than leaving a page behind that nobody owns.
    const reason = `${input.path}:1: the writer's state refused this unit's attempt, so it was not run and no page was written for it (report.stateProblems names the refusal)`;
    input.onUnit?.({ unit: input.id, status: 'failed', path: input.path, writeAttempts: 0, calls: 0, refusals: [{ line: 1, rule: 'no-authority', message: reason }], domains: [], grounds: [], links: [], filesRead: [], questions: [], merged: [] });
    return { run: { unit: input.id, kind: input.kind, path: input.path, status: 'failed', reason } };
  }
  if (!attempt.opened) {
    // Published under exactly these inputs: the page holds what this run would write.
    return { run: { unit: input.id, kind: input.kind, path: input.path, status: 'kept', reason: `published by an earlier run of the same inputs (${input.digest.slice(0, 12)})` }, outcome: announceKept() };
  }
  if (attempt.recovered && await pageKept(input.sink, input.path)) {
    // An attempt that never ended left its page on disk: it is this unit's page, so it is published, not written again
    // (a page written twice is a page a person may have already read).
    await recorded('its publication after a crash', async () => await input.state.publish(entry, input.now()));
    const page = { unit: input.id, status: 'written' as const, path: input.path, writeAttempts: 0, calls: 0, refusals: [], domains: [], grounds: [], links: [], filesRead: [], questions: [], merged: [] };
    input.onUnitStart?.({ unit: input.id, path: input.path });
    input.onUnit?.(page);
    return { run: { unit: input.id, kind: input.kind, path: input.path, status: 'written' }, outcome: page };
  }
  const result = await runOnly();
  if (result.outcome?.status === 'written') await recorded('its publication', async () => await input.state.publish(entry, input.now()));
  else if (result.outcome !== undefined) await recorded('its reason', async () => await input.state.blocked(entry, result.run.reason ?? unitEndedOn(result.outcome!), input.now()));
  return result;
}

/** The unit id of the one unit a kind runs for the whole product. */
export function productUnitId(kind: WriterUnitKindName, slug: string): string {
  return `${kind}:${slug}`;
}




export async function runWriter(options: WriterOptions): Promise<WriterReport> {
  const bounds = options.bounds ?? DEFAULT_UNIT_BOUNDS;
  const view = await GraphView.open(options.owner, options.store);
  const content = await ingestContent(options.owner, options.store, view, options.repository, options.ref);
  const inner = options.sink ?? fsSink(options.output);
  const indexErrors: string[] = [];
  const loopProblems: string[] = [];
  const sink: PageSink = options.afterWrite === undefined ? inner : {
    read: inner.read,
    ...(inner.list === undefined ? {} : { list: inner.list }),
    write: async (relativePath, content) => {
      await inner.write(relativePath, content);
      try {
        await options.afterWrite!({ path: relativePath });
      } catch (error) {
        indexErrors.push(`${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
  const basis = [await writtenAtOf(options.repository, options.ref ?? 'HEAD', options.repositoryName)];
  const slug = productSlug(options.productName);
  const language = options.language ?? 'en';
  const state = options.state ?? NO_WRITER_STATE;
  const now = (): number => (options.clock?.() ?? new Date()).getTime();
  // The units an earlier run published, and the order the declared kinds run in: both are read before a
  // single unit starts, so a run that cannot even order its kinds writes nothing at all.
  const resumed = await state.published();
  const derived = writerUnitOrder();
  if (derived.problems.length > 0) throw new Error(derived.problems.join('\n'));
  const order = derived.order;
  const versionOf = (kind: WriterUnitKindName): number => writerUnitKind(kind)?.version ?? 1;
  const productUnit: UnitSpec = { kind: 'product', id: `product:${slug}`, path: PRODUCT_PATH, name: options.productName };
  // The questions people were asked and the corrections they made: a unit is told those about its page, and may stand on the answered ones.
  const readQ = readQuestions(options.output);
  const readC = readCorrections(options.output);
  loopProblems.push(...[...readQ.problems, ...readC.problems].map((problem) => problem.message));
  const questions: readonly Question[] = readQ.items;
  const corrections: readonly Correction[] = readC.items;
  const entityIds = [...questions.filter((question) => question.status === 'answered').map((question) => question.id), ...corrections.map((correction) => correction.id)].sort(byCodePoint);
  // The questions asked so far, read fresh at each ask (a unit's question is seen by the next), so one subject is asked once.
  const liveQuestions = async (): Promise<readonly Question[]> => {
    if (sink.list === undefined) {
      const read = readQuestions(options.output);
      if (read.problems.length > 0) throw new Error(read.problems.map((problem) => `${path.resolve(options.output, problem.file)}:${problem.line}: ${problem.message}`).join('\n'));
      return read.items;
    }
    const found: Question[] = [];
    for (const file of await sink.list(QUESTIONS_FOLDER)) {
      try { found.push({ ...parseQuestion(path.resolve(options.output, file), await sink.read(file)), file }); }
      catch (error) { throw new Error(`${path.resolve(options.output, file)}:1: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return found;
  };
  // Every artifact this run has produced, read fresh at each call: a unit's prompt carries a bounded list of them, and
  // `list_pages` is how the unit reaches what the prompt cut (decision 0032, section 1).
  const producedNow = async (): Promise<readonly { artifact: string; kind: string; unit: string; path: string; title: string }[]> =>
    [...produced.values()].flat().map((item) => ({ artifact: item.artifact, kind: item.kind, unit: item.unit, path: item.path, title: item.title }));
  const mentions = options.mentions ?? documentMentionNames(options.documentEntities ?? []);
  const extras = { entityIds: async () => entityIds, output: options.output, language, questions: liveQuestions, produced: producedNow, mentions, ...(options.clock === undefined ? {} : { clock: options.clock }) };
  let existingProduct: string | null = null;
  try { existingProduct = await sink.read(PRODUCT_PATH); } catch { existingProduct = null; }
  const domainPages = await existingDomainPages(options.output);
  const need = (options.needed ?? unitsNeeded)({ productPage: existingProduct, domainPages, languageChanged: options.languageChanged === true });
  // The kinds the product's wiki shows (decision 0029: the manifest says which): a page of a kind it does not declare is
  // a page no reader can open, so the unit of that kind does not run, and the run says why.
  const manifest = readKinds(options.output);
  const declaresKind = (kind: string): boolean => manifest.present && manifest.manifest.kinds.has(kind);
  const askedIds: string[] = [];
  const keptOutcome = (unit: string, path: string): UnitOutcome => ({ unit, status: 'written', path, writeAttempts: 0, calls: 0, refusals: [], domains: [], grounds: [], links: [], filesRead: [], questions: [], merged: [] });
  // A reset can leave a correction without its page. Match the stable page id when that page is recreated,
  // before the unit starts; never infer applicability from a fixture name or a similar sentence.
  const freshCorrections = new Map<string, Set<string>>();
  const briefFor = (unit: string, file: string, current: string | null): EditBrief | undefined => {
    const brief = need.brief?.(file);
    if (current !== null) return brief;
    const notes: ChangeNote[] = corrections.filter((correction) => correction.status === 'open' && parseStatementRef(correction.about)?.page === unit)
      .filter((correction) => !brief?.notes.some((note) => note.kind === 'correction' && note.correction === correction.slug))
      .map((correction) => ({ kind: 'correction', correction: correction.slug, statement: parseStatementRef(correction.about)!.statement, sentence: correction.statement, reason: correction.reason, by: `${correction.by.name} <${correction.by.email}>` }));
    if (notes.length === 0 && !brief?.notes.some((note) => note.kind === 'correction')) return brief;
    const combined: EditBrief = { current: null, notes: [...(brief?.notes ?? []), ...notes], omitted: brief?.omitted ?? 0 };
    const included = new Set(includedNotes(combined));
    freshCorrections.set(unit, new Set([...included].filter((note) => note.kind === 'correction').map((note) => entityKey('correction', note.correction))));
    for (const note of combined.notes) if (note.kind === 'correction' && !included.has(note)) {
      const correction = corrections.find((entry) => entry.slug === note.correction);
      loopProblems.push(`${path.resolve(options.output, correction?.file ?? `docs/corrections/${note.correction}.md`)}:1: the retained correction for ${unit} exceeds the edit brief budget; it stays open for a later refresh`);
    }
    return combined;
  };
  // The answers and corrections each page's unit is told, so a rewrite that used them can close them.
  const expected = new Map<string, Set<string>>();
  const done = new Map<string, Set<string>>();
  const expect = (unit: string, brief: EditBrief | undefined): void => {
    // Only a note the prompt carries is told to the agent, so only that one can be marked as used.
    for (const note of brief === undefined ? [] : includedNotes(brief)) {
      const key = note.kind === 'answer' ? entityKey('question', note.question) : note.kind === 'correction' ? entityKey('correction', note.correction) : undefined;
      if (key === undefined) continue;
      if (!expected.has(key)) expected.set(key, new Set());
      expected.get(key)!.add(unit);
    }
  };
  // Every page the plan touches is expected, whether or not its unit gets to start: a question closes only when all of them were written.
  expect(productUnit.id, need.brief?.(PRODUCT_PATH));
  for (const page of domainPages) expect(`domain:${page.replace(/^.*\//, '').replace(/\.md$/, '')}`, need.brief?.(page));
  const finish = (unit: string, outcome: UnitOutcome): void => {
    askedIds.push(...outcome.questions);
    if (outcome.status !== 'written' || outcome.writeAttempts === 0) return;
    // A fresh page can use a retained answer even when no existing page gave it an edit brief.
    // Only checked statement grounds count; a link, an open question or an unwritten page does not.
    for (const key of outcome.grounds) {
      if (!questions.some((question) => question.id === key && question.status === 'answered')) continue;
      if (!expected.has(key)) expected.set(key, new Set());
      expected.get(key)!.add(unit);
    }
    for (const [key, units] of expected) if (units.has(unit)) {
      // A newly recreated page must actually ground its correction, not merely receive the note and write.
      if (freshCorrections.get(unit)?.has(key) && !outcome.grounds.includes(key)) {
        const correction = corrections.find((entry) => entry.id === key);
        loopProblems.push(`${path.resolve(options.output, correction!.file)}:1: the recreated page ${unit} does not ground its retained correction on madarch:${key}; the correction stays open`);
        continue;
      }
      if (!done.has(key)) done.set(key, new Set()); done.get(key)!.add(unit);
    }
  };
  // The domains the product page declares now, as their pages say, for a product unit that edits.
  const declaredNow = async (): Promise<DomainDeclaration[]> => {
    const out: DomainDeclaration[] = [];
    for (const page of domainPages) out.push(declarationOf(page, await sink.read(page), language));
    return out;
  };

  // ---- the graph ------------------------------------------------------------------------------
  const stateProblems: string[] = [];
  const stateProblem = (message: string): void => { stateProblems.push(message); };
  /**
   * A person's pause or stop, asked before a page is taken up (madarch-m38l.17): the run ends at the page boundary it
   * stands at, after the page being written was finished and before the next one was read.
   */
  const halt = (what: string): void => {
    const how = options.halt?.();
    if (how === undefined) return;
    throw new WriterHalted(how, `src/writer/run.ts: the run was ${how === 'pause' ? 'paused' : 'stopped'} before ${what}; the page in progress is left as it was`);
  };
  const produced = new Map<WriterArtifact, ProducedArtifact[]>();
  const kinds: WriterKindRun[] = [];
  const units: WriterUnitRun[] = [];
  const enrichments: UnitOutcome[] = [];
  const note = (artifact: WriterArtifact, item: Omit<ProducedArtifact, 'artifact'>): void => {
    const held = produced.get(artifact) ?? [];
    held.push({ artifact, ...item });
    produced.set(artifact, held.sort((left, right) => byCodePoint(left.unit, right.unit)));
  };
  const artifactsOf = (artifact: WriterArtifact): readonly ProducedArtifact[] => produced.get(artifact) ?? [];
  /** The pages a kind's declared reads name, as the kind's units are handed them. */
  /** The pinned inputs every unit is read at: the commit the pages record, and the instant the graph is read at. */
  const pinned = (): string[] => [`${basis[0]!.repository}@${basis[0]!.commit}`, view.at];
  /** What the artifacts a unit reads say, by content: a later unit's inputs move when an earlier page changes, not only when its producer runs. */
  const upstreamOf = (kind: WriterUnitKindName): string[] => (writerUnitKind(kind)?.reads ?? []).flatMap((read) => artifactsOf(read.artifact).map((item) => textDigest(`${item.path}\n${item.text ?? ''}`)));
  /** What a unit is told about the page it edits: the answers and corrections in its brief, by content. */
  const briefOf = (brief: EditBrief | undefined): string => textDigest(JSON.stringify(brief === undefined ? null : { current: brief.current === null ? null : textDigest(brief.current), notes: brief.notes, omitted: brief.omitted }));
  const readsFor = (kind: WriterUnitKindName): WriterArtifactRead[] => (writerUnitKind(kind)?.reads ?? []).flatMap((read) => artifactsOf(read.artifact).map((item) => ({
    artifact: item.artifact, kind: item.kind, path: item.path, title: item.title, ...(item.text === undefined ? {} : { text: item.text }),
  })));
  /** The reads a kind requires and no kind produced: a unit that cannot run is reported, never run on less. */
  const absent = (kind: WriterUnitKindName): readonly string[] => (writerUnitKind(kind)?.reads ?? [])
    .filter((read) => read.required && artifactsOf(read.artifact).length === 0)
    .map((read) => `${JSON.stringify(read.artifact)} (written by the ${WRITER_UNIT_KINDS.filter((candidate) => candidate.writes.includes(read.artifact)).map((candidate) => `"${candidate.kind}"`).join(' or ') || 'nothing'} kind)`);
  const nothingFound = (kind: WriterUnitKindName, position: number, reason: string): void => { kinds.push({ kind, position, state: 'nothing-found', reason, units: [] }); };
  /** The page a written unit left, as the artifact later units read: the kind, the path and the text as it stands. */
  const rememberPage = async (artifact: WriterArtifact, kind: WriterUnitKindName, unit: string, page: string, title: string): Promise<void> => {
    const text = await sink.read(page).catch(() => undefined);
    note(artifact, { kind, unit, path: page, title, ...(text === undefined ? {} : { text }) });
  };
  /**
   * Why one of the graph's own pages does not run, or undefined when the product's wiki shows its kind. The manifest
   * says which kinds the wiki shows (decision 0029), so a page of a kind the product does not declare is a page no
   * reader could open: the unit does not run, the run says why, and the absence alone never makes the run a failure.
   */
  const pageKindGate = (pageKind: string): string | undefined => (declaresKind(pageKind)
    ? undefined
    : `the product's manifest (${KINDS_FILE}) declares no ${JSON.stringify(pageKind)} kind, so this run wrote no page of that kind: the wiki shows no page of a kind its manifest does not declare`);

  let product: UnitOutcome = { ...keptOutcome(productUnit.id, PRODUCT_PATH) };
  let declarations: readonly DomainDeclaration[] = [];
  let productPage = '';
  const domainOutcomes: UnitOutcome[] = [];
  const guides: UnitOutcome[] = [];

  const localizedSources: UnitOutcome[] = [];
  const localizedEntities = [...(options.documentEntities ?? [])].sort((a, b) => byCodePoint(a.id, b.id));
  /**
   * The localized statements of the documents' entities (madarch-m38l.18), written where they were written before this
   * change: after the domain pages and before the guides. They are no kind of 0032's table — a passage shown in the
   * wiki's language is neither a reading of the document nor an enrichment of it, it is the same passage in the
   * reader's language — and the graph of kinds is additive around them: a product that declares none of the new kinds
   * gets the same units, in the same order, as before.
   */
  const runLocalizedSources = async (): Promise<void> => {
    for (const entity of localizedEntities) {
      halt(`writing the localized statement of ${JSON.stringify(entity.id)}`);
      const sourceLanguage = detectDocumentLanguage(entity.text);
      if (sourceLanguage === undefined) {
        const id = `localized-source:${entity.id}`;
        const file = localizedSourcePath(entity);
        const refusal = { line: entity.line, rule: 'source-language', message: 'the source language cannot be identified confidently as English or Russian; no smaller localized statement was written' };
        const outcome: UnitOutcome = { ...keptOutcome(id, file), status: 'not-written', refusals: [refusal] };
        options.onUnitStart?.({ unit: id, path: file });
        options.onUnit?.(outcome);
        localizedSources.push(outcome);
        continue;
      }
      if (sourceLanguage === language) {
        localizedSources.push(keptOutcome(`localized-source:${entity.id}`, localizedSourcePath(entity)));
        continue;
      }
      const unitPath = localizedSourcePath(entity);
      let existing: string | undefined;
      try { existing = await sink.read(unitPath); } catch { existing = undefined; }
      if (existing !== undefined) {
        const validated = parseLocalizedSource(unitPath, existing, entity, language);
        if (validated.ok && validated.source.sourceLanguage === sourceLanguage) {
          // The page a run of yesterday wrote: told as this run's unit too, so the count against the total reaches its end.
          const kept = keptOutcome(`localized-source:${entity.id}`, unitPath);
          options.onUnitStart?.({ unit: kept.unit, path: unitPath });
          options.onUnit?.(kept);
          localizedSources.push(kept);
          continue;
        }
      }
      const spec: UnitSpec = { kind: 'localized-source', id: `localized-source:${entity.id}`, path: unitPath, entity, sourceLanguage, language: language === 'ru' ? 'ru' : 'en' };
      options.onUnitStart?.({ unit: spec.id, path: spec.path });
      const tools = new UnitTools(view, spec, sink, [], bounds, basis, extras);
      const result = await runUnit(options.agent, tools, localizedSourcePrompt({ entity, language: spec.language, sourceLanguage, file: entity.path }));
      const outcome: UnitOutcome = result.status === 'not-written'
        ? { ...result, status: 'failed', refusals: [{ line: entity.line, rule: 'localized-source-missing', message: `${unitPath}:1: the writer ended without a valid localized statement` }] }
        : result;
      options.onUnit?.(outcome);
      localizedSources.push(outcome);
    }
  };

  // How many pages this run means to write (madarch-m38l.23): counted from the work the run will take up, once the
  // product page has declared its domains — never grown after it, so the bar a reader watches never moves backward.
  // Every page counted here is a unit the run announces, written or kept: a passage in the pages' own language writes
  // no page at all and is not counted; a translation and a unit of an earlier run are kept and told as pages.
  const pageEntities = options.documentEntities ?? [];
  /** The passages the enrichment kinds write a page for, as the kinds' loops take them up. */
  const enrichmentEntities = (): readonly DocEntity[] => pageEntities.filter((entity) => (entity.pass === 'classifier' && entity.semantics === 'other') || entity.semantics === 'rule' || entity.semantics === 'decision' || entity.semantics === 'scenario');
  const intendedPages = (domainDeclarations: number): number => {
    let total = 1; // the product page is always a unit: written, or kept as it stands
    total += domainDeclarations;
    total += localizedEntities.filter((entity) => detectDocumentLanguage(entity.text) !== language).length;
    if (options.guides !== undefined) total += 2;
    if (declaresKind('enrichment')) total += enrichmentEntities().length;
    if (declaresKind('validation')) total += 1;
    if (declaresKind('overview')) total += 1;
    // The editorial page stands on what the run read and on the pages it wrote: a run with no passage enriched and no
    // product page has no such page, exactly as the kind's own case decides before it runs.
    if (pageKindGate('editorial') === undefined && declaresKind('enrichment') && enrichmentEntities().length > 0) total += 1;
    return total;
  };

  for (const [position, kind] of order.entries()) {
    const missing = absent(kind);
    if (missing.length > 0) {
      kinds.push({ kind, position, state: 'blocked', reason: `the unit cannot run: it requires ${missing.join(', ')}, and no unit of this run produced it`, units: [] });
      continue;
    }
    const runs: WriterUnitRun[] = [];
    switch (kind) {
      case 'document-interpretation': {
        // The enrichment page is a kind of the product's wiki: where the manifest declares none, its pages are pages no
        // reader could open, so no enrichment unit is planned and a run writes exactly what it wrote before this change.
        const noEnrichmentPages = pageKindGate('enrichment');
        if (noEnrichmentPages !== undefined) { nothingFound(kind, position, noEnrichmentPages); break; }
        // The passages whose reading is still open: the document's own structure and the manifest decided
        // the rest (madarch-ztyq.3). One unit per passage, in the identity's code point order.
        const open = [...(options.documentEntities ?? [])]
          .filter((entity) => entity.pass === 'classifier' && entity.semantics === 'other')
          .sort((left, right) => byCodePoint(left.id, right.id));
        if (open.length === 0) { nothingFound(kind, position, 'the documents hold no passage the classifier left as "other": every passage that no manifest or structural pass decided was read as a general kind'); break; }
        for (const entity of open) {
          const page = enrichmentPath(entity);
          const run = await runGraphUnit({
            id: `enrichment:${entity.id}`, kind, scope: entity.id, path: page,
            digest: writerUnitDigest({ kind, version: versionOf(kind), scope: entity.id, language, inputs: [entity.kind, entity.text, entity.anchor, ...pinned(), ...upstreamOf(kind), ...questions.filter((question) => question.about.includes(entity.id)).map((question) => `${question.id}:${question.status}:${textDigest(question.title)}`), ...corrections.filter((correction) => correction.id.trim() !== '' && correction.statement.trim() !== '' && correction.about.startsWith(entity.id)).map((correction) => textDigest(`${correction.id}\n${correction.statement}`))] }),
            state, resumed, sink, now, stateProblem, halt,
            ...(options.onUnitStart === undefined ? {} : { onUnitStart: options.onUnitStart }),
            ...(options.onUnit === undefined ? {} : { onUnit: options.onUnit }),
            start: async () => {
              const spec: UnitSpec = { kind: 'enrichment', id: `enrichment:${entity.id}`, path: page, entity, task: ENRICHMENT_TASKS['document-interpretation']! };
              const tools = new UnitTools(view, spec, sink, [], bounds, basis, extras);
              return await runUnit(options.agent, tools, await enrichmentPrompt(view, { id: spec.id, path: page, entity, enriches: entity.id, task: ENRICHMENT_TASKS['document-interpretation']! }, language, { questions, reads: readsFor(kind) }));
            },
          });
          runs.push(run.run);
          if (run.outcome !== undefined) enrichments.push(run.outcome);
          if (run.run.status === 'written' || run.run.status === 'kept') await rememberPage('document-readings', kind, run.run.unit, page, entity.title);
          if (run.run.status === 'failed' || run.run.status === 'not-written') loopProblems.push(`${path.resolve(options.output, page)}:1: the enrichment of ${entity.id} was not written: ${run.run.reason ?? 'no reason given'}`);
        }
        kinds.push({ kind, position, state: 'ran', units: runs });
        break;
      }
      case 'graph-validation': {
        const undeclared = pageKindGate('validation');
        const id = productUnitId(kind, slug);
        if (undeclared !== undefined) { nothingFound(kind, position, undeclared); break; }
        const run = await runGraphUnit({
          id, kind, scope: slug, path: VALIDATION_PATH, pageStandingKeepsTheUnit: true,
          digest: writerUnitDigest({ kind, version: versionOf(kind), scope: slug, language, inputs: [...pinned(), ...upstreamOf(kind)] }),
          state, resumed, sink, now, stateProblem, halt,
          ...(options.onUnitStart === undefined ? {} : { onUnitStart: options.onUnitStart }),
          ...(options.onUnit === undefined ? {} : { onUnit: options.onUnit }),
          start: async () => {
            const spec: UnitSpec = { kind: 'validation', id, path: VALIDATION_PATH, name: options.productName };
            const tools = new UnitTools(view, spec, sink, [], bounds, basis, extras);
            return await runUnit(options.agent, tools, await validationPrompt(view, { id, path: VALIDATION_PATH, name: options.productName }, language, { questions, reads: readsFor(kind) }));
          },
        });
        runs.push(run.run);
        if (run.run.status === 'written' || run.run.status === 'kept') await rememberPage('validation-verdicts', kind, id, VALIDATION_PATH, `Graph verdicts of ${options.productName}`);
        kinds.push({ kind, position, state: 'ran', units: runs });
        break;
      }
      case 'product': {
        const brief = need.product ? briefFor(productUnit.id, PRODUCT_PATH, existingProduct) : undefined;
        if (need.product) expect(productUnit.id, brief);
        if (!need.product) {
          // The page is there and stays: its domains are the pages it links, as those pages say. It is told as a unit of
          // this run like any other, so the reader counts it against the total and its row is there from the start.
          declarations = await declaredNow();
          product = { ...keptOutcome(productUnit.id, PRODUCT_PATH), domains: [...declarations] };
          options.onUnitStart?.({ unit: product.unit, path: PRODUCT_PATH });
          options.onUnit?.(product);
          runs.push({ unit: productUnit.id, kind, path: PRODUCT_PATH, status: 'kept', reason: 'the page is there and this run was not asked to write it again' });
        } else {
          const run = await runGraphUnit({
            id: productUnit.id, kind, scope: slug, path: PRODUCT_PATH, asked: true,
            digest: writerUnitDigest({ kind, version: versionOf(kind), scope: slug, language, inputs: [...pinned(), briefOf(brief), String(need.product), ...upstreamOf(kind)] }),
            state, resumed, sink, now, stateProblem, halt,
            ...(options.onUnitStart === undefined ? {} : { onUnitStart: options.onUnitStart }),
            ...(options.onUnit === undefined ? {} : { onUnit: options.onUnit }),
            start: async () => {
              const productTools = new UnitTools(view, productUnit, sink, [], bounds, basis, extras);
              const declared = existingProduct === null ? [] : await declaredNow();
              return await runUnit(options.agent, productTools, await productPrompt(view, productUnit, language, { ...(brief === undefined ? {} : { brief }), questions, declared, reads: readsFor(kind) }));
            },
          });
          runs.push(run.run);
          // A product page this run kept still declares its domains: they are the pages it links, as those pages say.
          product = run.run.status === 'kept' || run.outcome === undefined
            ? { ...(run.outcome ?? keptOutcome(productUnit.id, PRODUCT_PATH)), domains: await declaredNow() }
            : run.outcome;
          declarations = product.domains;
          finish(productUnit.id, product);
        }
        if (product.status === 'written' || (runs[0]?.status === 'kept')) {
          try {
            productPage = await sink.read(PRODUCT_PATH);
          } catch (error) {
            throw new Error(`src/writer/run.ts: the product page ${PRODUCT_PATH} was written but cannot be read back for the domain units: ${(error as Error).message}`);
          }
          await rememberPage('product-page', kind, productUnit.id, PRODUCT_PATH, options.productName);
          note('domain-declarations', { kind, unit: productUnit.id, path: PRODUCT_PATH, title: options.productName });
        }
        // The domains the page declares are known only now, so the count is told once, here: before this the reader sees
        // how many pages stand and no denominator, and from here the denominator is the run's whole plan.
        options.onTotal?.(intendedPages(declarations.length));
        kinds.push({ kind, position, state: 'ran', units: runs });
        break;
      }
      case 'rules-and-decisions': {
        // The enrichment page is a kind of the product's wiki: where the manifest declares none, its pages are pages no
        // reader could open, so no enrichment unit is planned and a run writes exactly what it wrote before this change.
        const noEnrichmentPages = pageKindGate('enrichment');
        if (noEnrichmentPages !== undefined) { nothingFound(kind, position, noEnrichmentPages); break; }
        const entities = [...(options.documentEntities ?? [])]
          .filter((entity) => entity.semantics === 'rule' || entity.semantics === 'decision')
          .sort((left, right) => byCodePoint(left.id, right.id));
        if (entities.length === 0) { nothingFound(kind, position, 'the documents hold no passage read as a rule or as a decision'); break; }
        for (const entity of entities) {
          const page = enrichmentPath(entity);
          const task = ENRICHMENT_TASKS[entity.semantics] ?? ENRICHMENT_TASKS['rule']!;
          const run = await runGraphUnit({
            id: `enrichment:${entity.id}`, kind, scope: entity.id, path: page,
            digest: writerUnitDigest({ kind, version: versionOf(kind), scope: entity.id, language, inputs: [entity.kind, entity.text, entity.anchor, entity.semantics, ...pinned(), ...upstreamOf(kind)] }),
            state, resumed, sink, now, stateProblem, halt,
            ...(options.onUnitStart === undefined ? {} : { onUnitStart: options.onUnitStart }),
            ...(options.onUnit === undefined ? {} : { onUnit: options.onUnit }),
            start: async () => {
              const spec: UnitSpec = { kind: 'enrichment', id: `enrichment:${entity.id}`, path: page, entity, task };
              const tools = new UnitTools(view, spec, sink, [], bounds, basis, extras);
              return await runUnit(options.agent, tools, await enrichmentPrompt(view, { id: spec.id, path: page, entity, enriches: entity.id, task }, language, { questions, reads: readsFor(kind) }));
            },
          });
          runs.push(run.run);
          if (run.outcome !== undefined) enrichments.push(run.outcome);
          if (run.run.status === 'written' || run.run.status === 'kept') await rememberPage(entity.semantics === 'decision' ? 'decision-enrichments' : 'rule-enrichments', kind, run.run.unit, page, entity.title);
          if (run.run.status === 'failed' || run.run.status === 'not-written') loopProblems.push(`${path.resolve(options.output, page)}:1: the enrichment of ${entity.id} was not written: ${run.run.reason ?? 'no reason given'}`);
        }
        kinds.push({ kind, position, state: 'ran', units: runs });
        break;
      }
      case 'scenarios': {
        // The enrichment page is a kind of the product's wiki: where the manifest declares none, its pages are pages no
        // reader could open, so no enrichment unit is planned and a run writes exactly what it wrote before this change.
        const noEnrichmentPages = pageKindGate('enrichment');
        if (noEnrichmentPages !== undefined) { nothingFound(kind, position, noEnrichmentPages); break; }
        const entities = [...(options.documentEntities ?? [])]
          .filter((entity) => entity.semantics === 'scenario')
          .sort((left, right) => byCodePoint(left.id, right.id));
        if (entities.length === 0) { nothingFound(kind, position, 'the documents hold no passage read as a scenario'); break; }
        for (const entity of entities) {
          const page = enrichmentPath(entity);
          const task = ENRICHMENT_TASKS['scenario']!;
          const run = await runGraphUnit({
            id: `enrichment:${entity.id}`, kind, scope: entity.id, path: page,
            digest: writerUnitDigest({ kind, version: versionOf(kind), scope: entity.id, language, inputs: [entity.kind, entity.text, entity.anchor, entity.semantics, ...pinned(), ...upstreamOf(kind)] }),
            state, resumed, sink, now, stateProblem, halt,
            ...(options.onUnitStart === undefined ? {} : { onUnitStart: options.onUnitStart }),
            ...(options.onUnit === undefined ? {} : { onUnit: options.onUnit }),
            start: async () => {
              const spec: UnitSpec = { kind: 'enrichment', id: `enrichment:${entity.id}`, path: page, entity, task };
              const tools = new UnitTools(view, spec, sink, [], bounds, basis, extras);
              return await runUnit(options.agent, tools, await enrichmentPrompt(view, { id: spec.id, path: page, entity, enriches: entity.id, task }, language, { questions, reads: readsFor(kind) }));
            },
          });
          runs.push(run.run);
          if (run.outcome !== undefined) enrichments.push(run.outcome);
          if (run.run.status === 'written' || run.run.status === 'kept') await rememberPage('scenario-enrichments', kind, run.run.unit, page, entity.title);
          if (run.run.status === 'failed' || run.run.status === 'not-written') loopProblems.push(`${path.resolve(options.output, page)}:1: the enrichment of ${entity.id} was not written: ${run.run.reason ?? 'no reason given'}`);
        }
        kinds.push({ kind, position, state: 'ran', units: runs });
        break;
      }
      case 'domains': {
        for (const declaration of declarations) {
          const page = `${DOMAINS_FOLDER}/${declaration.slug}.md`;
          if (!need.domain(page)) {
            // The page is there and stays: the unit does not run, and it is told as a kept page.
            const kept = keptOutcome(`domain:${declaration.slug}`, page);
            options.onUnitStart?.({ unit: kept.unit, path: page });
            options.onUnit?.(kept);
            domainOutcomes.push(kept);
            runs.push({ unit: kept.unit, kind, path: page, status: 'kept', reason: 'the page is there and this run was not asked to write it again' });
            await rememberPage('domain-pages', kind, kept.unit, page, declaration.title);
            continue;
          }
          const spec: UnitSpec = { kind: 'domain', id: `domain:${declaration.slug}`, path: page, domain: declaration, productId: productUnit.id };
          const brief = briefFor(spec.id, page, domainPages.includes(page) ? await sink.read(page) : null);
          expect(spec.id, brief);
          const run = await runGraphUnit({
            id: spec.id, kind, scope: declaration.slug, path: page, asked: true,
            digest: writerUnitDigest({ kind, version: versionOf(kind), scope: declaration.slug, language, inputs: [...pinned(), declaration.summary, ...declaration.evidence, briefOf(brief), ...upstreamOf(kind)] }),
            state, resumed, sink, now, stateProblem, halt,
            ...(options.onUnitStart === undefined ? {} : { onUnitStart: options.onUnitStart }),
            ...(options.onUnit === undefined ? {} : { onUnit: options.onUnit }),
            start: async () => {
              const tools = new UnitTools(view, spec, sink, declarations, bounds, basis, extras);
              return await runUnit(options.agent, tools, await domainPrompt(view, spec, productPage, declarations, language, { ...(brief === undefined ? {} : { brief }), questions, reads: readsFor(kind) }));
            },
          });
          runs.push(run.run);
          const outcome = run.outcome ?? keptOutcome(spec.id, page);
          if (run.outcome === undefined) options.onUnit?.(outcome);
          finish(spec.id, outcome);
          // The run's own list of domain outcomes names every domain the product declares, as it did before.
          if (!domainOutcomes.some((held) => held.unit === spec.id)) domainOutcomes.push(outcome);
          await rememberPage('domain-pages', kind, spec.id, page, declaration.title);
        }
        kinds.push({ kind, position, state: 'ran', units: runs });
        break;
      }
      case 'guides': {
        // The localized statements stand here, after the domain pages and before the guides, exactly as they did before
        // the graph of kinds: a product that declares none of the new kinds runs the same units in the same order.
        await runLocalizedSources();
        if (options.guides === undefined) { nothingFound(kind, position, 'the run wires no checked guide production, so no guide unit runs'); break; }
        for (const guideKind of ['administrator-guide', 'user-guide'] as const) {
          // The guides are the one kind whose units the writer runs itself: the same boundary is asked of them here.
          halt(`writing the ${guideKind}`);
          let output = { id: GUIDE_OUTPUTS[guideKind].id as string, path: 'madarch/kinds.yaml' };
          let outcome: UnitOutcome;
          let preparationStage: GuidePreparationStage = 'registry';
          try {
            output = registeredGuideOutput(options.output, guideKind);
            options.onUnitStart?.({ unit: output.id, path: output.path });
            preparationStage = 'preparation';
            const prepared = await options.guides.prepare(guideKind, language === 'ru' ? 'ru' : 'en');
            preparationStage = 'current-proof';
            const currentPath = currentGuidePath(prepared);
            if (currentPath !== undefined) {
              if (currentPath !== output.path) throw new Error('guide current proof is bound to another registered path');
              outcome = keptOutcome(output.id, output.path);
              guides.push(outcome);
              options.onUnit?.(outcome);
              runs.push({ unit: output.id, kind, path: output.path, status: 'kept', reason: 'the guide is current and its proof stands' });
              note('guides', { kind, unit: output.id, path: output.path, title: guideKind });
              continue;
            }
            preparationStage = 'unit';
            const spec: UnitSpec = { kind: guideKind, id: output.id, path: output.path, prepared };
            const guideBounds = { ...bounds, maxCalls: bounds.maxCalls + guidePageCount(prepared) };
            const tools = new UnitTools(view, spec, sink, [], guideBounds, basis, extras);
            outcome = await runUnit(options.agent, tools, guidePrompt(guideKind, language === 'ru' ? 'ru' : 'en', prepared.prompt));
            if (outcome.status === 'not-written') outcome = { ...outcome, status: 'failed', refusals: [{ line: 1, rule: 'guide-missing', message: `${path.resolve(options.output, output.path)}:1: $.guide: the unit ended without a verified guide` }] };
          } catch (failure) {
            outcome = { ...keptOutcome(output.id, output.path), status: 'failed', refusals: [formatGuidePreparationError(failure, { file: path.resolve(options.output, output.path), stage: preparationStage })] };
          }
          guides.push(outcome);
          options.onUnit?.(outcome);
          runs.push({ unit: output.id, kind, path: output.path, status: outcome.status, ...(outcome.status === 'written' ? {} : { reason: unitEndedOn(outcome) }) });
          if (outcome.status === 'written') note('guides', { kind, unit: output.id, path: output.path, title: guideKind });
        }
        kinds.push({ kind, position, state: 'ran', units: runs });
        break;
      }
      case 'overview': {
        const undeclared = pageKindGate('overview');
        const id = productUnitId(kind, slug);
        if (undeclared !== undefined) { nothingFound(kind, position, undeclared); break; }
        // The domains the home page may link: the ones this run's product page declared, or — when that page
        // failed — the ones the pages that stand declare, so a link is never refused for a declaration the run lost.
        const linkedDomains = declarations.length > 0 ? declarations : await declaredNow().catch(() => []);
        const pages = [...artifactsOf('product-page'), ...artifactsOf('domain-pages'), ...artifactsOf('validation-verdicts')];
        const run = await runGraphUnit({
          id, kind, scope: slug, path: OVERVIEW_PATH, pageStandingKeepsTheUnit: true,
          digest: writerUnitDigest({ kind, version: versionOf(kind), scope: slug, language, inputs: [...pinned(), ...pages.map((page) => textDigest(`${page.unit}\n${page.path}\n${page.text ?? ''}`)), ...upstreamOf(kind)] }),
          state, resumed, sink, now, stateProblem, halt,
          ...(options.onUnitStart === undefined ? {} : { onUnitStart: options.onUnitStart }),
          ...(options.onUnit === undefined ? {} : { onUnit: options.onUnit }),
          start: async () => {
            const spec: UnitSpec = { kind: 'overview', id, path: OVERVIEW_PATH, name: options.productName, productId: productUnit.id };
            // The pages this run published are the only pages the home page may point at by id: every other page
            // it names is a document section or a part of the graph.
            const linked = [...artifactsOf('product-page'), ...artifactsOf('domain-pages')].map((page) => ({ id: page.unit, path: page.path, title: page.title }));
            const tools = new UnitTools(view, spec, sink, linkedDomains, bounds, basis, { ...extras, linkedPages: linked.map((page) => page.id) });
            return await runUnit(options.agent, tools, await overviewPrompt(view, { id, path: OVERVIEW_PATH, name: options.productName }, linked, language, { questions, reads: readsFor(kind) }));
          },
        });
        runs.push(run.run);
        if (run.run.status === 'written' || run.run.status === 'kept') await rememberPage('overview-page', kind, id, OVERVIEW_PATH, `The home page of ${options.productName}`);
        kinds.push({ kind, position, state: 'ran', units: runs });
        break;
      }
      case 'editorial': {
        const undeclared = pageKindGate('editorial');
        if (undeclared !== undefined) { nothingFound(kind, position, undeclared); break; }
        // The pages this run wrote from a document reading: what an editor has to hold consistent with the
        // documents. A run that read no document has no such page, and says so.
        const reading = [...artifactsOf('document-readings'), ...artifactsOf('rule-enrichments'), ...artifactsOf('decision-enrichments'), ...artifactsOf('scenario-enrichments')];
        const pages = [...artifactsOf('product-page'), ...artifactsOf('domain-pages'), ...artifactsOf('overview-page')];
        if (reading.length === 0 || pages.length === 0) {
          kinds.push({ kind, position, state: 'nothing-found', reason: reading.length === 0 ? 'no unit of this run read a document passage, so no page stands on a reading an editor could hold it to' : 'the run wrote no page for an editor to read', units: [] });
          break;
        }
        const id = productUnitId(kind, slug);
        const run = await runGraphUnit({
          id, kind, scope: slug, path: EDITORIAL_PATH, pageStandingKeepsTheUnit: true,
          digest: writerUnitDigest({ kind, version: versionOf(kind), scope: slug, language, inputs: [...pinned(), ...pages.map((page) => textDigest(`${page.unit}\n${page.path}\n${page.text ?? ''}`)), ...reading.map((page) => textDigest(`${page.path}\n${page.text ?? ''}`)), ...upstreamOf(kind)] }),
          state, resumed, sink, now, stateProblem, halt,
          ...(options.onUnitStart === undefined ? {} : { onUnitStart: options.onUnitStart }),
          ...(options.onUnit === undefined ? {} : { onUnit: options.onUnit }),
          start: async () => {
            const spec: UnitSpec = { kind: 'editorial', id, path: EDITORIAL_PATH, name: options.productName };
            const tools = new UnitTools(view, spec, sink, declarations, bounds, basis, extras);
            return await runUnit(options.agent, tools, await editorialPrompt(view, { id, path: EDITORIAL_PATH }, pages.map((page) => ({ id: page.unit, path: page.path, title: page.title })), language, { questions, reads: readsFor(kind) }));
          },
        });
        runs.push(run.run);
        kinds.push({ kind, position, state: 'ran', units: runs });
        break;
      }
    }
    units.push(...runs);
  }

  if (options.resolved !== undefined) {
    for (const [key, unitsOfKey] of [...expected].sort(([a], [b]) => byCodePoint(a, b))) {
      const written = done.get(key);
      if (written === undefined || written.size !== unitsOfKey.size) continue;
      const [kind, ...rest] = key.split(':');
      try {
        await options.resolved({ kind: kind as 'question' | 'correction', slug: rest.join(':'), pages: [...unitsOfKey].sort(byCodePoint) });
      } catch (error) {
        loopProblems.push(`${key}: it was used but could not be marked resolved: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const stale = (await existingDomainPages(options.output)).filter((page) => !domainOutcomes.some((unit) => unit.path === page));
  const kindOf = (name: WriterUnitKindName): WriterKindRun => kinds.find((kind) => kind.kind === name) ?? { kind: name, position: -1, state: 'nothing-found', reason: 'the kind is not declared by the writer', units: [] };
  return {
    content,
    product,
    domains: domainOutcomes,
    localizedSources,
    guides,
    units: units.filter((unit) => unit.status !== 'kept').length,
    ok: guides.every((unit) => unit.status === 'written') && product.status === 'written' && domainOutcomes.every((d) => d.status === 'written') && localizedSources.every((outcome) => { if (outcome.status === 'failed') return false; const entity = localizedEntities.find((candidate) => `localized-source:${candidate.id}` === outcome.unit); const sourceLanguage = entity === undefined ? undefined : detectDocumentLanguage(entity.text); return sourceLanguage === undefined || sourceLanguage === language || outcome.status === 'written'; }) && indexErrors.length === 0 && loopProblems.length === 0
      && kinds.every((kind) => kind.state !== 'blocked' && kind.units.every((unit) => unit.status === 'written' || unit.status === 'kept')),
    stale,
    indexErrors,
    loopProblems,
    questions: askedIds,
    order,
    graph: kinds,
    enrichments,
    stateProblems,
    validation: kindOf('graph-validation'),
    overview: kindOf('overview'),
    editorial: kindOf('editorial'),
  };
}
