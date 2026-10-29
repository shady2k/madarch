/**
 * The render worker (madarch-u3vw.1, decision 0032 section 8): `madarch
 * knowledge-render-worker`. Product templates are Liquid, and Liquid's own
 * limits are cooperative: a template that loops forever or draws a gigabyte
 * stops only if every step checks. So a page's template is evaluated here, in a
 * process of its own, which the server can kill by wall clock and by the memory
 * it holds; the blocks it dispatches are read by the server and sent back over
 * the pipe, because only the server holds the graph.
 *
 * Messages are lines of JSON (`wire.ts`) on standard input and output, as the
 * read and fill workers say theirs.
 */
import { Hash, Liquid, Tag, filters, type Context, type Emitter, type TopLevelToken, type TagToken } from 'liquidjs';
import { escapeMarkdown } from './template.js';
import { decodeWire, encodeWire } from './wire.js';

/**
 * The filters a page's template may use (decision 0032 section 8): text shaping,
 * and nothing that reads the machine — no date, no file, no encoding. A filter a
 * template names and this list lacks is a parse error with the template's line,
 * not a silent empty value.
 */
export const TEMPLATE_FILTERS: readonly string[] = [
  'append', 'prepend', 'capitalize', 'downcase', 'upcase', 'default', 'escape', 'first', 'join', 'last',
  'replace', 'size', 'split', 'strip', 'strip_newlines', 'truncate',
];

/** The bounds one render runs under: the cooperative ones Liquid itself counts, and the ones the server counts. */
export interface RenderLimits {
  /** What Liquid counts itself: outputs and tags evaluated, new objects, template characters. */
  templateLimit: number;
  renderLimit: number;
  memoryLimit: number;
  parseLimit: number;
  /** The blocks one page may dispatch. */
  blocks: number;
  /** The characters one page may produce. */
  outputChars: number;
}

/** A block the server is asked for: `tag` is a block of the page, `data` is the data a template tests. */
export type BlockPurpose = 'tag' | 'data';

export type RenderRequest =
  | { type: 'open'; templates: Readonly<Record<string, string>>; blocks: readonly string[]; limits: RenderLimits }
  | { type: 'render'; id: number; template: string; data: Readonly<Record<string, unknown>> };

export type RenderReply =
  | { type: 'ready' }
  | { type: 'refused'; message: string }
  /** A block the page dispatches; the server answers with `blocked`. */
  | { type: 'block'; id: number; seq: number; name: string; params: Record<string, string>; purpose: BlockPurpose; line: number }
  | { type: 'rendered'; id: number; text: string; blocks: number }
  | { type: 'failed'; id: number; message: string; file?: string; line?: number };

/** A started render worker: lines in, lines out. */
export interface RenderWorkerProcess {
  /** The process's id, when this machine says it: the memory it holds is read by it. */
  readonly pid: number | undefined;
  write(line: string): void;
  readonly lines: AsyncIterable<string>;
  readonly exited: Promise<number>;
  stderr(): string;
  kill(): void;
}

/** The server's answer to one `block` message: the block the server read, as the page shows it. */
export type BlockAnswer = { type: 'blocked'; seq: number; block: unknown } | { type: 'blocked'; seq: number; message: string };

/** The token a block stands at in the rendered text: a character no template writes, so a text cannot make one. */
export const BLOCK_TOKEN = '\u0000';

export const blockToken = (seq: number): string => `${BLOCK_TOKEN}m${seq}${BLOCK_TOKEN}`;

/** A written text split at the tokens of its blocks: a text, the number of a block, a text, and so on. */
export function splitBlocks(text: string): (string | number)[] {
  const parts: (string | number)[] = [];
  let at = 0;
  const pattern = new RegExp(`${BLOCK_TOKEN}m(\\d+)${BLOCK_TOKEN}`, 'g');
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start > at) parts.push(text.slice(at, start));
    parts.push(Number(match[1]));
    at = start + match[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

/** The position Liquid names in a message, taken out of it: a finding carries the file and the line of its own. */
function withoutPosition(message: string): string {
  return message.replace(/, file:.*$/, '').replace(/, line:\d+, col:\d+$/, '');
}

interface RenderState {
  seq: number;
  blocks: number;
  limits: RenderLimits;
  cache: Map<string, { seq: number; block: unknown }>;
  ask: (name: string, params: Record<string, string>, purpose: BlockPurpose, line?: number) => Promise<{ seq: number; block: unknown }>;
}

export async function runRenderWorker(io: { lines: AsyncIterable<string>; send: (line: string) => void }): Promise<number> {
  const send = (reply: RenderReply): void => io.send(encodeWire(reply));
  let templates: Readonly<Record<string, string>> = {};
  let blockNames: readonly string[] = [];
  let limits: RenderLimits | undefined;
  let engine: Liquid | undefined;
  let state: RenderState | undefined;
  const waiting = new Map<number, { resolve: (block: unknown) => void; reject: (error: Error) => void }>();

  /** The file a message's token stands in: Liquid names the file of a tag, and of a value it names only its text. */
  const fileOf = (token: { file?: string; input?: string } | undefined): string | undefined => {
    if (token?.file !== undefined) return token.file;
    const input = token?.input;
    if (input === undefined) return undefined;
    const found = Object.entries(templates).find(([, text]) => text === input);
    return found?.[0];
  };

  const refusal = (id: number, error: unknown): RenderReply => {
    const held = error as { message?: string; token?: { file?: string; input?: string; getPosition?: () => [number, number] } };
    const message = typeof held?.message === 'string' ? held.message : String(error);
    const position = held?.token?.getPosition?.();
    const file = fileOf(held?.token);
    return { type: 'failed', id, message: withoutPosition(message), ...(file === undefined ? {} : { file }), ...(position === undefined ? {} : { line: position[0] }) };
  };

  /** A block tag of the library: `{% graph title="Around this function" depth=2 %}` writes the place of the block. */
  class BlockTag extends Tag {
    private readonly blockName: string;
    private readonly hash: Hash;
    constructor(token: TagToken, remainTokens: TopLevelToken[], liquid: Liquid) {
      super(token, remainTokens, liquid);
      this.blockName = token.name;
      this.hash = new Hash(this.tokenizer, '=');
    }

    *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
      const held = state;
      if (held === undefined) throw new Error('a block was asked for with no page being rendered');
      const raw = (yield this.hash.render(ctx)) as Record<string, unknown>;
      const params: Record<string, string> = {};
      for (const [name, value] of Object.entries(raw)) {
        if (typeof value === 'string') params[name] = value;
        else if (typeof value === 'number') params[name] = String(value);
        else throw new Error(`the parameter "${name}" of :::${this.blockName} is not a text or a number`);
      }
      if (held.blocks >= held.limits.blocks) throw new Error(`the page dispatches more than ${held.limits.blocks} blocks`);
      held.blocks += 1;
      const line = this.token.getPosition()[0];
      const asked = (yield held.ask(this.blockName, params, 'tag', line)) as { seq: number; block: unknown };
      emitter.write(blockToken(asked.seq));
    }
  }

  /** The page a template reads: its attributes, and the data of a block by its name (`page.callers.total`). */
  const pageOf = (data: Readonly<Record<string, unknown>>, held: RenderState): object =>
    new Proxy({}, {
      has: (_target, name) => typeof name === 'string' && name in data,
      get: (_target, name) => {
        if (typeof name !== 'string') return undefined;
        if (name in data) return data[name];
        // A block's data is read when a template names it (`{% if page.callers.total > 0 %}`); any other name is a
        // missing attribute, which strictVariables reports with the template's line.
        return blockNames.includes(name) ? held.ask(name, {}, 'data') : undefined;
      },
      ownKeys: () => Object.keys(data),
      getOwnPropertyDescriptor: (_target, name) => (typeof name === 'string' && name in data ? { configurable: true, enumerable: true, value: data[name] } : undefined),
    });

  const open = (request: Extract<RenderRequest, { type: 'open' }>): void => {
    templates = request.templates;
    blockNames = request.blocks;
    limits = request.limits;
    engine = new Liquid({
      templates: request.templates,
      extname: '',
      strictVariables: true,
      strictFilters: true,
      ownPropertyOnly: true,
      keyValueSeparator: '=',
      // A condition may name an attribute a page does not have (`{% if page.language %}`); printing one is still a finding.
      lenientIf: true,
      // A value printed into Markdown text is escaped as Markdown, the one compatibility the `{{label}}` form keeps.
      outputEscape: (value: unknown) => escapeMarkdown(String(value)),
      renderLimit: request.limits.renderLimit,
      memoryLimit: request.limits.memoryLimit,
      parseLimit: request.limits.parseLimit,
    });
    for (const name of request.blocks) engine.registerTag(name, BlockTag);
    for (const name of Object.keys(filters)) if (!TEMPLATE_FILTERS.includes(name)) engine.unregisterFilter(name);
    send({ type: 'ready' });
  };

  const renderNow = async (request: Extract<RenderRequest, { type: 'render' }>): Promise<void> => {
    if (engine === undefined || limits === undefined) {
      send({ type: 'failed', id: request.id, message: 'the templates were not opened before the render: the worker is not ready' });
      return;
    }
    const held: RenderState = {
      seq: 0, blocks: 0, limits, cache: new Map(),
      ask: (name, params, purpose, line) => {
        const key = `${purpose === 'tag' ? '' : 'data'}|${name}|${JSON.stringify(params)}`;
        const cached = held.cache.get(key);
        if (cached !== undefined) return Promise.resolve(cached);
        const seq = ++held.seq;
        return new Promise<{ seq: number; block: unknown }>((resolve, reject) => {
          waiting.set(seq, {
            resolve: (block) => { held.cache.set(key, { seq, block }); resolve({ seq, block }); },
            reject,
          });
          send({ type: 'block', id: request.id, seq, name, params, purpose, line: line ?? 1 });
        });
      },
    };
    state = held;
    try {
      // `templateLimit` counts the outputs and tags one render evaluates; it is per render, so it is named here.
      const text = await engine.renderFile(request.template, { ...request.data, page: pageOf(request.data, held) }, { templateLimit: limits.templateLimit });
      if (text.length > limits.outputChars) throw new Error(`the page writes more than ${limits.outputChars} characters`);
      send({ type: 'rendered', id: request.id, text, blocks: held.blocks });
    } catch (error) {
      send(refusal(request.id, error));
    } finally {
      state = undefined;
      waiting.clear();
    }
  };

  const handle = (line: string): void => {
    const message = decodeWire<RenderRequest | BlockAnswer>(line);
    if (message.type === 'open') { open(message); return; }
    if (message.type === 'blocked') {
      const held = waiting.get(message.seq);
      if (held === undefined) return;
      waiting.delete(message.seq);
      if ('message' in message) held.reject(new Error(message.message));
      else held.resolve(message.block);
      return;
    }
    // A render runs while the answers to its blocks keep arriving: it is started, never awaited here.
    void renderNow(message);
  };

  for await (const line of io.lines) handle(line);
  return 0;
}
