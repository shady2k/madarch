/**
 * The knowledge wiki's routes (decision 0029) over one product: its status, a
 * page, a kind's entities, a source file, the fill and the stream that tells
 * an open page to read again when a commit lands. The reads and the fill are
 * `src/knowledge/product.ts`; this module carries them to a client.
 *
 * The stream is Server-Sent Events like the graph pages' (`graph-pages.ts`): a
 * `retry:` line first, `fill` events for the fill's progress, `pages` events
 * after each commit, and a comment now and then so a quiet product keeps its
 * connection.
 */
import { languageOf } from '../knowledge/blocks.js';
import { WikiReadError, type KnowledgeProduct } from '../knowledge/product.js';
import type { Handled, ReplyMaker } from './http.js';

export interface KnowledgePart {
  /** Who the product is, read from its manifest alone: it answers before the graph store is open. */
  identity: (request: Request) => Promise<Handled>;
  status: (request: Request) => Promise<Handled>;
  page: (request: Request) => Promise<Handled>;
  statement: (request: Request) => Promise<Handled>;
  entities: (request: Request) => Promise<Handled>;
  neighborhood: (request: Request) => Promise<Handled>;
  source: (request: Request) => Promise<Handled>;
  fill: (request: Request) => Promise<Handled>;
  agents: (request: Request) => Promise<Handled>;
  chooseAgent: (request: Request) => Promise<Handled>;
  products: (request: Request) => Promise<Handled>;
  reset: (request: Request) => Promise<Handled>;
  documents: (request: Request) => Promise<Handled>;
  document: (request: Request) => Promise<Handled>;
}

/** The largest file the source view shows whole. */
export const SOURCE_VIEW_BYTES = 2 * 1024 * 1024;

/**
 * A request another site's page made through the reader's browser: the browser says so in `Sec-Fetch-Site`, and what
 * starts an agent or installs an adapter is the reader's press in this wiki alone. A client that is no browser sends none.
 */
function foreign(request: Request): string | undefined {
  const site = request.headers.get('sec-fetch-site');
  return site === null || site === 'same-origin' || site === 'none'
    ? undefined
    : `this request was made from another site (Sec-Fetch-Site: ${site}); a fill, an agent choice or an adapter install is started only from this wiki's own page`;
}

export function createKnowledgePart(
  makers: Pick<ReplyMaker, 'json' | 'refused'> & { errorLog: (line: string) => void },
  product: KnowledgeProduct,
  /** The names of the products this server serves, for the selector; the one product alone when it serves one. */
  siblings: () => { name: string; folder: string }[],
): KnowledgePart {
  const { json, refused, errorLog } = makers;
  const guarded = (what: string, work: (request: Request) => Promise<Handled>) => async (request: Request): Promise<Handled> => {
    try {
      return await work(request);
    } catch (error) {
      if (error instanceof WikiReadError) {
        errorLog(`the knowledge wiki could not ${what}: ${error.message}`);
        return refused(500, { message: error.message });
      }
      errorLog(`the knowledge wiki could not ${what}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      return refused(500, { message: `the wiki could not ${what}; the cause is in the server's log` });
    }
  };
  return {
    identity: guarded('read the product', async () => {
      const identity = product.product();
      if ('message' in identity) throw new WikiReadError(identity.message);
      return { response: json(200, { id: identity.id, name: identity.name }) };
    }),
    status: guarded('read the product', async () => ({ response: json(200, await product.status()) })),
    page: guarded('draw the page', async (request) => {
      const id = new URL(request.url).searchParams.get('id');
      if (id === null || id.trim() === '') return refused(400, { field: 'id', message: '"id" is required: the key or id of the entity whose page is asked for' });
      const asked = new URL(request.url).searchParams.get('lang');
      const result = await product.page(id, asked === 'ru' || asked === 'en' ? asked : undefined);
      if (!result.ok) return refused(result.status, { field: 'id', message: result.message });
      return { response: json(200, result.page) };
    }),
    statement: guarded('draw the statement', async (request) => {
      const query = new URL(request.url).searchParams;
      const id = query.get('id');
      const sentence = query.get('sentence');
      if (id === null || id.trim() === '') return refused(400, { field: 'id', message: '"id" is required: the id of the page the sentence stands on' });
      if (sentence === null || sentence.trim() === '') return refused(400, { field: 'sentence', message: '"sentence" is required: the text of the sentence' });
      const asked = query.get('n');
      const turn = asked === null ? 0 : Number(asked);
      if (!Number.isInteger(turn) || turn < 0) return refused(400, { field: 'n', message: `"n" is ${JSON.stringify(asked)}: the turn of the sentence among the sentences of the same text on the page, from 0` });
      const result = await product.statement(id, sentence, turn);
      if (!result.ok) return refused(result.status, { field: 'sentence', message: result.message });
      return { response: json(200, result.statement) };
    }),
    entities: guarded('list the entities', async (request) => {
      const query = new URL(request.url).searchParams;
      const kind = query.get('kind');
      if (kind === null || kind === '') return refused(400, { field: 'kind', message: '"kind" is required: a kind the manifest declares' });
      const asked = query.get('limit');
      const limit = asked === null ? 100 : Number(asked);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) return refused(400, { field: 'limit', accepted: '1 to 500', message: `"limit" is ${JSON.stringify(asked)}: a page holds 1 to 500 entities` });
      const listing = await product.list(kind, { ...(query.get('q') === null ? {} : { q: query.get('q')! }), ...(query.get('after') === null ? {} : { after: query.get('after')! }), limit });
      if (listing === undefined) return refused(404, { field: 'kind', message: `the manifest declares no kind "${kind}"` });
      return { response: json(200, listing) };
    }),
    neighborhood: guarded('read the neighbourhood', async (request) => {
      const query = new URL(request.url).searchParams;
      const id = query.get('id');
      if (id === null || id.trim() === '') return refused(400, { field: 'id', message: '"id" is required: the key or id of the entity whose neighbours are asked for' });
      const direction = query.get('direction');
      if (direction !== null && direction !== 'out' && direction !== 'in') return refused(400, { field: 'direction', accepted: 'out or in', message: `"direction" is ${JSON.stringify(direction)}: the neighbours that go out of the entity (out) or come in to it (in)` });
      const asked = query.get('limit');
      const limit = asked === null ? 8 : Number(asked);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return refused(400, { field: 'limit', accepted: '1 to 100', message: `"limit" is ${JSON.stringify(asked)}: a node opens 1 to 100 neighbours per relation` });
      const result = await product.neighborhood(id, { ...(query.get('relation') === null ? {} : { relation: query.get('relation')! }), ...(direction === null ? {} : { direction }), limit });
      if (!result.ok) return refused(result.status, { field: 'id', message: result.message });
      return { response: json(200, result.neighborhood) };
    }),
    source: guarded('read the source', async (request) => {
      const query = new URL(request.url).searchParams;
      const path = query.get('path');
      const repo = query.get('repo');
      if (path === null || path === '') return refused(400, { field: 'path', message: '"path" is required: the file, relative to its repository' });
      if (path.startsWith('/') || path.includes('\0') || path.split('/').includes('..')) {
        return refused(400, { field: 'path', message: `"${path}" is not a path inside a repository` });
      }
      const read = await product.source(repo === null || repo === '' ? null : repo, path);
      if (read === undefined) return refused(404, { field: 'path', message: `the file ${path} is not in ${repo === null || repo === '' ? 'the product repository' : `the repository ${repo}`} at the commit the graph was filled from` });
      if (Buffer.byteLength(read.text) > SOURCE_VIEW_BYTES) return refused(413, { field: 'path', message: `the file ${path} is ${Buffer.byteLength(read.text)} bytes, past the ${SOURCE_VIEW_BYTES} the source view shows` });
      return { response: json(200, { repo: repo === '' ? null : repo, path, language: languageOf(path), commit: read.commit, text: read.text }) };
    }),
    fill: guarded('start the fill', async (request) => {
      const crossSite = foreign(request);
      if (crossSite !== undefined) return refused(403, { message: crossSite });
      // The press names the agent it was made for, so a choice saved from another tab meanwhile is not run under this press's consent.
      let expectAgent: string | null | undefined;
      let language: string | undefined;
      if (request.headers.get('content-type')?.includes('application/json')) {
        let body: unknown;
        try { body = await request.json(); } catch (error) { return refused(400, { message: `the request body is not JSON: ${(error as Error).message}` }); }
        const asked = (body as { agent?: unknown } | null)?.agent;
        if (asked !== undefined && asked !== null && typeof asked !== 'string') return refused(400, { field: 'agent', message: '"agent" is the id of the agent the press was made for, or null for none' });
        expectAgent = asked as string | null | undefined;
        const chosenLanguage = (body as { language?: unknown } | null)?.language;
        if (chosenLanguage !== undefined && typeof chosenLanguage !== 'string') return refused(400, { field: 'language', message: '"language" is the language the pages are written in: en or ru' });
        language = chosenLanguage as string | undefined;
      }
      const started = await product.startFill({ ...(expectAgent === undefined ? {} : { expectAgent }), ...(language === undefined ? {} : { language }) });
      if (!started.started) return refused(409, { message: started.message });
      return { response: json(202, { fill: started.fill }) };
    }),
    agents: guarded('list the agents', async () => ({ response: json(200, { agents: product.agentOffers(), chosen: product.chosenAgent() }) })),
    chooseAgent: guarded('choose the agent', async (request) => {
      const crossSite = foreign(request);
      if (crossSite !== undefined) return refused(403, { message: crossSite });
      let body: unknown;
      try { body = await request.json(); } catch (error) { return refused(400, { message: `the request body is not JSON: ${(error as Error).message}` }); }
      const asked = body as { agent?: unknown; install?: unknown };
      if (typeof asked !== 'object' || asked === null || (asked.agent !== null && typeof asked.agent !== 'string')) return refused(400, { field: 'agent', message: '"agent" is required: claude-code, codex, or null for no agent' });
      const chosen = await product.chooseAgent(asked.agent, asked.install === true);
      if (!chosen.ok) return refused(chosen.status, { field: 'agent', message: chosen.message });
      return { response: json(200, { chosen: chosen.agent }) };
    }),
    documents: guarded('list the documents', async () => ({ response: json(200, await product.documents()) })),
    document: guarded('read the document', async (request) => {
      const query = new URL(request.url).searchParams;
      const path = query.get('path');
      const repo = query.get('repo');
      if (path === null || path === '') return refused(400, { field: 'path', message: '"path" is required: the Markdown document, relative to its repository' });
      if (path.startsWith('/') || path.includes('\0') || path.split('/').includes('..')) return refused(400, { field: 'path', message: `"${path}" is not a path inside a repository` });
      const page = await product.document(repo === null || repo === '' ? null : repo, path);
      if (page === undefined) return refused(404, { field: 'path', message: `the Markdown document ${path} is not in ${repo === null || repo === '' ? 'the product repository' : `the repository ${repo}`} at the commit the graph was filled from` });
      return { response: json(200, page) };
    }),
    reset: guarded('start over', async (request) => {
      const crossSite = foreign(request);
      if (crossSite !== undefined) return refused(403, { message: crossSite });
      // A GET asks what a reset would remove and keep; a POST does it.
      if (request.method === 'GET') return { response: json(200, product.resetPlan()) };
      const done = await product.reset();
      if (!done.ok) return refused(409, { message: done.message });
      return { response: json(200, done.plan) };
    }),
    products: guarded('list the products', async () => ({ response: json(200, { current: product.folder, products: siblings() }) })),
  };
}
