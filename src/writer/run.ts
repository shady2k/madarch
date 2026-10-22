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
  /** Called with each unit's outcome as it ends. */
  readonly onUnit?: (outcome: UnitOutcome) => void;
}

export interface WriterReport {
  readonly content: ContentReport;
  readonly product: UnitOutcome;
  readonly domains: readonly UnitOutcome[];
  /** The number of agent units that ran. */
  readonly units: number;
  readonly ok: boolean;
  /** Domain pages already in the output that this run did not write: left alone, named here. */
  readonly stale: readonly string[];
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
  const sink = options.sink ?? fsSink(options.output);
  const slug = productSlug(options.productName);
  const productUnit: UnitSpec = { kind: 'product', id: `product:${slug}`, path: PRODUCT_PATH, name: options.productName };
  const productTools = new UnitTools(view, productUnit, sink, [], bounds);
  const product = await runUnit(options.agent, productTools, await productPrompt(view, productUnit));
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
      const spec: UnitSpec = { kind: 'domain', id: `domain:${declaration.slug}`, path: `${DOMAINS_FOLDER}/${declaration.slug}.md`, domain: declaration, productId: productUnit.id };
      const tools = new UnitTools(view, spec, sink, product.domains, bounds);
      const outcome = await runUnit(options.agent, tools, await domainPrompt(view, spec, productPage, product.domains));
      options.onUnit?.(outcome);
      domains.push(outcome);
    }
  }
  const stale = (await existingDomainPages(options.output)).filter((page) => !domains.some((d) => d.path === page));
  return { content, product, domains, units: 1 + domains.length, ok: product.status === 'written' && domains.every((d) => d.status === 'written'), stale };
}

export type { DomainDeclaration };
