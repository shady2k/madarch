/**
 * The graph's pages over HTTP (madarch-tzte.23.1; decision 0026, "Pages"): the
 * page set, one node's page model and the live channel that pushes the pages a
 * publication touched, over one product's graph.
 *
 * The routes are the wiki's own kind — they stand beside `GET /api/pages` and
 * `GET /api/events` and answer under a product's prefix in a products home — and
 * the reads behind them are the fill's (`../fill/graph-pages.ts`); this module only
 * carries them to a client and holds the streams. A source that is absent answers
 * an empty page set carrying the message that says where the pages are served
 * (`emptyGraphPagesSource`): 0026 asks for a message on an empty graph and never an
 * error, and a server that holds no fill's graph is the emptiest graph there is.
 *
 * **The live channel.** `GET /api/graph/events` is a Server-Sent Events stream
 * (`text/event-stream`) of `pages` events, one per publication that touched a page:
 * its `data` names the publication and the pages it touched, and its `id` is the
 * store's own sequence number, so a client resumes with `?after=<seq>` and loses
 * nothing. There is no polling anywhere in it: the stream is woken by the
 * publication itself (the fill's `unit-published` event, `../fill/orchestrator-host.ts`),
 * and a publication that touched no page wakes nobody. A `retry:` line comes
 * first, as in the wiki's own change stream, and a comment keeps the connection
 * alive while a quiet product stays quiet.
 */
import { emptyNextStep, emptyQuestionSet, NO_GRAPH_SOURCE_MESSAGE, type GraphDecisionWrite, type GraphPageSetAnswer, type GraphPagesSource } from '../fill/graph-pages.js';
import type { Handled, ReplyMaker } from './http.js';

/** The source the routes read from is the fill's own (`../fill/graph-pages.ts`): a page set, a page, the changes and the wake-up. */
export type { GraphPagesSource } from '../fill/graph-pages.js';

/** The three graph routes, over one product's source. */
export interface GraphPagesPart {
  /** `GET /api/graph/pages[?fields=nav]`: the product's page-worthy nodes — the whole set, or the fields a list shows (madarch-tzte.23.8) — compressed when the client accepts it. */
  pages: (request: Request) => Promise<Handled>;
  /** `GET /api/graph/page?id=…`: one node's page model. */
  page: (request: Request) => Promise<Handled>;
  /** `GET /api/graph/events[?after=N]`: the live channel, held open until the asker hangs up. */
  events: (request: Request) => Promise<Handled>;
  /** `POST /api/graph/answer`: the person's answer to one open question, as Markdown in the product's git. */
  answer: (request: Request) => Promise<Handled>;
  /** `POST /api/graph/decide`: the person's acceptance or rejection of a page's proposed content. */
  decide: (request: Request) => Promise<Handled>;
}

/** The answer size under which the page set is sent as it stands: below it a compression saves less than it costs. */
const GZIP_MIN_BYTES = 64 * 1024;

/** How often a stream over a quiet product says it is alive: an SSE comment, which is no event. */
const KEEP_ALIVE_MS = 30_000;

/** What a stream asks a client to wait before it reconnects, in milliseconds: the wiki's own change stream asks the same. */
const RETRY_MS = 3_000;

/** The bytes one event line is encoded in. */
const eventBytes = new TextEncoder();

/**
 * A source for a server that holds no fill's graph (a foreground `madarch serve`,
 * a product served without the background server): an empty page set that carries
 * the message saying where the pages are, a page that is refused with the same
 * words, and a channel nothing ever wakes. It is a source and not a special case at
 * each route, so every route answers the same shape wherever it stands.
 */
export function emptyGraphPagesSource(product: string): GraphPagesSource {
  return {
    pageSet: async () => ({ product, pages: [], counts: [], total: 0, changeSeq: 0, readAt: Date.now(), message: NO_GRAPH_SOURCE_MESSAGE, questions: emptyQuestionSet(), nextStep: emptyNextStep(product) }),
    page: async (id: string) => ({ ok: false, code: 'graph-pages/no-graph', message: `${NO_GRAPH_SOURCE_MESSAGE}: no product is served here with a filled graph, so the page of ${id} stands nowhere` }),
    diagrams: async (id: string) => ({ ok: false, code: 'graph-pages/no-graph', message: `${NO_GRAPH_SOURCE_MESSAGE}: no product is served here with a filled graph, so the diagrams of ${id} stand nowhere` }),
    changes: async () => ({ changes: [], lastSeq: 0, truncated: false, marker: null }),
    answer: async (request: { readonly question: string }) => ({ ok: false, code: 'graph-pages/no-graph', message: `${NO_GRAPH_SOURCE_MESSAGE}: the answer to ${request.question} has no graph to land in` }),
    decide: async (request: { readonly page: string }) => ({ ok: false, code: 'graph-pages/no-graph', message: `${NO_GRAPH_SOURCE_MESSAGE}: the decision about ${request.page} has no graph to land in` }),
    subscribe: () => () => undefined,
  };
}

/**
 * The page set's fields a list shows (madarch-tzte.23.8): a node's id, its kind, its
 * label and the layer it was obtained at, and nothing else. The navigation and the
 * index read exactly these — a code place and a rank are what a node's own page shows —
 * and the whole set is the largest answer the wiki gives: 16 527 510 bytes for the
 * current madarch tree's 35 370 entries, parsed in the browser on every page load.
 * `GET /api/graph/pages?fields=nav` answers that list; a request that names no fields
 * gets the whole set, field for field, as it always has.
 */
export const LIST_FIELDS_PARAM = 'nav';

/** One entry as the list names it: the four fields a list shows. */
interface ListedEntry {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly layer: string;
}

/** One page set as a list names it: the answer's own fields, and every entry narrowed to the list's four. */
interface ListedSet {
  readonly product: string;
  readonly pages: readonly ListedEntry[];
  readonly counts: GraphPageSetAnswer['counts'];
  readonly total: number;
  readonly changeSeq: number;
  readonly readAt: number;
  readonly message: string | null;
}

/** The page set as a list names it: the same product, counts, total, change number, moment and message, and every entry narrowed to the list's fields. */
function listedSet(set: GraphPageSetAnswer): ListedSet {
  return {
    product: set.product,
    pages: set.pages.map((entry) => ({ id: entry.id, kind: entry.kind, label: entry.label, layer: entry.layer })),
    counts: set.counts,
    total: set.total,
    changeSeq: set.changeSeq,
    readAt: set.readAt,
    message: set.message,
  };
}

/**
 * Builds the graph routes over one product's source, with the refusals built the way
 * the wiki part builds its own. `errorLog` hears a stream's own failures: the cause
 * names files and lines and the product's folder, so it goes to the operator and
 * never to the browser, whose comment says only that the changes could not be read.
 */
/** Whether a request says it accepts gzip: its `accept-encoding`, where a client that names none is not asked to read one. */
function acceptsGzip(request: Request | undefined): boolean {
  const asked = request?.headers.get('accept-encoding') ?? '';
  return /(?:^|,)\s*(?:gzip|\*)\s*(?:;|,|$)/i.test(asked);
}

export function createGraphPagesPart(makers: Pick<ReplyMaker, 'json' | 'refused'> & { readonly errorLog: (line: string) => void }, source: GraphPagesSource): GraphPagesPart {
  const { json, refused, errorLog } = makers;
  /**
   * The page set's answer as the bytes a browser receives, kept for the set it was made from: the set the source
   * answers is that source's own cached answer, so one answer is one body however many clients ask for it, and a
   * publication that moves the set hands over a new one (madarch-tzte.23.8).
   *
   * It is gzipped because it is the largest answer the wiki gives — the current madarch tree's page set is 16 527 510
   * bytes for 35 370 pages, and 2 406 ms of the index's own stand was the browser taking those bytes over a local
   * socket where the server had answers to give in 209 ms. A body under `GZIP_MIN_BYTES` is sent as it stands: a small
   * graph pays nothing for a compression nothing would save.
   */
  // The plain body and the compressed one are both kept for the set they were made from: a client that does not
  // accept gzip is answered as it stands, and the compression is paid once per set either way (`Bun.gzipSync`, the
  // runtime the server runs on — `src/index.ts`). Two shapes are kept — the whole set and the list's fields — so a
  // reader of either pays nothing for the other.
  type Encoded = { readonly set: unknown; readonly plain: ArrayBuffer; readonly gzip: ArrayBuffer | undefined };
  const encoded = new Map<'full' | 'list', Encoded>();
  const bodiesOf = (shape: 'full' | 'list', set: unknown, value: unknown): Encoded => {
    const held = encoded.get(shape);
    if (held !== undefined && held.set === set) return held;
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const asBuffer = (held2: Uint8Array): ArrayBuffer => held2.buffer.slice(held2.byteOffset, held2.byteOffset + held2.byteLength) as ArrayBuffer;
    const compressible = bytes.byteLength >= GZIP_MIN_BYTES && typeof Bun !== 'undefined';
    const made: Encoded = { set, plain: asBuffer(bytes), gzip: compressible ? asBuffer(Bun.gzipSync(bytes)) : undefined };
    encoded.set(shape, made);
    return made;
  };

  /** One decision request's own fields, or the refusal naming what its body is not. */
  const readDecision = async (request: Request): Promise<{ readonly kind: 'fields'; readonly fields: Readonly<Record<string, unknown>> } | { readonly kind: 'refused'; readonly refused: Handled }> => {
    const declared = request.headers.get('content-length');
    if (declared !== null && Number(declared) > DECISION_BYTES) return { kind: 'refused', refused: refused(413, { message: `the request is ${declared} bytes by its own content-length, past the ${String(DECISION_BYTES)}-byte limit` }) };
    const text = await request.text();
    if (Buffer.byteLength(text) > DECISION_BYTES) return { kind: 'refused', refused: refused(413, { message: `the request is ${Buffer.byteLength(text)} bytes, past the ${String(DECISION_BYTES)}-byte limit` }) };
    let body: unknown;
    try { body = JSON.parse(text); } catch (error) { return { kind: 'refused', refused: refused(400, { message: `the request body is not valid JSON: ${(error as Error).message}` }) }; }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return { kind: 'refused', refused: refused(400, { message: 'the request body is an object naming what is decided' }) };
    return { kind: 'fields', fields: body as Record<string, unknown> };
  };

  /**
   * One decision's answer: the document the product's git holds and the pages the graph read
   * again, or the refusal naming why the decision landed nowhere. A person who typed nothing,
   * a question nobody raised and a page another product holds are each told apart, so the app
   * can say which it was.
   */
  const decisionAnswer = (result: GraphDecisionWrite): Handled => result.ok
    ? { response: json(200, { file: result.file, pages: result.pages }) }
    : refused(decisionStatus(result.code), { message: result.message, ...(result.file === undefined ? {} : { field: result.file }) });

  return {
    pages: async (request?: Request): Promise<Handled> => {
      const asked = request === undefined ? null : new URL(request.url).searchParams.get('fields');
      // A value the route does not know is a wrong value, named with the one it accepts:
      // a client that asks for fields it made up would otherwise be answered something else.
      if (asked !== null && asked !== LIST_FIELDS_PARAM) {
        return refused(400, {
          field: 'fields',
          accepted: `${LIST_FIELDS_PARAM}, or no fields for the whole set`,
          message: `"fields" is ${JSON.stringify(asked)}, which the page set cannot give: ask for ${JSON.stringify(LIST_FIELDS_PARAM)} — the fields the navigation and the index read — or name no fields for the whole set`,
        });
      }
      const set = await source.pageSet();
      const { plain, gzip } = asked === LIST_FIELDS_PARAM ? bodiesOf('list', set, listedSet(set)) : bodiesOf('full', set, set);
      // A request that names no gzip — `accept-encoding: identity`, a bare library, a client that sends none — is
      // answered as the bytes stand: a `content-encoding` its client cannot read is worse than a longer answer.
      const compressed = gzip !== undefined && acceptsGzip(request);
      const body = compressed ? gzip : plain;
      return {
        response: new Response(body, {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-cache',
            vary: 'accept-encoding',
            ...(compressed ? { 'content-encoding': 'gzip' } : {}),
          },
        }),
      };
    },
    page: async (request: Request): Promise<Handled> => {
      const asked = new URL(request.url).searchParams.get('id');
      if (asked === null || asked.trim() === '') {
        return refused(400, { field: 'id', message: '"id" is required: the fact id of the graph node whose page is asked for, like "module:1f…"' });
      }
      const read = await source.page(asked);
      if (!read.ok) {
        // An id that is no fact id is a wrong value (400, with the field and what it accepts); an id the graph
        // holds no page for is a page that stands nowhere (404). Both carry their own code, so a client can tell
        // a page that disappeared from an id it malformed.
        const status = read.code === 'graph-pages/not-a-fact-id' ? 400 : 404;
        return refused(status, { field: 'id', message: read.message, code: read.code, logMessage: `${read.code}: a page was asked for and not answered` });
      }
      return { response: json(200, read.page) };
    },
    events: async (request: Request): Promise<Handled> => {
      const asked = new URL(request.url).searchParams.get('after');
      let after: number;
      if (asked === null) {
        // A client that names no sequence number reads the set it holds now and wants what comes after: the
        // latest change the product holds, read from the store's own sequence number. A store that cannot answer
        // that now is a refusal the client may retry (503) — never a stream that replays the product's whole
        // history because it could not learn where it stands.
        try {
          after = (await source.changes(Number.MAX_SAFE_INTEGER)).lastSeq;
        } catch (error) {
          errorLog(`the graph pages of a product could not be read to start a change stream: ${error instanceof Error ? error.message : String(error)}`);
          return refused(503, { field: 'after', message: 'the product\'s changes could not be read, so this stream has no place to start: name one with "after" (a page set\'s "changeSeq") or ask again' });
        }
      } else if (/^\d+$/.test(asked) && Number.isSafeInteger(Number(asked))) {
        after = Number(asked);
      } else {
        // An empty "after" is a wrong value like any other (`?id=` refuses an empty id the same way).
        return refused(400, { field: 'after', message: `"after" ${JSON.stringify(asked)} is no sequence number: it is the store's own change number (0 or a whole number), the one a page set's "changeSeq" names` });
      }
      const stream = new ReadableStream({
        start: (into): void => {
          let lastSeq = after;
          let ended = false;
          let reading = false;
          let again = false;
          // The subscription and the keep-alive are ended by `end`, which a request that is already aborted reaches
          // before either exists: both are declared here, so the stream never runs a closer over nothing.
          let unsubscribe: () => void = () => undefined;
          let keepAlive: ReturnType<typeof setInterval> | undefined;
          const write = (line: string): void => {
            if (ended) return;
            try {
              into.enqueue(eventBytes.encode(line));
            } catch {
              // A stream that stopped taking bytes is ending; the closer below runs.
            }
          };
          const end = (): void => {
            if (ended) return;
            ended = true;
            unsubscribe();
            if (keepAlive !== undefined) clearInterval(keepAlive);
            try {
              into.close();
            } catch {
              // Already closing, or closed by the asking side.
            }
          };
          /** One read of the changes, written out event by event; a bounded answer is followed by the next one. */
          const flush = async (): Promise<void> => {
            if (ended) return;
            if (reading) {
              again = true;
              return;
            }
            reading = true;
            try {
              for (;;) {
                const answer = await source.changes(lastSeq);
                for (const change of answer.changes) {
                  write(`id: ${change.seq}\nevent: pages\ndata: ${JSON.stringify({ seq: change.seq, nodes: change.nodes, unit: change.unitId, generation: change.generation, publication: change.publication })}\n\n`);
                  lastSeq = Math.max(lastSeq, change.seq);
                }
                if (answer.truncated === false) break;
              }
            } catch (error) {
              // A change the store could not answer now is not an event: the next publication wakes this stream
              // again, and the client's own reconnection asks for the set from scratch. The cause names files,
              // lines and tables, so it goes to the log and not to the browser.
              errorLog(`the graph pages of a product could not be read after change ${lastSeq}: ${error instanceof Error ? error.message : String(error)}`);
              write(`: the changes after ${lastSeq} could not be read now\n\n`);
            } finally {
              reading = false;
              if (again && ended === false) {
                again = false;
                await flush();
              }
            }
          };
          write(`retry: ${RETRY_MS}\n\n`);
          // A request already hung up when the stream starts is a stream that ends before it reads anything: the
          // abort event has been and gone, so nothing would ever close it.
          if (request.signal.aborted) {
            end();
            return;
          }
          keepAlive = setInterval(() => write(': ping\n\n'), KEEP_ALIVE_MS);
          unsubscribe = source.subscribe(() => {
            void flush();
          });
          request.signal.addEventListener('abort', end);
          // A publication that landed between the page set the client holds and this subscription is caught
          // by one read at once: the client's `after` is where its set stood, and nothing published since is lost.
          void flush();
        },
      });
      return {
        response: new Response(stream, {
          status: 200,
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          },
        }),
      };
    },
    answer: async (request: Request): Promise<Handled> => {
      const body = await readDecision(request);
      if (body.kind === 'refused') return body.refused;
      const fields = body.fields;
      const question = fields['question'];
      const words = fields['answer'];
      if (typeof question !== 'string' || FACT_ID.test(question) === false) return refused(400, { field: 'question', message: 'an answer names its question by the question fact id: a kind, a colon and 64 lower-case hexadecimal digits' });
      if (typeof words !== 'string') return refused(400, { field: 'answer', message: 'an answer carries the words the person wrote' });
      return decisionAnswer(await source.answer({ question, answer: words, by: personOf(fields) }));
    },
    decide: async (request: Request): Promise<Handled> => {
      const body = await readDecision(request);
      if (body.kind === 'refused') return body.refused;
      const fields = body.fields;
      const page = fields['page'];
      const verdict = fields['verdict'];
      const note = fields['note'];
      if (typeof page !== 'string' || FACT_ID.test(page) === false) return refused(400, { field: 'page', message: 'a decision names its page by the node fact id: a kind, a colon and 64 lower-case hexadecimal digits' });
      if (verdict !== 'accepted' && verdict !== 'rejected') return refused(400, { field: 'verdict', message: 'a person accepts a page or rejects it: the verdict is "accepted" or "rejected"' });
      if (note !== undefined && typeof note !== 'string') return refused(400, { field: 'note', message: 'the note a person leaves is Markdown, and Markdown is a string' });
      return decisionAnswer(await source.decide({ page, verdict, note: note ?? '', by: personOf(fields) }));
    },
  };
}

/**
 * The status one refused decision answers with: a node the graph does not hold is a 404, a
 * request that names nothing a decision can be about is a 400, and a graph that is not there
 * to write to is a 503 — a person reading a wiki without a fill behind it.
 */
export function decisionStatus(code: string): number {
  if (code === 'graph-pages/no-graph') return 503;
  if (code === 'graph-pages/no-such-node' || code === 'graph-pages/not-a-question' || code === 'graph-pages/not-a-page') return 404;
  if (code === 'graph-pages/not-a-fact-id' || code === 'graph-pages/empty-answer' || code === 'graph-pages/not-a-verdict') return 400;
  return 500;
}

/** The shape of a fact id, as the routes check it before a write (`src/fill/facts.ts`): the kind, a colon, 64 hex digits. */
const FACT_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*:[0-9a-f]{64}$/;

/** The most bytes one decision request holds: an answer is what a person typed, never a document. */
const DECISION_BYTES = 1_000_000;

/** Who a decision is from, as the request says: a person's own name, or the wiki's own words when they left it out. */
function personOf(fields: Readonly<Record<string, unknown>>): string {
  const by = fields['by'];
  return typeof by === 'string' && by.trim() !== '' ? by.trim() : 'a reader of the wiki';
}

