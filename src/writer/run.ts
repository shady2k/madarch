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
import { lstat, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { GraphStore } from '../graph/index.js';
import { byCodePoint } from '../model/order.js';
import type { McpToolDefinition } from '../fill/unit-mcp.js';
import { parse as parseYaml } from 'yaml';
import { splitFrontMatter } from '../knowledge/markdown.js';
import { parseQuestion, parseStatementRef, QUESTIONS_FOLDER, readCorrections, readQuestions, type Correction, type Question } from '../loop/entities.js';
import { writtenAtOf } from './basis.js';
import type { DocEntity } from '../knowledge/doc-entities.js';
import { detectDocumentLanguage, localizedSourcePath, localizedSourcePrompt, parseLocalizedSource, renderLocalizedSource, LOCALIZED_SOURCE_SCHEMA } from './localized-source.js';
import { includedNotes, type ChangeNote, type EditBrief } from './edit.js';
import { statementsOf } from './sentences.js';
import { MAX_SLUG_LENGTH, SLUG } from './format.js';
import { domainPrompt, productPrompt, type UnitContext } from './prompts.js';
import { DEFAULT_UNIT_BOUNDS, UnitTools, type DomainDeclaration, type PageSink, type ToolAnswer, type UnitBounds, type UnitOutcome, type UnitSpec } from './tools.js';
import { GraphView, ingestContent, type ContentReport } from './view.js';
import { GUIDE_OUTPUTS, type GuideWriterHost } from './guides/host-contract.js';
import { guidePageCount } from './guides/prepared.js';
import { guidePrompt } from './prompts.js';

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
  /** Called once an answer or a correction was used by every page it touched and all of them were written. A failure is reported in `loopProblems`. */
  readonly resolved?: (resolved: ResolvedEntity) => Promise<void>;
  /** The clock questions are stamped with; tests inject. */
  readonly clock?: () => Date;
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

/** Writes pages under a folder; a page lands whole or not at all. */
let counter = 0;

export function fsSink(root: string): PageSink {
  return {
    async write(relativePath: string, content: string): Promise<void> {
      const target = path.resolve(root, relativePath);
      if (!target.startsWith(`${path.resolve(root)}${path.sep}`) || relativePath.split(/[\\/]/).some((part) => part === '.' || part === '..') || !/^docs\/(product\.md|domains\/[a-z][a-z0-9-]*\.md|questions\/[a-z][a-z0-9-]*\.md|sources\/[A-Za-z0-9._-]+\/[A-Za-z0-9_-]+\.md)$/.test(relativePath)) {
        throw new Error(`src/writer/run.ts: ${JSON.stringify(relativePath)} is not a page the writer may write`);
      }
      const absoluteRoot = path.resolve(root);
      const rootStat = await lstat(absoluteRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`src/writer/run.ts: ${JSON.stringify(root)} is not a real product directory`);
      const relativeParent = path.relative(absoluteRoot, path.dirname(target));
      let cursor = absoluteRoot;
      for (const part of relativeParent.split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        try {
          const stat = await lstat(cursor);
          if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`src/writer/run.ts: ${JSON.stringify(cursor)} is not a real directory`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await mkdir(cursor);
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
export function declarationOf(path: string, text: string): DomainDeclaration {
  const slug = path.replace(/^.*\//, '').replace(/\.md$/, '');
  const { front, body, bodyLine } = splitFrontMatter(text.replace(/\r\n/g, '\n'));
  let record: Record<string, unknown> = {};
  try {
    const raw: unknown = front === null ? {} : parseYaml(front);
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) record = raw as Record<string, unknown>;
  } catch (error) {
    throw new Error(`src/writer/run.ts: ${path}:2: the front matter of the domain page is no YAML, so the domain cannot be declared again: ${(error as Error).message.split('\n')[0]}`);
  }
  const statements = statementsOf(body, bodyLine);
  const title = typeof record['title'] === 'string' && record['title'].trim() !== '' ? record['title'].trim() : slug;
  const relates = Array.isArray(record['relates']) ? (record['relates'] as unknown[]).filter((entry): entry is string => typeof entry === 'string') : [];
  const evidence = relates.length > 0 ? relates : [...new Set(statements.flatMap((statement) => statement.grounds))];
  return { slug, title, summary: statements[0]?.text ?? title, evidence: [...evidence].sort(byCodePoint) };
}

const entityKey = (kind: string, slug: string): string => `${kind}:${slug}`;

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
  const productUnit: UnitSpec = { kind: 'product', id: `product:${slug}`, path: PRODUCT_PATH, name: options.productName };
  const language = options.language ?? 'en';
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
  const extras = { entityIds: async () => entityIds, output: options.output, language, questions: liveQuestions, ...(options.clock === undefined ? {} : { clock: options.clock }) };
  let existingProduct: string | null = null;
  try { existingProduct = await sink.read(PRODUCT_PATH); } catch { existingProduct = null; }
  const domainPages = await existingDomainPages(options.output);
  const need = (options.needed ?? unitsNeeded)({ productPage: existingProduct, domainPages, languageChanged: options.languageChanged === true });
  const askedIds: string[] = [];
  const keptOutcome = (unit: string, path: string): UnitOutcome => ({ unit, status: 'written', path, writeAttempts: 0, calls: 0, refusals: [], domains: [], grounds: [], links: [], filesRead: [], questions: [], merged: [] });
  const neededDomains = domainPages.filter((page) => need.domain(page));
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
    for (const page of domainPages) out.push(declarationOf(page, await sink.read(page)));
    return out;
  };
  let product: UnitOutcome;
  let declarations: readonly DomainDeclaration[];
  let productPage = '';
  if (need.product) {
    const brief = briefFor(productUnit.id, PRODUCT_PATH, existingProduct);
    expect(productUnit.id, brief);
    options.onUnitStart?.({ unit: productUnit.id, path: productUnit.path });
    const productTools = new UnitTools(view, productUnit, sink, [], bounds, basis, extras);
    const declared = existingProduct === null ? [] : await declaredNow();
    product = await runUnit(options.agent, productTools, await productPrompt(view, productUnit, language, { ...(brief === undefined ? {} : { brief }), questions, declared }));
    options.onUnit?.(product);
    finish(productUnit.id, product);
    declarations = product.domains;
    if (product.status === 'written') {
      try {
        productPage = await sink.read(PRODUCT_PATH);
      } catch (error) {
        throw new Error(`src/writer/run.ts: the product page ${PRODUCT_PATH} was written but cannot be read back for the domain units: ${(error as Error).message}`);
      }
    }
  } else {
    // The product page stays: its domains are the pages it links, as those pages say.
    declarations = await declaredNow();
    product = { ...keptOutcome(productUnit.id, PRODUCT_PATH), domains: [...declarations] };
    options.onUnit?.(product);
    productPage = existingProduct ?? '';
  }
  const domains: UnitOutcome[] = [];
  if (product.status === 'written') {
    for (const declaration of declarations) {
      const path = `${DOMAINS_FOLDER}/${declaration.slug}.md`;
      if (!need.domain(path)) {
        // The page is there and stays: the unit does not run, and it is told as a kept page.
        const kept = keptOutcome(`domain:${declaration.slug}`, path);
        options.onUnit?.(kept);
        domains.push(kept);
        continue;
      }
      const spec: UnitSpec = { kind: 'domain', id: `domain:${declaration.slug}`, path, domain: declaration, productId: productUnit.id };
      const brief = briefFor(spec.id, path, domainPages.includes(path) ? await sink.read(path) : null);
      expect(spec.id, brief);
      options.onUnitStart?.({ unit: spec.id, path: spec.path });
      const tools = new UnitTools(view, spec, sink, declarations, bounds, basis, extras);
      const outcome = await runUnit(options.agent, tools, await domainPrompt(view, spec, productPage, declarations, language, { ...(brief === undefined ? {} : { brief }), questions }));
      options.onUnit?.(outcome);
      finish(spec.id, outcome);
      domains.push(outcome);
    }
  }
  const localizedSources: UnitOutcome[] = [];
  // Every extracted document entity, of the product's own documents and of each code repository's: a Russian wiki over
  // English documents shows each of them in Russian, with its original beside it.
  const localizedEntities = [...(options.documentEntities ?? [])].sort((a, b) => byCodePoint(a.id, b.id));
  for (const entity of localizedEntities) {
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
        localizedSources.push(keptOutcome(`localized-source:${entity.id}`, unitPath));
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
  const guides: UnitOutcome[] = [];
  if (options.guides !== undefined) {
    for (const kind of ['administrator-guide', 'user-guide'] as const) {
      const output = GUIDE_OUTPUTS[kind];
      options.onUnitStart?.({ unit: output.id, path: output.path });
      let outcome: UnitOutcome;
      try {
        const prepared = await options.guides.prepare(kind, language === 'ru' ? 'ru' : 'en');
        const spec: UnitSpec = { kind, id: output.id, path: output.path, prepared };
        const guideBounds = { ...bounds, maxCalls: bounds.maxCalls + guidePageCount(prepared) };
        const tools = new UnitTools(view, spec, sink, [], guideBounds, basis, extras);
        outcome = await runUnit(options.agent, tools, guidePrompt(kind, language === 'ru' ? 'ru' : 'en', prepared.prompt));
        if (outcome.status === 'not-written') outcome = { ...outcome, status: 'failed', refusals: [{ line: 1, rule: 'guide-missing', message: `${path.resolve(options.output, output.path)}:1: $.guide: the unit ended without a verified guide` }] };
      } catch {
        outcome = { ...keptOutcome(output.id, output.path), status: 'failed', refusals: [{ line: 1, rule: 'guide-preparation', message: `${path.resolve(options.output, output.path)}:1: $.guide: the complete pinned guide context could not be prepared; nothing was certified` }] };
      }
      guides.push(outcome);
      options.onUnit?.(outcome);
    }
  }
  if (options.resolved !== undefined) {
    for (const [key, units] of [...expected].sort(([a], [b]) => byCodePoint(a, b))) {
      const written = done.get(key);
      if (written === undefined || written.size !== units.size) continue;
      const [kind, ...rest] = key.split(':');
      try {
        await options.resolved({ kind: kind as 'question' | 'correction', slug: rest.join(':'), pages: [...units].sort(byCodePoint) });
      } catch (error) {
        loopProblems.push(`${key}: it was used but could not be marked resolved: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const stale = (await existingDomainPages(options.output)).filter((page) => !domains.some((d) => d.path === page));
  return { content, product, domains, localizedSources, guides, units: guides.length + (need.product ? 1 : 0) + domains.filter((d) => d.writeAttempts > 0 || d.calls > 0 || d.status !== 'written').length + localizedSources.filter((d) => d.calls > 0 || d.status === 'failed').length, ok: guides.every((unit) => unit.status === 'written') && product.status === 'written' && domains.every((d) => d.status === 'written') && localizedSources.every((outcome) => { if (outcome.status === 'failed') return false; const entity = localizedEntities.find((candidate) => `localized-source:${candidate.id}` === outcome.unit); const sourceLanguage = entity === undefined ? undefined : detectDocumentLanguage(entity.text); return sourceLanguage === undefined || sourceLanguage === language || outcome.status === 'written'; }) && indexErrors.length === 0 && loopProblems.length === 0, stale, indexErrors, loopProblems, questions: askedIds };
}

export type { DomainDeclaration };
