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

/**
 * The tags a page's template may use: what draws a page, and nothing that reaches
 * beyond the templates it was given. LiquidJS registers more (`include`,
 * `tablerow`, `cycle`, `increment`, `decrement`, `ifchanged`); those are taken out
 * of the engine, and the `liquid` tag's own body is parsed by that same engine, so
 * a tag taken out is unknown there too.
 */
export const TEMPLATE_TAGS: readonly string[] = ['if', 'unless', 'for', 'break', 'continue', 'assign', 'capture', 'comment', 'raw', 'case', 'echo', 'liquid', 'layout', 'block', 'render'];

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

/** One segment of the rendered page: its own text, or the place a block stands at, by the sequence number the server gave it. */
export type RenderPart = string | { block: number };

export type RenderReply =
  | { type: 'ready' }
  | { type: 'refused'; message: string }
  /** A block the page dispatches; the server answers with `blocked`. */
  | { type: 'block'; id: number; seq: number; name: string; file: string; line: number; params: Record<string, string>; purpose: BlockPurpose }
  | { type: 'rendered'; id: number; parts: RenderPart[]; blocks: number }
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

/** The position Liquid names in a message, taken out of it: a finding carries the file and the line of its own. */
function withoutPosition(message: string): string {
  return message.replace(/, file:.*$/, '').replace(/, line:\d+, col:\d+$/, '');
}

interface RenderState {
  seq: number;
  blocks: number;
  limits: RenderLimits;
  /** The segments written so far: text up to each block, and the block itself. */
  parts: RenderPart[];
  /** Where the text of the page has been cut for the last block: the emitter's buffer length then. */
  cut: number;
  cache: Map<string, { seq: number; block: unknown }>;
  ask: (name: string, params: Record<string, string>, purpose: BlockPurpose, file: string, line: number) => Promise<{ seq: number; block: unknown }>;
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

  /**
   * The page's text as it stands so far, cut where the last block stands: the tag writes no marker into the page, it
   * cuts the text the emitter holds and takes its own place in the segments (no marker is ever parsed out of a text).
   */
  const cutText = (emitter: Emitter, held: RenderState, seq: number): void => {
    const text = emitter.buffer.slice(held.cut);
    if (text !== '') held.parts.push(text);
    held.cut = emitter.buffer.length;
    held.parts.push({ block: seq });
  };

  /** A block tag of the library: `{% graph title="Around this function" depth=2 %}` places the block on the page. */
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
        else throw new Error(`the parameter "${name}" of :${this.blockName} is not a text or a number`);
      }
      if (held.blocks >= held.limits.blocks) throw new Error(`the page dispatches more than ${held.limits.blocks} blocks`);
      held.blocks += 1;
      const position = this.token.getPosition();
      const file = fileOf(this.token) ?? '';
      const asked = (yield held.ask(this.blockName, params, 'tag', file, position[0] ?? 1)) as { seq: number; block: unknown };
      cutText(emitter, held, asked.seq);
    }
  }

  /**
   * The page a template reads: its attributes, and a block's data by its name
   * (`page.callers.total`). The block names are own properties of the page — a
   * plain object whose getters ask the server only when the template reads them,
   * which is what Liquid's own-property-only lookup permits.
   */
  const pageOf = (data: Readonly<Record<string, unknown>>, held: RenderState): object => {
    const page: Record<string, unknown> = { ...data };
    for (const name of blockNames) {
      if (name in page) continue;
      Object.defineProperty(page, name, {
        enumerable: true,
        configurable: true,
        get: () => held.ask(name, {}, 'data', '', 1).then((answer) => answer.block),
      });
    }
    return page;
  };

  const open = (request: Extract<RenderRequest, { type: 'open' }>): void => {
    templates = request.templates;
    blockNames = request.blocks;
    limits = request.limits;
    engine = new Liquid({
      templates: request.templates,
      extname: '',
      // A template is parsed once per worker: a changed set opens the engine again (the digest the server sends).
      cache: true,
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
    // The tags the engine registers and a page may not use are taken out of its registry: the list above is what is left.
    for (const name of Object.keys(engine.tags)) if (!TEMPLATE_TAGS.includes(name) && !request.blocks.includes(name)) delete (engine.tags as Record<string, unknown>)[name];
    send({ type: 'ready' });
  };

  const renderNow = async (request: Extract<RenderRequest, { type: 'render' }>): Promise<void> => {
    if (engine === undefined || limits === undefined) {
      send({ type: 'failed', id: request.id, message: 'the templates were not opened before the render: the worker is not ready' });
      return;
    }
    const held: RenderState = {
      seq: 0, blocks: 0, limits, parts: [], cut: 0, cache: new Map(),
      ask: (name, params, purpose, file, line) => {
        const key = `${purpose === 'tag' ? '' : 'data'}|${name}|${JSON.stringify(params)}`;
        const cached = held.cache.get(key);
        if (cached !== undefined) return Promise.resolve(cached);
        const seq = ++held.seq;
        return new Promise<{ seq: number; block: unknown }>((resolve, reject) => {
          waiting.set(seq, {
            resolve: (block) => { held.cache.set(key, { seq, block }); resolve({ seq, block }); },
            reject,
          });
          send({ type: 'block', id: request.id, seq, name, file, line, params, purpose });
        });
      },
    };
    state = held;
    try {
      // `templateLimit` counts the outputs and tags one render evaluates; it is per render, so it is named here.
      const text = await engine.renderFile(request.template, { ...request.data, page: pageOf(request.data, held) }, { templateLimit: limits.templateLimit });
      if (held.cut < text.length) held.parts.push(text.slice(held.cut));
      held.cut = text.length;
      if (held.parts.reduce((sum, part) => sum + (typeof part === 'string' ? part.length : 0), 0) > limits.outputChars) throw new Error(`the page writes more than ${limits.outputChars} characters`);
      send({ type: 'rendered', id: request.id, parts: held.parts, blocks: held.blocks });
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

