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
import { LoopRefusal } from '../loop/answer.js';
import { WikiReadError, type KnowledgeProduct } from '../knowledge/product.js';
import type { Handled, ReplyMaker } from './http.js';
import { CHOOSABLE_ROLES, readSettings, writeRole } from '../knowledge/settings.js';
import type { DraftEnv } from '../product/home.js';

export interface KnowledgePart {
  /** Who the product is, read from its manifest alone: it answers before the graph store is open. */
  identity: (request: Request) => Promise<Handled>;
  status: (request: Request) => Promise<Handled>;
  page: (request: Request) => Promise<Handled>;
  block: (request: Request) => Promise<Handled>;
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
  glossary: (request: Request) => Promise<Handled>;
  settings: (request: Request) => Promise<Handled>;
  questions: (request: Request) => Promise<Handled>;
  question: (request: Request) => Promise<Handled>;
  answer: (request: Request) => Promise<Handled>;
  correction: (request: Request) => Promise<Handled>;
  problems: (request: Request) => Promise<Handled>;
  refreshPlan: (request: Request) => Promise<Handled>;
  productSettings: (request: Request) => Promise<Handled>;
  agentChoices: (request: Request) => Promise<Handled>;
  starter: (request: Request) => Promise<Handled>;
  rewritePages: (request: Request) => Promise<Handled>;
  startFresh: (request: Request) => Promise<Handled>;
  journal: (request: Request) => Promise<Handled>;
}

/** The largest file the source view shows whole. */
export const SOURCE_VIEW_BYTES = 2 * 1024 * 1024;

/** A write that is not JSON could be a form another site posted without a preflight: refused. */
function notJson(request: Request): string | undefined {
  return request.headers.get('content-type')?.toLowerCase().includes('application/json') === true ? undefined : 'the request body is JSON and says so (content-type: application/json)';
}

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
  /** The environment the user's settings are found by (the madarch home); the process's own when left out. */
  env: DraftEnv = process.env,
  /** madarch's own wiki (decision 0031): it is documentation, so its status says so and the app offers no fill. */
  own = false,
): KnowledgePart {
  const { json, refused, errorLog } = makers;
  const guarded = (what: string, work: (request: Request) => Promise<Handled>) => async (request: Request): Promise<Handled> => {
    try {
      return await work(request);
    } catch (error) {
      if (error instanceof LoopRefusal) return refused(error.status, { message: error.message });
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
    status: guarded('read the product', async () => ({ response: json(200, own ? { ...(await product.status()), own: true } : await product.status()) })),
    page: guarded('draw the page', async (request) => {
      const id = new URL(request.url).searchParams.get('id');
      if (id === null || id.trim() === '') return refused(400, { field: 'id', message: '"id" is required: the key or id of the entity whose page is asked for' });
      const asked = new URL(request.url).searchParams.get('lang');
      // The diagrams read the graph at length: the page answers at once with a place for each (`deferred`), and the app asks
      // for each by its line (`/api/k/block`). `full=1` asks for the whole page in one answer.
      const result = await product.page(id, asked === 'ru' || asked === 'en' ? asked : undefined, { defer: new URL(request.url).searchParams.get('full') !== '1' });
      if (!result.ok) return refused(result.status, { field: 'id', message: result.message });
      return { response: json(200, result.page) };
    }),
    block: guarded('draw the block', async (request) => {
      const query = new URL(request.url).searchParams;
      const id = query.get('id');
      if (id === null || id.trim() === '') return refused(400, { field: 'id', message: '"id" is required: the key or id of the entity whose page holds the block' });
      const line = Number(query.get('line'));
      if (!Number.isInteger(line) || line < 1) return refused(400, { field: 'line', message: `"line" is ${JSON.stringify(query.get('line'))}: the line of the block in the page's template, a whole number from 1` });
      const asked = query.get('lang');
      const result = await product.block(id, line, asked === 'ru' || asked === 'en' ? asked : undefined);
      if (!result.ok) return refused(result.status, { field: 'id', message: result.message });
      return { response: json(200, result.block) };
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
      if (own) return refused(409, { message: "madarch's own wiki is documentation: it has no code to read and no pages for an agent to write" });
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
    glossary: guarded('read the glossary', async () => ({ response: json(200, await product.glossary()) })),
    settings: guarded('read the settings', async (request) => {
      // The settings file is the user's, outside any product: a failure on it is told whole, with its path.
      const settled = <T>(work: () => T): T => { try { return work(); } catch (error) { throw new WikiReadError((error as Error).message); } };
      if (request.method === 'GET') return { response: json(200, { ...settled(() => readSettings(env)), roles: CHOOSABLE_ROLES }) };
      const crossSite = foreign(request);
      if (crossSite !== undefined) return refused(403, { message: crossSite });
      let body: unknown;
      try { body = await request.json(); } catch (error) { return refused(400, { message: `the request body is not JSON: ${(error as Error).message}` }); }
      const role = (body as { role?: unknown } | null)?.role;
      if (typeof role !== 'string' || !CHOOSABLE_ROLES.includes(role)) return refused(400, { field: 'role', accepted: CHOOSABLE_ROLES.join(', '), message: `"role" is ${JSON.stringify(role)}: the roles are ${CHOOSABLE_ROLES.join(', ')}` });
      return { response: json(200, { ...settled(() => writeRole(env, role)), roles: CHOOSABLE_ROLES }) };
    }),
    reset: guarded('start over', async (request) => {
      const crossSite = foreign(request);
      if (crossSite !== undefined) return refused(403, { message: crossSite });
      if (own) return refused(403, { message: "madarch's own wiki is documentation, not a product to start over: its pages are not rewritten here" });
      // A GET asks what a reset would remove and keep; a POST does it.
      if (request.method === 'GET') return { response: json(200, product.resetPlan()) };
      const done = await product.reset();
      if (!done.ok) return refused(409, { message: done.message });
      return { response: json(200, done.plan) };
    }),
    questions: guarded('list the questions', async () => ({ response: json(200, product.questions()) })),
    question: guarded('read the question', async (request) => {
      const id = new URL(request.url).searchParams.get('id');
      if (id === null || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(id)) return refused(400, { field: 'id', message: '"id" is required: a question\'s id, lower-case words joined by hyphens' });
      const detail = await product.question(id);
      if (detail === undefined) return refused(404, { field: 'id', message: `there is no question ${id}: docs/questions/${id}.md is not in the product repository` });
      return { response: json(200, detail) };
    }),
    answer: guarded('save the answer', async (request) => {
      const crossSite = foreign(request);
      if (crossSite !== undefined) return refused(403, { message: crossSite });
      const plain = notJson(request);
      if (plain !== undefined) return refused(415, { message: plain });
      let body: unknown;
      try { body = await request.json(); } catch (error) { return refused(400, { message: `the request body is not JSON: ${(error as Error).message}` }); }
      const asked = body as { question?: unknown; text?: unknown } | null;
      if (typeof asked?.question !== 'string') return refused(400, { field: 'question', message: '"question" is required: the id of the question being answered' });
      if (typeof asked.text !== 'string') return refused(400, { field: 'text', message: '"text" is required: the answer' });
      const done = await product.answer(asked.question, asked.text);
      return { response: json(200, { question: done.question.slug, state: 'answered', committed: done.committed, ...(done.commit === undefined ? {} : { commit: done.commit }), ...(done.note === undefined ? {} : { note: done.note }), by: done.question.answer!.by, at: done.question.answer!.at }) };
    }),
    correction: guarded('save the correction', async (request) => {
      const crossSite = foreign(request);
      if (crossSite !== undefined) return refused(403, { message: crossSite });
      const plain = notJson(request);
      if (plain !== undefined) return refused(415, { message: plain });
      let body: unknown;
      try { body = await request.json(); } catch (error) { return refused(400, { message: `the request body is not JSON: ${(error as Error).message}` }); }
      const asked = body as { statement?: unknown; reason?: unknown } | null;
      if (typeof asked?.statement !== 'string') return refused(400, { field: 'statement', message: '"statement" is required: <page id>#<statement name>, such as domain:payments#refund-check' });
      if (typeof asked.reason !== 'string') return refused(400, { field: 'reason', message: '"reason" is required: why the statement is wrong' });
      const done = await product.correct(asked.statement, asked.reason);
      return { response: json(201, { correction: done.correction.slug, id: done.correction.id, file: done.correction.file, committed: done.committed, ...(done.commit === undefined ? {} : { commit: done.commit }), ...(done.note === undefined ? {} : { note: done.note }), by: done.correction.by, at: done.correction.at }) };
    }),
    problems: guarded('list the problems', async () => ({ response: json(200, await product.problems()) })),
    refreshPlan: guarded('plan the refresh', async (request) => {
      const language = new URL(request.url).searchParams.get('language');
      if (language !== null && language !== 'en' && language !== 'ru') return refused(400, { field: 'language', message: `"language" is en or ru, got ${JSON.stringify(language)}` });
      return { response: json(200, await product.refreshPlan(language ?? undefined)) };
    }),
    productSettings: guarded('read the product settings', async (request) => {
      if (request.method === 'GET') return { response: json(200, { ...product.settingsView(), ...(own ? { own: true } : {}) }) };
      const crossSite = foreign(request);
      if (crossSite !== undefined) return refused(403, { message: crossSite });
      if (own) return refused(403, { message: "madarch's own wiki is documentation: it has no agent, no pages to write and no settings of a product" });
      const plain = notJson(request);
      if (plain !== undefined) return refused(415, { message: plain });
      let body: unknown;
      try { body = await request.json(); } catch (error) { return refused(400, { message: `the request body is not JSON: ${(error as Error).message}` }); }
      const asked = body as { language?: unknown; model?: unknown; reasoning?: unknown } | null;
      if (asked === null || typeof asked !== 'object') return refused(400, { message: 'the body is { language?, model?, reasoning? }' });
      for (const field of ['model', 'reasoning'] as const) {
        const value = asked[field];
        if (value !== undefined && value !== null && typeof value !== 'string') return refused(400, { field, message: `"${field}" is a value the agent reports, or null for the agent's own` });
      }
      if (asked.language !== undefined) {
        if (typeof asked.language !== 'string') return refused(400, { field: 'language', message: '"language" is the language the pages are written in: en or ru' });
        const saved = product.setLanguage(asked.language);
        if (!saved.ok) return refused(409, { field: 'language', message: saved.message });
      }
      if (asked.model !== undefined || asked.reasoning !== undefined) {
        const chosen = await product.chooseModel(asked.model as string | null | undefined, asked.reasoning as string | null | undefined);
        if (!chosen.ok) return refused(chosen.status, { message: chosen.message });
      }
      return { response: json(200, product.settingsView()) };
    }),
    agentChoices: guarded('ask the agent for its models', async (request) => {
      // Asking starts the agent's adapter on this machine: only this wiki's own page may.
      const crossSite = foreign(request);
      if (crossSite !== undefined) return refused(403, { message: crossSite });
      const answer = await product.agentChoices(new URL(request.url).searchParams.get('fresh') === '1');
      if (!answer.ok) return refused(409, { message: answer.message });
      return { response: json(200, answer) };
    }),
    starter: guarded('add to the manifest', async (request) => {
      const crossSite = foreign(request);
      if (crossSite !== undefined) return refused(403, { message: crossSite });
      if (own) return refused(403, { message: "madarch's own wiki is documentation: its manifest is not changed here" });
      const plain = notJson(request);
      if (plain !== undefined) return refused(415, { message: plain });
      let body: unknown;
      try { body = await request.json(); } catch (error) { return refused(400, { message: `the request body is not JSON: ${(error as Error).message}` }); }
      const ids = (body as { ids?: unknown } | null)?.ids;
      if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string')) return refused(400, { field: 'ids', message: '"ids" is the list of items of the starter set to add, as the Problems page names them' });
      const done = product.addStarter(ids as string[]);
      if (!done.ok) return refused(409, { field: 'ids', message: done.message });
      return { response: json(200, { written: done.written }) };
    }),
    rewritePages: guarded('rewrite the pages', async (request) => {
      const crossSite = foreign(request);
      if (crossSite !== undefined) return refused(403, { message: crossSite });
      if (own) return refused(403, { message: "madarch's own wiki is documentation, not a product to rewrite: its pages are not written here" });
      const done = await product.rewritePages();
      if (!done.ok) return refused(409, { message: done.message });
      return { response: json(202, { plan: done.plan, fill: done.fill }) };
    }),
    startFresh: guarded('start from scratch', async (request) => {
      const crossSite = foreign(request);
      if (crossSite !== undefined) return refused(403, { message: crossSite });
      if (own) return refused(403, { message: "madarch's own wiki is documentation, not a product to start from scratch: its pages are not rewritten here" });
      const done = await product.startFresh();
      if (!done.ok) return refused(409, { message: done.message });
      return { response: json(202, done) };
    }),
    journal: guarded('read the agent journal', async (request) => {
      const query = new URL(request.url).searchParams;
      const id = query.get('id');
      if (id === null || id.trim() === '') return refused(400, { field: 'id', message: '"id" is required: the id of the page an agent wrote (product:<slug> or domain:<slug>)' });
      const run = query.get('run');
      if (run !== null && !/^run-[A-Za-z0-9-]+$/.test(run)) return refused(400, { field: 'run', message: `"run" is a run id like run-20261023T120000000Z-ab12, got ${JSON.stringify(run)}` });
      try {
        return { response: json(200, product.journalOf(id, run ?? undefined)) };
      } catch (error) {
        if (error instanceof WikiReadError) return refused(400, { field: 'id', message: error.message });
        throw error;
      }
    }),
    products: guarded('list the products', async () => ({ response: json(200, { current: product.folder, products: siblings() }) })),
  };
}
