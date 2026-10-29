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
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { selfCommand } from '../product/self-command.js';
import type { Block } from './model.js';
import type { Finding } from './kinds.js';
import { linesOf } from './lines.js';
import { type BlockAnswer, type RenderLimits, type RenderPart, type RenderReply, type RenderRequest, type RenderWorkerProcess } from './render-worker.js';
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
  const findings: Finding[] = [];
  // The folder itself is contained first: a `templates` that is a link out of the product would make every path below a
  // file of somebody else's tree.
  let root: string | undefined;
  try {
    root = realpathSync(join(productFolder, 'templates'));
    const product = realpathSync(productFolder);
    if (root !== join(product, 'templates')) {
      findings.push({ file: 'templates', line: 1, message: `the templates folder is a link to ${root}, outside the product ${product}: no template is read` });
      root = undefined;
    }
  } catch {
    root = undefined;
  }
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
      // A file's own real path is inside the folder: the walk already skips links, and this is the second showing.
      if (stat === undefined || (root !== undefined && !realpathSync(join(productFolder, path)).startsWith(`${root}${sep}`) && realpathSync(join(productFolder, path)) !== root)) {
        findings.push({ file: path, line: 1, message: 'the template is a link or a path outside the templates folder: it is not read' });
        continue;
      }
      found.push({ path, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  };
  if (root !== undefined) walk('templates');
  const stamp = found.map((entry) => `${entry.path}:${entry.mtimeMs}:${entry.size}`).join('|');
  const cached = templateCache.get(productFolder);
  if (cached !== undefined && cached.stamp === stamp) return cached.set;
  const files: Record<string, string> = {};
  let chars = 0;
  if (found.length > RENDER_BOUNDS.templateFiles) {
    findings.push({ file: 'templates', line: 1, message: `the product holds ${found.length} templates and a page reads at most ${RENDER_BOUNDS.templateFiles}: the rest are not read` });
  }
  for (const entry of found.slice(0, RENDER_BOUNDS.templateFiles)) {
    // The caps are read from the sizes the walk took, before a byte is held: a file past them is not opened.
    if (chars + entry.size > RENDER_BOUNDS.templateChars) {
      findings.push({ file: entry.path, line: 1, message: `the templates of the product hold more than ${RENDER_BOUNDS.templateChars} characters: this one and the ones after it are not read` });
      break;
    }
    let text: string;
    try {
      text = readFileSync(join(productFolder, entry.path), 'utf8');
    } catch (error) {
      findings.push({ file: entry.path, line: 1, message: `the template cannot be read: ${(error as Error).message}` });
      continue;
    }
    chars += text.length;
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
  render: (name: string, params: Readonly<Record<string, string>>, file: string, line: number) => Promise<Block>;
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

/**
 * The resident memory of a process, as the machine it runs on says it: `/proc` on
 * Linux, `ps` on macOS, `tasklist` on Windows — the three the release ships for.
 * `undefined` when the machine says nothing, and the wall clock and Liquid's own
 * cooperative limits are then what stands.
 */
export function residentMiB(pid: number | undefined): number | undefined {
  if (pid === undefined) return undefined;
  try {
    const found = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    if (found !== null) return Number(found[1]) / 1024;
  } catch {
    // not Linux, or the process is gone
  }
  const read = (command: string, args: string[]): string | undefined => {
    try {
      const run = spawnSync(command, args, { encoding: 'utf8', timeout: 2_000 });
      return run.status === 0 ? run.stdout : undefined;
    } catch {
      return undefined;
    }
  };
  // macOS: `ps -o rss= -p <pid>` answers the resident set in kilobytes.
  const ps = read('ps', ['-o', 'rss=', '-p', String(pid)]);
  if (ps !== undefined) {
    const kilo = Number.parseInt(ps.trim(), 10);
    if (Number.isFinite(kilo) && kilo > 0) return kilo / 1024;
  }
  // Windows: `tasklist /FI "PID eq <pid>" /FO CSV /NH` answers `"name","pid","session","session#","123 K"`.
  const list = read('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
  if (list !== undefined) {
    const cells = /"([^"]*)"\s*$/.exec(list.trim().split('\n')[0] ?? '');
    const kilo = cells === null ? Number.NaN : Number.parseInt(cells[1]!.replace(/[^0-9]/g, ''), 10);
    if (Number.isFinite(kilo) && kilo > 0) return kilo / 1024;
  }
  return undefined;
}

/** A render stopped past a bound, rather than answered by the templates. */
type Stop = { stopped: 'time' | 'memory' | 'exit'; detail: string };

/** What a race answers when the bound was passed while a line or a block read was waited for. */
const STOPPED = Symbol('stopped');

const isStop = (value: RenderReply | Stop): value is Stop => 'stopped' in value;

/**
 * One worker and the lines it answers. A worker that ends is replaced, and every
 * worker has a connection of its own: the reader of a worker that was killed keeps
 * reading its own stream to its end, and a leftover line of it must never reach the
 * page the next worker draws (measured: a stale `ready` was answered to a render, and
 * a killed worker's end was read as the new one's).
 */
interface Connection {
  worker: RenderWorkerProcess;
  lines: string[];
  ended: boolean;
  wake?: () => void;
}

interface Slot {
  connection?: Connection;
  digest?: string;
  /** One render at a time: a worker holds one page in its registers. */
  busy: boolean;
  waiting: (() => void)[];
  idle?: ReturnType<typeof setTimeout>;
}

const slots = new Map<string, Slot>();

function slotOf(productFolder: string): Slot {
  const held = slots.get(productFolder);
  if (held !== undefined) return held;
  const slot: Slot = { busy: false, waiting: [] };
  slots.set(productFolder, slot);
  return slot;
}

/** Starts a worker with a connection and a reader of its own. */
function startWorker(slot: Slot): Connection {
  slot.connection?.worker.kill();
  const worker = renderWorkers.factory();
  const connection: Connection = { worker, lines: [], ended: false };
  slot.connection = connection;
  slot.digest = undefined;
  void (async () => {
    for await (const line of worker.lines) {
      connection.lines.push(line);
      connection.wake?.();
    }
    connection.ended = true;
    connection.wake?.();
  })();
  return connection;
}

/** Ends the worker of a product and forgets its connection: what its reader still holds reaches no page. */
function stopWorker(slot: Slot): void {
  slot.connection?.worker.kill();
  slot.connection = undefined;
  slot.digest = undefined;
}

/** The next line the worker answers, or `undefined` when it has ended. */
async function nextLine(connection: Connection): Promise<string | undefined> {
  while (connection.lines.length === 0) {
    if (connection.ended) return undefined;
    await new Promise<void>((resume) => { connection.wake = resume; });
    connection.wake = undefined;
  }
  return connection.lines.shift();
}

/**
 * Starts the worker of a product before a page needs it, and hands it the templates: the first page a reader opens pays a
 * round trip instead of a process's start. A worker that cannot start is no page's problem yet; the page that needs it
 * says why.
 */
export function warmRenderWorker(productFolder: string): void {
  const slot = slotOf(productFolder);
  if (slot.connection !== undefined || slot.busy) return;
  try {
    startWorker(slot);
    const set = templateSetOf(productFolder);
    void open(slot, set, RENDER_LIMITS, { wallClockMs: RENDER_BOUNDS.wallClockMs, memoryMiB: RENDER_BOUNDS.memoryMiB }).catch(() => undefined);
  } catch {
    // the page that needs a worker starts one and says what went wrong
  }
}

/** Ends the worker of one product: a product that closes gives back what it holds. */
export function closeRenderWorker(productFolder: string): void {
  const slot = slots.get(productFolder);
  if (slot === undefined) return;
  stopWorker(slot);
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
  const connection = slot.connection;
  if (connection === undefined) return { stopped: 'exit', detail: 'the worker was not started' };
  const worker = connection.worker;
  worker.write(encodeWire(request));
  let stop: Stop | undefined;
  const clock = setTimeout(() => {
    stop = { stopped: 'time', detail: `the template did not finish in ${options.wallClockMs} ms` };
    worker.kill();
    bounded?.();
  }, options.wallClockMs);
  const memory = setInterval(() => {
    const held = residentMiB(worker.pid);
    if (held !== undefined && held > options.memoryMiB) {
      stop = { stopped: 'memory', detail: `the template held ${Math.round(held)} MiB and a page may hold ${options.memoryMiB}` };
      worker.kill();
      bounded?.();
    }
  }, 100);
  // A bound that is passed ends the exchange there and then: a block read that stalls must not hold the page's turn.
  let bounded: (() => void) | undefined;
  const bound = new Promise<'stopped'>((resolve) => { bounded = () => resolve('stopped'); });
  try {
    for (;;) {
      const line = await Promise.race([nextLine(connection), bound.then((held) => held === 'stopped' ? STOPPED : undefined)]);
      if (line === STOPPED) return stop ?? { stopped: 'exit', detail: 'the render was stopped past a bound' };
      if (line === undefined) return stop ?? { stopped: 'exit', detail: `the worker ended: ${worker.stderr().trim() || 'no message on its error stream'}` };
      const reply = decodeWire<RenderReply | BlockAnswer>(line);
      if (reply.type === 'block') {
        if (options.answer === undefined) return { stopped: 'exit', detail: 'a block was asked for with no page being drawn' };
        const answered = await Promise.race([options.answer(reply), bound.then((held) => held === 'stopped' ? STOPPED : undefined)]);
        if (answered === STOPPED) return stop ?? { stopped: 'exit', detail: 'the render was stopped past a bound' };
        worker.write(encodeWire(answered));
        continue;
      }
      if (reply.type === 'blocked') continue;
      return reply;
    }
  } finally {
    clearTimeout(clock);
    clearInterval(memory);
    // A worker that was killed, or that ended, is a worker the next page starts again: its connection goes with it.
    if ((stop !== undefined || connection.ended) && slot.connection === connection) stopWorker(slot);
  }
}

/** Hands the templates to the worker when it holds another set; answers why not when it does not take them. */
async function open(slot: Slot, set: TemplateSet, limits: RenderLimits, bounds: { wallClockMs: number; memoryMiB: number }): Promise<string | undefined> {
  if (slot.connection === undefined || slot.connection.ended) {
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
    return { blocks: assemble(reply.parts, answered, input.only), findings };
  } finally {
    release(slot);
    if (slot.connection !== undefined && slot.waiting.length === 0) {
      // A worker nothing asks for for ten seconds is ended: a machine serving many products holds only the busy ones.
      slot.idle = setTimeout(() => {
        if (slot.busy) return;
        stopWorker(slot);
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
    const block = { ...(await input.render(request.name, params, request.file === '' ? input.template : request.file, request.line)), name: request.name };
    const size = JSON.stringify(block).length;
    if (size > RENDER_BOUNDS.blockChars) return { type: 'blocked', seq: request.seq, message: `the block ${request.name} of this page is ${size} characters and a page reads at most ${RENDER_BOUNDS.blockChars}` };
    answered.set(request.seq, block);
    return { type: 'blocked', seq: request.seq, block };
  } catch (error) {
    return { type: 'blocked', seq: request.seq, message: `the block ${request.name} could not be read: ${(error as Error).message}` };
  }
}

/**
 * The page as the worker answered it: its own text and the places its blocks
 * stand, put back in order. A text of nothing but space is no block; a block the
 * server did not answer (the other blocks of a template when one was asked for by
 * its identity) leaves nothing.
 */
function assemble(parts: readonly RenderPart[], answered: ReadonlyMap<number, Block>, only?: string): Block[] {
  const blocks: Block[] = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      if (only === undefined && part.trim() !== '') blocks.push({ type: 'markdown', markdown: part });
      continue;
    }
    const block = answered.get(part.block);
    if (block !== undefined) blocks.push(block);
  }
  return blocks;
}
