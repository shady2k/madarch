/**
 * Liquid templates (madarch-u3vw.1, decision 0032 section 8). A product's page
 * templates are Liquid: a base template per entity (`{% layout %}` with
 * `{% block %}`), kind templates that extend it, partials (`{% render %}`) and
 * conditions. The engine's blocks are tags — `{% related title="Files"
 * relation="code.contains" %}` — answered by the block library.
 *
 * What this module holds is the parent's half of a bounded render:
 *
 * - the template set: every `.liquid` file under the product's `templates`
 *   folder, read here and nowhere else, so a template can name no path outside
 *   it, and capped in number and size;
 * - a worker of its own per product (`render-worker.ts`), which evaluates the
 *   templates; a page is given a wall clock and the worker a memory bound, and
 *   the worker is killed past either (Liquid's own limits are cooperative: they
 *   stop a loop that checks, not one that does not);
 * - the blocks: a block is read where the graph and the Markdown are, and the
 *   answer travels back over the pipe. The page's text carries a token where
 *   each block stands, and the blocks are put back in that order.
 *
 * A template's diagnostics keep the file and the line Liquid names for them. A
 * block is known by its name and its parameters, never by the line it stands
 * on, so editing a template above a block does not change what a reader asks
 * for when the page draws that block later.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { selfCommand } from '../product/self-command.js';
import type { Block } from './model.js';
import type { Finding } from './kinds.js';
import { linesOf } from './lines.js';
import { splitBlocks, type BlockAnswer, type RenderLimits, type RenderReply, type RenderRequest, type RenderWorkerProcess } from './render-worker.js';
import { BLOCK_NAMES, blockIdentity } from './template.js';
import { decodeWire, encodeWire } from './wire.js';

/** The bounds a page's template runs under, counted by Liquid; a test names its own to see one fire. */
export const RENDER_LIMITS: RenderLimits = {
  templateLimit: 200_000,
  renderLimit: 8_000,
  memoryLimit: 200_000_000,
  parseLimit: 10_000_000,
  blocks: 64,
  outputChars: 4 << 20,
};

/** The bounds the server enforces itself: the wall clock of a page, the memory its worker may hold, the sizes of a set. */
export const RENDER_BOUNDS = {
  wallClockMs: 15_000,
  memoryMiB: 512,
  templateFiles: 200,
  templateChars: 1 << 20,
  blockChars: 8 << 20,
} as const;

/** The template files a product holds: its whole `templates` folder, and no other path. */
export interface TemplateSet {
  files: Readonly<Record<string, string>>;
  /** Changes when a template's text, size or place does: a worker is given the set again when it does. */
  digest: string;
  findings: Finding[];
}

const templateCache = new Map<string, { stamp: string; set: TemplateSet }>();

/**
 * Reads the templates of a product: every regular `.liquid` file under
 * `templates`, as `/`-separated paths from the product's root. A link is not
 * read, since it may point anywhere, and a set past the caps is refused with a
 * finding, so a product cannot make the wiki hold a template it could not have
 * written. The set is cached until one of the files changes.
 */
export function templateSetOf(productFolder: string): TemplateSet {
  const found: { path: string; mtimeMs: number; size: number }[] = [];
  const walk = (folder: string): void => {
    let entries;
    try {
      entries = readdirSync(join(productFolder, folder), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${folder}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.liquid')) continue;
      const stat = statSync(join(productFolder, path), { throwIfNoEntry: false });
      if (stat !== undefined) found.push({ path, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  };
  walk('templates');
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const stamp = found.map((entry) => `${entry.path}:${entry.mtimeMs}:${entry.size}`).join('|');
  const cached = templateCache.get(productFolder);
  if (cached !== undefined && cached.stamp === stamp) return cached.set;
  const findings: Finding[] = [];
  const files: Record<string, string> = {};
  let chars = 0;
  if (found.length > RENDER_BOUNDS.templateFiles) {
    findings.push({ file: 'templates', line: 1, message: `the product holds ${found.length} templates and a page reads at most ${RENDER_BOUNDS.templateFiles}: the rest are not read` });
  }
  for (const entry of found.slice(0, RENDER_BOUNDS.templateFiles)) {
    let text: string;
    try {
      text = readFileSync(join(productFolder, entry.path), 'utf8');
    } catch (error) {
      findings.push({ file: entry.path, line: 1, message: `the template cannot be read: ${(error as Error).message}` });
      continue;
    }
    chars += text.length;
    if (chars > RENDER_BOUNDS.templateChars) {
      findings.push({ file: entry.path, line: 1, message: `the templates of the product hold more than ${RENDER_BOUNDS.templateChars} characters: this one and the ones after it are not read` });
      break;
    }
    files[entry.path] = text;
  }
  const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  const set: TemplateSet = { files, digest, findings };
  templateCache.set(productFolder, { stamp, set });
  return set;
}

/** One page drawn from its templates: the kind's template, the page's attributes, and where its blocks are read. */
export interface LiquidPageInput {
  productFolder: string;
  /** The kind's template, product relative: `templates/service.liquid`. */
  template: string;
  /** The page's attributes, read as `{{ label }}` and as `{{ page.label }}`. */
  data: Readonly<Record<string, unknown>>;
  /** The interface language: a block parameter `title-<lang>` names the block in it. */
  lang?: string;
  /** Whether the blocks that read the graph at length are left to a read of their own. */
  defer: boolean;
  /** The blocks left to a read of their own when `defer`; every block but this one when `only` is named. */
  deferred: readonly string[];
  /** One block, by its identity: the block a reader opened later asks for. */
  only?: string;
  /** Reads one block, where the graph and the Markdown are. */
  render: (name: string, params: Readonly<Record<string, string>>, line: number) => Promise<Block>;
  limits?: RenderLimits;
  bounds?: { wallClockMs: number; memoryMiB: number };
}

/** What the templates answered: the page's blocks in the order they stand, and what the templates got wrong. */
export interface LiquidPageOutcome {
  blocks: Block[];
  findings: Finding[];
  /** A refusal no template line belongs to: the template is not in the product's set, or the worker could not answer. */
  refused?: string;
}

// ---- the worker ---------------------------------------------------------------------------------

export function spawnRenderWorker(): RenderWorkerProcess {
  const { command, args } = selfCommand(['knowledge-render-worker']);
  const child = Bun.spawn([command, ...args], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: process.env });
  let tail = '';
  void (async () => {
    for await (const chunk of child.stderr as unknown as AsyncIterable<Uint8Array>) tail = (tail + new TextDecoder().decode(chunk)).slice(-2000);
  })();
  return {
    pid: child.pid,
    write: (line: string) => {
      try {
        child.stdin.write(`${line}\n`);
        void child.stdin.flush();
      } catch {
        // the worker is gone; its exit ends what waits
      }
    },
    lines: linesOf(child.stdout as unknown as AsyncIterable<Uint8Array>),
    exited: child.exited,
    stderr: () => tail,
    kill: () => {
      try { child.kill(); } catch { /* already gone */ }
    },
  };
}

/** How a worker is started: the production one starts a process of its own; a test names its own. */
export const renderWorkers: { factory: () => RenderWorkerProcess } = { factory: spawnRenderWorker };

/** The resident memory of a process, when this machine says it; `undefined` where it does not (Linux only). */
function residentMiB(pid: number | undefined): number | undefined {
  if (pid === undefined) return undefined;
  try {
    const found = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return found === null ? undefined : Number(found[1]) / 1024;
  } catch {
    return undefined;
  }
}

/** A render stopped past a bound, rather than answered by the templates. */
type Stop = { stopped: 'time' | 'memory' | 'exit'; detail: string };

const isStop = (value: RenderReply | Stop): value is Stop => 'stopped' in value;

/**
 * One product's worker and the lines it answers. The lines are read once, by a
 * reader of their own: an iterator that a render breaks out of would close the
 * stream, and the next page of the product would have no worker to ask.
 */
interface Slot {
  worker?: RenderWorkerProcess;
  digest?: string;
  /** One render at a time: a worker holds one page in its registers. */
  busy: boolean;
  waiting: (() => void)[];
  idle?: ReturnType<typeof setTimeout>;
  lines: string[];
  ended: boolean;
  wake?: () => void;
}

const slots = new Map<string, Slot>();

function slotOf(productFolder: string): Slot {
  const held = slots.get(productFolder);
  if (held !== undefined) return held;
  const slot: Slot = { busy: false, waiting: [], lines: [], ended: true };
  slots.set(productFolder, slot);
  return slot;
}

/** Starts the worker and its reader; a worker that was killed is replaced, with a reader of its own. */
function startWorker(slot: Slot): RenderWorkerProcess {
  slot.worker?.kill();
  const worker = renderWorkers.factory();
  slot.worker = worker;
  slot.digest = undefined;
  slot.lines = [];
  slot.ended = false;
  void (async () => {
    for await (const line of worker.lines) {
      slot.lines.push(line);
      slot.wake?.();
    }
    slot.ended = true;
    slot.wake?.();
  })();
  return worker;
}

/** The next line the worker answers, or `undefined` when it has ended. */
async function nextLine(slot: Slot): Promise<string | undefined> {
  while (slot.lines.length === 0) {
    if (slot.ended) return undefined;
    await new Promise<void>((resume) => { slot.wake = resume; });
    slot.wake = undefined;
  }
  return slot.lines.shift();
}

/** Ends the worker of one product: a product that closes gives back what it holds. */
export function closeRenderWorker(productFolder: string): void {
  const slot = slots.get(productFolder);
  if (slot === undefined) return;
  slot.worker?.kill();
  if (slot.idle !== undefined) clearTimeout(slot.idle);
  slots.delete(productFolder);
}

/** Ends every worker: a products home that closes, and a test that is over. */
export function closeRenderWorkers(): void {
  for (const folder of [...slots.keys()]) closeRenderWorker(folder);
}

async function turn(slot: Slot): Promise<void> {
  if (!slot.busy) { slot.busy = true; return; }
  await new Promise<void>((resume) => slot.waiting.push(resume));
}

function release(slot: Slot): void {
  const next = slot.waiting.shift();
  if (next === undefined) slot.busy = false;
  else next();
}

/** Sends one request and reads its answers, the block ones included, until the render is over or a bound is passed. */
async function exchange(
  slot: Slot,
  request: RenderRequest,
  options: { wallClockMs: number; memoryMiB: number; answer?: (request: Extract<RenderReply, { type: 'block' }>) => Promise<BlockAnswer> },
): Promise<RenderReply | Stop> {
  const worker = slot.worker;
  if (worker === undefined) return { stopped: 'exit', detail: 'the worker was not started' };
  worker.write(encodeWire(request));
  let stop: Stop | undefined;
  const clock = setTimeout(() => {
    stop = { stopped: 'time', detail: `the template did not finish in ${options.wallClockMs} ms` };
    worker.kill();
  }, options.wallClockMs);
  const memory = setInterval(() => {
    const held = residentMiB(worker.pid);
    if (held !== undefined && held > options.memoryMiB) {
      stop = { stopped: 'memory', detail: `the template held ${Math.round(held)} MiB and a page may hold ${options.memoryMiB}` };
      worker.kill();
    }
  }, 100);
  try {
    for (;;) {
      const line = await nextLine(slot);
      if (line === undefined) return stop ?? { stopped: 'exit', detail: `the worker ended: ${worker.stderr().trim() || 'no message on its error stream'}` };
      const reply = decodeWire<RenderReply | BlockAnswer>(line);
      if (reply.type === 'block') {
        if (options.answer === undefined) return { stopped: 'exit', detail: 'a block was asked for with no page being drawn' };
        worker.write(encodeWire(await options.answer(reply)));
        continue;
      }
      if (reply.type === 'blocked') continue;
      return reply;
    }
  } finally {
    clearTimeout(clock);
    clearInterval(memory);
    // A worker that was killed is a worker the next page starts again.
    if (stop !== undefined || slot.ended) {
      slot.worker = undefined;
      slot.digest = undefined;
    }
  }
}

/** Hands the templates to the worker when it holds another set; answers why not when it does not take them. */
async function open(slot: Slot, set: TemplateSet, limits: RenderLimits, bounds: { wallClockMs: number; memoryMiB: number }): Promise<string | undefined> {
  if (slot.worker === undefined || slot.ended) {
    startWorker(slot);
    if (slot.idle !== undefined) { clearTimeout(slot.idle); slot.idle = undefined; }
  }
  if (slot.digest === set.digest) return undefined;
  const reply = await exchange(slot, { type: 'open', templates: set.files, blocks: BLOCK_NAMES, limits }, bounds);
  if (isStop(reply)) return reply.detail;
  if (reply.type === 'refused') return reply.message;
  if (reply.type !== 'ready') return `the worker answered ${reply.type} where its ready was asked for`;
  slot.digest = set.digest;
  return undefined;
}

/**
 * Draws one page's templates: the set of the product, the worker of the product, and one render under the bounds.
 * Nothing of a template escapes: a page that fails answers one problem block with the template's file and line.
 */
export async function renderLiquidPage(input: LiquidPageInput): Promise<LiquidPageOutcome> {
  const set = templateSetOf(input.productFolder);
  const findings: Finding[] = [...set.findings];
  if (!(input.template in set.files)) {
    return { blocks: [], findings, refused: `the template ${input.template} is not among the templates of the product: a kind's template is a .liquid file under templates` };
  }
  const limits = input.limits ?? RENDER_LIMITS;
  const bounds = {
    wallClockMs: input.bounds?.wallClockMs ?? RENDER_BOUNDS.wallClockMs,
    memoryMiB: input.bounds?.memoryMiB ?? RENDER_BOUNDS.memoryMiB,
  };
  const slot = slotOf(input.productFolder);
  await turn(slot);
  try {
    const notOpened = await open(slot, set, limits, bounds);
    if (notOpened !== undefined) {
      findings.push({ file: input.template, line: 1, message: `the templates could not be opened: ${notOpened}` });
      return { blocks: [{ type: 'problem', block: input.template, file: input.template, line: 1, message: `the templates could not be opened: ${notOpened}` }], findings };
    }
    const answered = new Map<number, Block>();
    const reply = await exchange(slot, { type: 'render', id: 1, template: input.template, data: input.data }, {
      ...bounds,
      answer: (request) => answerBlock(input, request, answered),
    });
    if (isStop(reply)) {
      findings.push({ file: input.template, line: 1, message: reply.detail });
      return { blocks: [{ type: 'problem', block: input.template, file: input.template, line: 1, message: reply.detail }], findings };
    }
    if (reply.type === 'refused') {
      findings.push({ file: input.template, line: 1, message: reply.message });
      return { blocks: [{ type: 'problem', block: input.template, file: input.template, line: 1, message: reply.message }], findings };
    }
    if (reply.type === 'failed') {
      const file = reply.file ?? input.template;
      const line = reply.line ?? 1;
      findings.push({ file, line, message: reply.message });
      return { blocks: [{ type: 'problem', block: input.template, file, line, message: reply.message }], findings };
    }
    if (reply.type !== 'rendered') {
      return { blocks: [], findings, refused: `the worker answered a message no page asked for: ${reply.type}` };
    }
    return { blocks: assemble(reply.text, answered, input.only), findings };
  } finally {
    release(slot);
    if (slot.worker !== undefined && slot.waiting.length === 0) {
      // A worker nothing asks for for ten seconds is ended: a machine serving many products holds only the busy ones.
      slot.idle = setTimeout(() => {
        if (slot.busy) return;
        slot.worker?.kill();
        slot.worker = undefined;
        slot.digest = undefined;
      }, 10_000);
      slot.idle.unref?.();
    }
  }
}

/**
 * One block of the page: its parameters as the templates wrote them, and the
 * language's own title folded into `title`. A block the page leaves to a read of
 * its own, and every block but the one asked for by `only`, answer as deferred:
 * the page says where they stand and the reader's own read draws them.
 */
async function answerBlock(input: LiquidPageInput, request: Extract<RenderReply, { type: 'block' }>, answered: Map<number, Block>): Promise<BlockAnswer> {
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.params)) {
    if (!name.startsWith('title-')) params[name] = value;
    else if (input.lang !== undefined && name === `title-${input.lang}`) params['title'] = value;
  }
  const id = blockIdentity(request.name, params);
  // One block asked for by its identity is the page a reader's own read draws: the other blocks of the template are
  // where they would stand and are not part of the answer.
  if (input.only !== undefined && id !== input.only && request.purpose === 'tag') {
    return { type: 'blocked', seq: request.seq, block: { type: 'deferred', block: request.name, title: params['title'] ?? '', id } };
  }
  const later = input.only === undefined && input.defer && input.deferred.includes(request.name);
  if (later && request.purpose === 'tag') {
    const block: Block = { type: 'deferred', block: request.name, title: params['title'] ?? '', id, name: request.name };
    answered.set(request.seq, block);
    return { type: 'blocked', seq: request.seq, block };
  }
  try {
    const block = { ...(await input.render(request.name, params, request.line)), name: request.name };
    const size = JSON.stringify(block).length;
    if (size > RENDER_BOUNDS.blockChars) return { type: 'blocked', seq: request.seq, message: `the block ${request.name} of this page is ${size} characters and a page reads at most ${RENDER_BOUNDS.blockChars}` };
    answered.set(request.seq, block);
    return { type: 'blocked', seq: request.seq, block };
  } catch (error) {
    return { type: 'blocked', seq: request.seq, message: `the block ${request.name} could not be read: ${(error as Error).message}` };
  }
}

/**
 * The page's text with its blocks put back where their tokens stand; a text of
 * nothing but space is no block. A token whose block was not answered (the other
 * blocks of a template when one was asked for by its identity) leaves nothing.
 */
function assemble(text: string, answered: ReadonlyMap<number, Block>, only?: string): Block[] {
  const blocks: Block[] = [];
  for (const part of splitBlocks(text)) {
    if (typeof part === 'number') {
      const block = answered.get(part);
      if (block !== undefined) blocks.push(block);
      continue;
    }
    if (only === undefined && part.trim() !== '') blocks.push({ type: 'markdown', markdown: part });
  }
  return blocks;
}
