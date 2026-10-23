/**
 * The knowledge writer (decision 0029; the vertical's formats, section 1):
 * after the deterministic fill, one agent unit for the product, then one per
 * domain the product page declared, each reading the graph through tools and
 * writing one Markdown file in the product repository.
 *
 * The agent is an interface (`UnitAgent`): a real one drives an ACP agent
 * (`acp-agent.ts`), a scripted one answers a test. Around it the core is
 * deterministic: the units run in a fixed order (product, then domains in
 * slug order), the prompts come from the graph, the tools answer in
 * code-point order, and a checked page is written in canonical form, so the
 * same graph, prompts and answers give the same files.
 */
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { GraphStore } from '../graph/index.js';
import { byCodePoint } from '../model/order.js';
import type { McpToolDefinition } from '../fill/unit-mcp.js';
import { writtenAtOf } from './basis.js';
import { MAX_SLUG_LENGTH, SLUG } from './format.js';
import { domainPrompt, productPrompt } from './prompts.js';
import { DEFAULT_UNIT_BOUNDS, UnitTools, type DomainDeclaration, type PageSink, type ToolAnswer, type UnitBounds, type UnitOutcome, type UnitSpec } from './tools.js';
import { GraphView, ingestContent, type ContentReport } from './view.js';

export const PRODUCT_PATH = 'docs/product.md';
export const DOMAINS_FOLDER = 'docs/domains';

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
export interface UnitAgent {
  run(request: UnitRequest): Promise<void>;
}

export interface WriterOptions {
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
}

export interface WriterReport {
  readonly content: ContentReport;
  /** The product unit's outcome; when every page was there and no unit ran, the page as kept: written, with no attempt and no call. */
  readonly product: UnitOutcome;
  readonly domains: readonly UnitOutcome[];
  /** The number of agent units that ran. */
  readonly units: number;
  readonly ok: boolean;
  /** Domain pages already in the output that this run did not write: left alone, named here. */
  readonly stale: readonly string[];
  /** What `afterWrite` raised, with the page it was told about; the run is not `ok` while this is not empty. */
  readonly indexErrors: readonly string[];
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
  /** The product unit runs: it also declares the domains, so it runs whenever any page is needed. */
  readonly product: boolean;
  /** A domain page is written when this says so for its path. */
  readonly domain: (path: string) => boolean;
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

/** Writes pages under a folder; a page lands whole or not at all. */
let counter = 0;

export function fsSink(root: string): PageSink {
  return {
    async write(relativePath: string, content: string): Promise<void> {
      const target = path.resolve(root, relativePath);
      if (!target.startsWith(`${path.resolve(root)}${path.sep}`) || !/^docs\/(product\.md|domains\/[a-z][a-z0-9-]*\.md)$/.test(relativePath)) {
        throw new Error(`src/writer/run.ts: ${JSON.stringify(relativePath)} is not a page the writer may write`);
      }
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${(counter += 1)}.writing`;
      await writeFile(temporary, content, 'utf8');
      await rename(temporary, target);
    },
    read: (relativePath) => readFile(path.resolve(root, relativePath), 'utf8'),
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
  };
}

async function runUnit(agent: UnitAgent, tools: UnitTools, prompt: string): Promise<UnitOutcome> {
  const client: ToolClient = { definitions: tools.tools, call: (tool, args) => tools.call(tool, args), finished: () => tools.finished };
  try {
    await agent.run({ id: tools.unit.id, prompt, tools: client });
  } catch (error) {
    const outcome = tools.outcome();
    const message = error instanceof Error ? error.message : String(error);
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

export async function runWriter(options: WriterOptions): Promise<WriterReport> {
  const bounds = options.bounds ?? DEFAULT_UNIT_BOUNDS;
  const view = await GraphView.open(options.owner, options.store);
  const content = await ingestContent(options.owner, options.store, view, options.repository, options.ref);
  const inner = options.sink ?? fsSink(options.output);
  const indexErrors: string[] = [];
  const sink: PageSink = options.afterWrite === undefined ? inner : {
    read: inner.read,
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
  const productUnit: UnitSpec = { kind: 'product', id: `product:${slug}`, path: PRODUCT_PATH, name: options.productName };
  const language = options.language ?? 'en';
  let existingProduct: string | null = null;
  try { existingProduct = await sink.read(PRODUCT_PATH); } catch { existingProduct = null; }
  const need = (options.needed ?? unitsNeeded)({ productPage: existingProduct, domainPages: await existingDomainPages(options.output), languageChanged: options.languageChanged === true });
  if (!need.product) {
    // Every page is there and in the language asked: nothing to write, and the pages' grounds are re-checked by the wiki.
    const kept: UnitOutcome = { unit: productUnit.id, status: 'written', path: PRODUCT_PATH, writeAttempts: 0, calls: 0, refusals: [], domains: [], grounds: [], links: [], filesRead: [] };
    return { content, product: kept, domains: [], units: 0, ok: true, stale: [], indexErrors: [] };
  }
  options.onUnitStart?.({ unit: productUnit.id, path: productUnit.path });
  const productTools = new UnitTools(view, productUnit, sink, [], bounds, basis);
  const product = await runUnit(options.agent, productTools, await productPrompt(view, productUnit, language));
  options.onUnit?.(product);
  const domains: UnitOutcome[] = [];
  if (product.status === 'written') {
    let productPage = '';
    try {
      productPage = await sink.read(PRODUCT_PATH);
    } catch (error) {
      throw new Error(`src/writer/run.ts: the product page ${PRODUCT_PATH} was written but cannot be read back for the domain units: ${(error as Error).message}`);
    }
    for (const declaration of product.domains) {
      if (!need.domain(`${DOMAINS_FOLDER}/${declaration.slug}.md`)) {
        // The page is there and stays: the unit does not run, and it is told as a kept page.
        const kept: UnitOutcome = { unit: `domain:${declaration.slug}`, status: 'written', path: `${DOMAINS_FOLDER}/${declaration.slug}.md`, writeAttempts: 0, calls: 0, refusals: [], domains: [], grounds: [], links: [], filesRead: [] };
        options.onUnit?.(kept);
        domains.push(kept);
        continue;
      }
      const spec: UnitSpec = { kind: 'domain', id: `domain:${declaration.slug}`, path: `${DOMAINS_FOLDER}/${declaration.slug}.md`, domain: declaration, productId: productUnit.id };
      options.onUnitStart?.({ unit: spec.id, path: spec.path });
      const tools = new UnitTools(view, spec, sink, product.domains, bounds, basis);
      const outcome = await runUnit(options.agent, tools, await domainPrompt(view, spec, productPage, product.domains, language));
      options.onUnit?.(outcome);
      domains.push(outcome);
    }
  }
  const stale = (await existingDomainPages(options.output)).filter((page) => !domains.some((d) => d.path === page));
  return { content, product, domains, units: 1 + domains.length, ok: product.status === 'written' && domains.every((d) => d.status === 'written') && indexErrors.length === 0, stale, indexErrors };
}

export type { DomainDeclaration };
