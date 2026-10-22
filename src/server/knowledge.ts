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
import type { KnowledgeProduct } from '../knowledge/product.js';
import type { Handled, ReplyMaker } from './http.js';

export interface KnowledgePart {
  status: (request: Request) => Promise<Handled>;
  page: (request: Request) => Promise<Handled>;
  entities: (request: Request) => Promise<Handled>;
  source: (request: Request) => Promise<Handled>;
  fill: (request: Request) => Promise<Handled>;
  agents: (request: Request) => Promise<Handled>;
  chooseAgent: (request: Request) => Promise<Handled>;
  products: (request: Request) => Promise<Handled>;
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
      errorLog(`the knowledge wiki could not ${what}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      return refused(500, { message: `the wiki could not ${what}; the cause is in the server's log` });
    }
  };
  return {
    status: guarded('read the product', async () => ({ response: json(200, await product.status()) })),
    page: guarded('draw the page', async (request) => {
      const id = new URL(request.url).searchParams.get('id');
      if (id === null || id.trim() === '') return refused(400, { field: 'id', message: '"id" is required: the key or id of the entity whose page is asked for' });
      const result = await product.page(id);
      if (!result.ok) return refused(result.status, { field: 'id', message: result.message });
      return { response: json(200, result.page) };
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
      if (request.headers.get('content-type')?.includes('application/json')) {
        let body: unknown;
        try { body = await request.json(); } catch (error) { return refused(400, { message: `the request body is not JSON: ${(error as Error).message}` }); }
        const asked = (body as { agent?: unknown } | null)?.agent;
        if (asked !== undefined && asked !== null && typeof asked !== 'string') return refused(400, { field: 'agent', message: '"agent" is the id of the agent the press was made for, or null for none' });
        expectAgent = asked as string | null | undefined;
      }
      const started = await product.startFill(expectAgent === undefined ? {} : { expectAgent });
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
    products: guarded('list the products', async () => ({ response: json(200, { current: product.folder, products: siblings() }) })),
  };
}
