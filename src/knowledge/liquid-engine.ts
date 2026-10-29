/**
 * The template engine a page is drawn with (madarch-u3vw.1, decision 0032 section
 * 8): the Liquid environment, the engine's blocks as tags, the filters and tags a
 * page may use, and one render that answers the page's text with the places its
 * blocks stand.
 *
 * It is used twice: by the render worker, which draws a template a person wrote or
 * edited in a process of its own the server can kill, and by the server itself,
 * which draws a page whose every template is byte-identical to one the starter set
 * ships — a template nobody wrote but madarch, bounded by the engine's own
 * cooperative limits alone (`liquid.ts`).
 */
import { Hash, Liquid, Tag, filters, type Context, type Emitter, type TopLevelToken, type TagToken } from 'liquidjs';
import { escapeMarkdown } from './template.js';

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
 * of the engine, and the `liquid` tag's own body is parsed by that same engine, so a
 * tag taken out is unknown there too.
 */
export const TEMPLATE_TAGS: readonly string[] = ['if', 'unless', 'for', 'break', 'continue', 'assign', 'capture', 'comment', 'raw', 'case', 'echo', 'liquid', 'layout', 'block', 'render'];

/** The bounds one render runs under: the cooperative ones Liquid counts itself, and the ones the server counts. */
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

/** A block a page dispatches: what the server reads, and where it stands on the page. */
export interface BlockRequest {
  name: string;
  params: Record<string, string>;
  /** The template the block stands in: a partial's block is not the page's template. */
  file: string;
  line: number;
}

/** One segment of the rendered page: its own text, or the place a block stands at, by its index in `requests`. */
export type RenderPart = string | { block: number };

/** What one render answered: the page as segments, the blocks it dispatches, and the block data it tested but lacks. */
export interface TemplateRender {
  parts: RenderPart[];
  requests: BlockRequest[];
  dataMisses: string[];
}

/** A page whose template or partial stands in a file the worker cannot name: the answer carries this instead of a file. */
export type TemplateFailure = { message: string; file?: string; line?: number };

export class TemplateError extends Error {
  readonly file: string | undefined;
  readonly line: number | undefined;
  constructor(error: unknown, file: string | undefined, fileOf: (token: { file?: string; input?: string } | undefined) => string | undefined) {
    const held = error as { message?: string; token?: { file?: string; input?: string; getPosition?: () => [number, number] } };
    super(typeof held?.message === 'string' ? held.message : String(error));
    const position = held?.token?.getPosition?.();
    // A tag's token names its file; a value's names only its text, which is the file's own text (a partial's included).
    this.file = fileOf(held?.token) ?? file;
    this.line = position?.[0];
  }
}

/** The position Liquid names in a message, taken out of it: a finding carries the file and the line of its own. */
export function withoutPosition(message: string): string {
  return message.replace(/, file:.*$/, '').replace(/, line:\d+, col:\d+$/, '');
}

export interface TemplateEngine {
  /** Draws one template over the page's data: the page's segments, its blocks and the block data it missed. */
  render(template: string, data: Readonly<Record<string, unknown>>): Promise<TemplateRender>;
}

/** The engine over one set of templates, with the library's blocks as tags. */
export function createTemplateEngine(input: {
  templates: Readonly<Record<string, string>>;
  blocks: readonly string[];
  limits: RenderLimits;
}): TemplateEngine {
  const { templates, blocks, limits } = input;
  let state: {
    blocks: number;
    parts: RenderPart[];
    requests: BlockRequest[];
    cut: number;
    dataMisses: Set<string>;
  } | undefined;

  /** The file a message's token stands in: Liquid names the file of a tag, and of a value it names only its text. */
  const fileOf = (token: { file?: string; input?: string } | undefined): string | undefined => {
    if (token?.file !== undefined) return token.file;
    const input = token?.input;
    if (input === undefined) return undefined;
    const found = Object.entries(templates).find(([, text]) => text === input);
    return found?.[0];
  };

  /**
   * The page's text as it stands so far, cut where the block stands: the tag writes no marker into the page, it cuts the
   * text the emitter holds and takes the place of the block in the segments (no marker is ever parsed out of a text).
   */
  const cutText = (emitter: Emitter, held: NonNullable<typeof state>, index: number): void => {
    const text = emitter.buffer.slice(held.cut);
    if (text !== '') held.parts.push(text);
    held.cut = emitter.buffer.length;
    held.parts.push({ block: index });
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
        else throw new Error(`the parameter "${name}" of the block ${this.blockName} is not a text or a number`);
      }
      if (held.blocks >= limits.blocks) throw new Error(`the page dispatches more than ${limits.blocks} blocks`);
      held.blocks += 1;
      const position = this.token.getPosition();
      held.requests.push({ name: this.blockName, params, file: fileOf(this.token) ?? '', line: position[0] ?? 1 });
      cutText(emitter, held, held.requests.length - 1);
    }
  }

  const engine = new Liquid({
    templates,
    extname: '',
    // A template is parsed once per engine: a changed set opens an engine again (the server hands the set by digest).
    cache: true,
    strictVariables: true,
    strictFilters: true,
    ownPropertyOnly: true,
    keyValueSeparator: '=',
    // A condition may name an attribute a page does not have (`{% if page.language %}`); printing one is still a finding.
    lenientIf: true,
    // A value printed into Markdown text is escaped as Markdown, the one compatibility the `{{label}}` form keeps.
    outputEscape: (value: unknown) => escapeMarkdown(String(value)),
    renderLimit: limits.renderLimit,
    memoryLimit: limits.memoryLimit,
    parseLimit: limits.parseLimit,
  });
  for (const name of blocks) engine.registerTag(name, BlockTag);
  for (const name of Object.keys(filters)) if (!TEMPLATE_FILTERS.includes(name)) engine.unregisterFilter(name);
  // The tags the engine registers and a page may not use are taken out of its registry: the list above is what is left.
  for (const name of Object.keys(engine.tags)) if (!TEMPLATE_TAGS.includes(name) && !blocks.includes(name)) delete (engine.tags as Record<string, unknown>)[name];

  const pageOf = (data: Readonly<Record<string, unknown>>): object => {
    const page: Record<string, unknown> = { ...data };
    for (const name of blocks) {
      if (name in page) continue;
      Object.defineProperty(page, name, {
        enumerable: true,
        configurable: true,
        get: () => {
          state?.dataMisses.add(name);
          return {};
        },
      });
    }
    return page;
  };

  return {
    async render(template, data) {
      const held = { blocks: 0, parts: [] as RenderPart[], requests: [] as BlockRequest[], cut: 0, dataMisses: new Set<string>() };
      state = held;
      try {
        // `templateLimit` counts the outputs and tags one render evaluates; it is per render, so it is named here.
        const text = await engine.renderFile(template, { ...data, page: pageOf(data) }, { templateLimit: limits.templateLimit });
        if (held.cut < text.length) held.parts.push(text.slice(held.cut));
        held.cut = text.length;
        const written = held.parts.reduce((sum, part) => sum + (typeof part === 'string' ? part.length : 0), 0);
        if (written > limits.outputChars) throw new Error(`the page writes more than ${limits.outputChars} characters`);
        return { parts: held.parts, requests: held.requests, dataMisses: [...held.dataMisses] };
      } catch (error) {
        throw new TemplateError(error, template, fileOf);
      } finally {
        state = undefined;
      }
    },
  };
}
