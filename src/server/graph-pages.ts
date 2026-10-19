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
import { NO_GRAPH_SOURCE_MESSAGE, type GraphPagesSource } from '../fill/graph-pages.js';
import type { Handled, ReplyMaker } from './http.js';

/** The source the routes read from is the fill's own (`../fill/graph-pages.ts`): a page set, a page, the changes and the wake-up. */
export type { GraphPagesSource } from '../fill/graph-pages.js';

/** The three graph routes, over one product's source. */
export interface GraphPagesPart {
  /** `GET /api/graph/pages`: the product's page-worthy nodes. */
  pages: () => Promise<Handled>;
  /** `GET /api/graph/page?id=…`: one node's page model. */
  page: (request: Request) => Promise<Handled>;
  /** `GET /api/graph/events[?after=N]`: the live channel, held open until the asker hangs up. */
  events: (request: Request) => Promise<Handled>;
}

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
    pageSet: async () => ({ product, pages: [], counts: [], total: 0, changeSeq: 0, readAt: Date.now(), message: NO_GRAPH_SOURCE_MESSAGE }),
    page: async (id: string) => ({ ok: false, code: 'graph-pages/no-graph', message: `${NO_GRAPH_SOURCE_MESSAGE}: no product is served here with a filled graph, so the page of ${id} stands nowhere` }),
    diagrams: async (id: string) => ({ ok: false, code: 'graph-pages/no-graph', message: `${NO_GRAPH_SOURCE_MESSAGE}: no product is served here with a filled graph, so the diagrams of ${id} stand nowhere` }),
    changes: async () => ({ changes: [], lastSeq: 0, truncated: false, marker: null }),
    subscribe: () => () => undefined,
  };
}

/**
 * Builds the graph routes over one product's source, with the refusals built the way
 * the wiki part builds its own. `errorLog` hears a stream's own failures: the cause
 * names files and lines and the product's folder, so it goes to the operator and
 * never to the browser, whose comment says only that the changes could not be read.
 */
export function createGraphPagesPart(makers: Pick<ReplyMaker, 'json' | 'refused'> & { readonly errorLog: (line: string) => void }, source: GraphPagesSource): GraphPagesPart {
  const { json, refused, errorLog } = makers;
  return {
    pages: async (): Promise<Handled> => {
      const set = await source.pageSet();
      return { response: json(200, set) };
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
  };
}
