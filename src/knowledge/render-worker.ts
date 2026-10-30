/**
 * The render worker (madarch-u3vw.1, decision 0032 section 8): `madarch
 * knowledge-render-worker`. A template a person wrote or edited is evaluated here,
 * in a process of its own, which the server can kill by wall clock and by the memory
 * it holds — Liquid's own limits are cooperative, and a template nobody reviewed may
 * loop forever or draw a gigabyte. A page whose every template is one the starter set
 * ships byte for byte is drawn by the server itself (`liquid.ts`).
 *
 * A page's blocks are asked for **once, after the page is rendered**: a block tag
 * writes the place it stands at with the parameters it was given, and the server
 * reads them all in one go. A template that tests a block's own data is rendered a
 * second time, with that data in hand — one hop instead of one per block.
 *
 * Messages are lines of JSON (`wire.ts`) on standard input and output, as the read
 * and fill workers say theirs.
 */
import { createTemplateEngine, withoutPosition, type BlockRequest, type RenderLimits, type RenderPart, type TemplateEngine } from './liquid-engine.js';
import { decodeWire, encodeWire } from './wire.js';

export { TEMPLATE_FILTERS, TEMPLATE_TAGS, type BlockRequest, type RenderLimits, type RenderPart } from './liquid-engine.js';

export type RenderRequest =
  | { type: 'open'; templates: Readonly<Record<string, string>>; blocks: readonly string[]; limits: RenderLimits }
  | { type: 'render'; id: number; template: string; data: Readonly<Record<string, unknown>> };

export type RenderReply =
  | { type: 'ready' }
  | { type: 'refused'; message: string }
  | {
    type: 'rendered';
    id: number;
    parts: RenderPart[];
    /** The blocks the page dispatches, in the order their places stand on the page. */
    requests: BlockRequest[];
    /** The block names the template tested (`page.callers`): their data must be in hand for the page to be rendered again. */
    dataMisses: string[];
  }
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

export async function runRenderWorker(io: { lines: AsyncIterable<string>; send: (line: string) => void }): Promise<number> {
  const send = (reply: RenderReply): void => io.send(encodeWire(reply));
  let engine: TemplateEngine | undefined;

  const open = (request: Extract<RenderRequest, { type: 'open' }>): void => {
    engine = createTemplateEngine({ templates: request.templates, blocks: request.blocks, limits: request.limits });
    send({ type: 'ready' });
  };

  const renderNow = async (request: Extract<RenderRequest, { type: 'render' }>): Promise<void> => {
    if (engine === undefined) {
      send({ type: 'failed', id: request.id, message: 'the templates were not opened before the render: the worker is not ready' });
      return;
    }
    try {
      const answered = await engine.render(request.template, request.data);
      send({ type: 'rendered', id: request.id, ...answered });
    } catch (error) {
      const held = error as { message?: string; file?: string; line?: number };
      send({ type: 'failed', id: request.id, message: withoutPosition(typeof held.message === 'string' ? held.message : String(error)), ...(held.file === undefined ? {} : { file: held.file }), ...(held.line === undefined ? {} : { line: held.line }) });
    }
  };

  for await (const line of io.lines) {
    const message = decodeWire<RenderRequest>(line);
    if (message.type === 'open') open(message);
    // A render runs while the next line is read: the answers of a page are the server's to send back, and none is asked.
    else void renderNow(message);
  }
  return 0;
}
