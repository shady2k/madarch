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
import { createTemplateEngine, type BlockRequest, type RenderLimits, type RenderPart, type TemplateEngine } from './liquid-engine.js';
import { type RenderReply, type RenderRequest, type RenderWorkerProcess } from './render-worker.js';
import { TEMPLATES as STARTER_TEMPLATES } from './seed.js';
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

/**
 * The hashes of the templates the starter set ships, by their content: a template byte-identical to one of them is the
 * engine's own, written by nobody, and a page drawn from such templates is drawn by the server itself. A person's
 * template — edited, or written from nothing — matches none of them and is drawn in the worker.
 */
const STARTER_TEMPLATE_HASHES: ReadonlySet<string> = new Set(Object.values(STARTER_TEMPLATES).map((text) => createHash('sha256').update(text).digest('hex')));

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
  /** Which way the page was drawn: by the server itself (the starter set's own templates), or by a worker of its own. */
  renderedIn?: 'inline' | 'worker';
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
  /** The opening of the templates under way: a page that comes while it runs waits for it instead of opening again. */
  opening?: Promise<string | undefined>;
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
  options: { wallClockMs: number; memoryMiB: number },
): Promise<RenderReply | Stop> {
  const connection = slot.connection;
  if (connection === undefined) return { stopped: 'exit', detail: 'the worker was not started' };
  const worker = connection.worker;
  worker.write(encodeWire(request));
  let stop: Stop | undefined;
  let bounded: (() => void) | undefined;
  const bound = new Promise<typeof STOPPED>((resolve) => { bounded = () => resolve(STOPPED); });
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
  try {
    for (;;) {
      const line = await Promise.race([nextLine(connection), bound]);
      if (line === STOPPED) return stop ?? { stopped: 'exit', detail: 'the render was stopped past a bound' };
      if (line === undefined) return stop ?? { stopped: 'exit', detail: `the worker ended: ${worker.stderr().trim() || 'no message on its error stream'}` };
      const reply = decodeWire<RenderReply>(line);
      // Nothing else is answered mid-render: a page's blocks are read by the server in one go after it is rendered.
      return reply;
    }
  } finally {
    clearTimeout(clock);
    clearInterval(memory);
    if ((stop !== undefined || connection.ended) && slot.connection === connection) stopWorker(slot);
  }
}

/** Hands the templates to the worker when it holds another set; answers why not when it does not take them. */
async function open(slot: Slot, set: TemplateSet, limits: RenderLimits, bounds: { wallClockMs: number; memoryMiB: number }): Promise<string | undefined> {
  if (slot.opening !== undefined) return await slot.opening;
  if (slot.connection === undefined || slot.connection.ended) {
    startWorker(slot);
    if (slot.idle !== undefined) { clearTimeout(slot.idle); slot.idle = undefined; }
  }
  if (slot.digest === set.digest) return undefined;
  // One opening at a time: a page that comes while the product's warm-up opens waits for it, and two `ready` answers can
  // never cross a render.
  const opening = (async (): Promise<string | undefined> => {
    const reply = await exchange(slot, { type: 'open', templates: set.files, blocks: BLOCK_NAMES, limits }, bounds);
    if (isStop(reply)) return reply.detail;
    if (reply.type === 'refused') return reply.message;
    if (reply.type !== 'ready') return `the worker answered ${reply.type} where its ready was asked for`;
    slot.digest = set.digest;
    return undefined;
  })();
  slot.opening = opening;
  try {
    return await opening;
  } finally {
    slot.opening = undefined;
  }
}

/**
 * Draws one page's templates. A page whose every template is byte-identical to one the starter set ships is drawn by the
 * server itself — nobody wrote it, and the engine's own cooperative limits bound it. A page that reaches a template a
 * person wrote or edited is drawn in a process of the product's own, which the server kills past a wall clock and a
 * memory bound. Either way the page's blocks are read in one go after it is rendered — one hop, not one per block — and
 * a page that tested a block's own data is rendered once more with that data in hand.
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
  const read = new Map<string, Block>();
  // A set of the engine's own templates goes to the server's own engine; one file a person wrote sends the page to the
  // worker (a layout or a partial a person edited is reached by every page that renders it).
  const inline = engineOwnSet(set);
  if (inline) {
    const drawn = await renderInline(input, set, limits, read, findings);
    return { ...drawn, renderedIn: 'inline' };
  }
  const slot = slotOf(input.productFolder);
  await turn(slot);
  try {
    const notOpened = await open(slot, set, limits, bounds);
    if (notOpened !== undefined) {
      findings.push({ file: input.template, line: 1, message: `the templates could not be opened: ${notOpened}` });
      return { blocks: [{ type: 'problem', block: input.template, file: input.template, line: 1, message: `the templates could not be opened: ${notOpened}` }], findings, renderedIn: 'worker' };
    }
    const draw = (data: Readonly<Record<string, unknown>>): Promise<RenderReply | Stop | undefined> => exchange(slot, { type: 'render', id: 1, template: input.template, data }, bounds);
    let reply = await draw(input.data);
    if (reply !== undefined && !isStop(reply) && reply.type === 'rendered' && reply.dataMisses.length > 0) {
      // The page tested a block's own data: read those blocks, then render once more with the data in hand.
      const data: Record<string, unknown> = { ...input.data };
      for (const name of reply.dataMisses) data[name] = await readBlock(input, { name, params: {}, file: input.template, line: 1 }, read);
      reply = await draw(data);
    }
    return { ...(await outcomeOf(input, reply, read, findings)), renderedIn: 'worker' };
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

/** Whether every template of the set is one the starter set ships, byte for byte: nothing of it was written by a person. */
function engineOwnSet(set: TemplateSet): boolean {
  const files = Object.values(set.files);
  return files.length > 0 && files.every((text) => STARTER_TEMPLATE_HASHES.has(createHash('sha256').update(text).digest('hex')));
}

/** The page drawn by the server's own engine: the blocks read here, and no process to kill. */
async function renderInline(input: LiquidPageInput, set: TemplateSet, limits: RenderLimits, read: Map<string, Block>, findings: Finding[]): Promise<LiquidPageOutcome> {
  const engine: TemplateEngine = createTemplateEngine({ templates: set.files, blocks: BLOCK_NAMES, limits });
  const drawn = async (data: Readonly<Record<string, unknown>>) => {
    try {
      return { ok: true as const, answered: await engine.render(input.template, data) };
    } catch (error) {
      const held = error as { message?: string; file?: string; line?: number };
      return { ok: false as const, message: held.message ?? String(error), file: held.file ?? input.template, line: held.line ?? 1 };
    }
  };
  let reply = await drawn(input.data);
  if (reply.ok && reply.answered.dataMisses.length > 0) {
    const data: Record<string, unknown> = { ...input.data };
    for (const name of reply.answered.dataMisses) data[name] = await readBlock(input, { name, params: {}, file: input.template, line: 1 }, read);
    reply = await drawn(data);
  }
  if (!reply.ok) {
    findings.push({ file: reply.file, line: reply.line, message: reply.message });
    return { blocks: [{ type: 'problem', block: input.template, file: reply.file, line: reply.line, message: reply.message }], findings };
  }
  const blocks = await Promise.all(reply.answered.requests.map((request) => readBlock(input, request, read)));
  return { blocks: assemble(reply.answered.parts, blocks, input.only), findings };
}

/** What the templates answered: the page's blocks read and put in the order they stand, and what the templates got wrong. */
async function outcomeOf(input: LiquidPageInput, reply: RenderReply | Stop | undefined, read: Map<string, Block>, findings: Finding[]): Promise<LiquidPageOutcome> {
  if (reply === undefined) return { blocks: [], findings, refused: 'the worker answered nothing for this page' };
  const problem = (file: string, line: number, message: string): LiquidPageOutcome => {
    findings.push({ file, line, message });
    return { blocks: [{ type: 'problem', block: input.template, file, line, message }], findings };
  };
  if (isStop(reply)) return problem(input.template, 1, reply.detail);
  if (reply.type === 'refused') return problem(input.template, 1, reply.message);
  if (reply.type === 'failed') return problem(reply.file ?? input.template, reply.line ?? 1, reply.message);
  if (reply.type !== 'rendered') return { blocks: [], findings, refused: `the worker answered a message no page asked for: ${reply.type}` };
  // The page's blocks are read together, then put where their places stand; a read that never answers is refused by the
  // page's own wall clock, so a block can neither hold the render nor the page.
  const wallClockMs = input.bounds?.wallClockMs ?? RENDER_BOUNDS.wallClockMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const blocks = await Promise.race([
    Promise.all(reply.requests.map((request) => readBlock(input, request, read))),
    new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), wallClockMs); }),
  ]).finally(() => clearTimeout(timer));
  if (blocks === undefined) return problem(input.template, 1, `the page's blocks did not answer within ${wallClockMs} ms`);
  return { blocks: assemble(reply.parts, blocks, input.only), findings };
}

/**
 * One block of the page: its parameters as the templates wrote them, and the
 * language's own title folded into `title`. A block the page leaves to a read of
 * its own, and every block but the one asked for by `only`, answer as deferred:
 * the page says where they stand and the reader's own read draws them. A block is
 * read once however many times the page is rendered.
 */
async function readBlock(input: LiquidPageInput, request: BlockRequest, read: Map<string, Block>): Promise<Block> {
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.params)) {
    if (!name.startsWith('title-')) params[name] = value;
    else if (input.lang !== undefined && name === `title-${input.lang}`) params['title'] = value;
  }
  const id = blockIdentity(request.name, params);
  const key = `${request.name}|${JSON.stringify(Object.entries(params).sort())}`;
  const held = read.get(key);
  if (held !== undefined) return held;
  const deferred = { type: 'deferred', block: request.name, id, name: request.name, title: params['title'] ?? '' } as Block;
  if (input.only !== undefined && id !== input.only) return deferred;
  if (input.only === undefined && input.defer && input.deferred.includes(request.name)) {
    read.set(key, deferred);
    return deferred;
  }
  let block: Block;
  try {
    block = { ...(await input.render(request.name, params, request.file === '' ? input.template : request.file, request.line)), name: request.name };
  } catch (error) {
    block = { type: 'problem', block: request.name, file: request.file === '' ? input.template : request.file, line: request.line, message: `the block ${request.name} could not be read: ${(error as Error).message}` };
  }
  const size = JSON.stringify(block).length;
  if (size > RENDER_BOUNDS.blockChars) {
    return { type: 'problem', block: request.name, file: request.file === '' ? input.template : request.file, line: request.line, message: `the block ${request.name} of this page is ${size} characters and a page reads at most ${RENDER_BOUNDS.blockChars}` };
  }
  read.set(key, block);
  return block;
}

/**
 * The page as the worker answered it: its own text and the places its blocks
 * stand, put back in order. A text of nothing but space is no block; a block the
 * server did not read (the other blocks of a template when one was asked for by
 * its identity) leaves nothing.
 */
function assemble(parts: readonly RenderPart[], blocks: readonly Block[], only?: string): Block[] {
  const out: Block[] = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      if (only === undefined && part.trim() !== '') out.push({ type: 'markdown', markdown: part });
      continue;
    }
    const block = blocks[part.block];
    // With one block asked for by its identity, the other places of the template stand for nothing: the page is the block.
    if (block !== undefined && !(only !== undefined && block.type === 'deferred')) out.push(block);
  }
  return out;
}
