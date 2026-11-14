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
import { here } from '../model/raise.js';
import { AuthoredRefusal } from '../graph/authored.js';
import type { ResetPlan } from '../knowledge/reset.js';
import { LoopRefusal } from '../loop/answer.js';
import { WikiReadError, type KnowledgeProduct } from '../knowledge/product.js';
import type { Handled, ReplyMaker } from './http.js';
import { choosableRoles, readSettings, writeRole } from '../knowledge/settings.js';
import { readKinds } from '../product/manifest/kinds.js';
import { readFillTargets } from '../knowledge/fill-targets.js';
import { MAX_EDITORIAL_REQUESTS } from '../writer/editorial.js';
import type { DraftEnv } from '../product/home.js';
import { manifestPublicationState } from '../product/manifest-publication-state.js';

export interface KnowledgePart {
  /** Who the product is, read from its manifest alone: it answers before the graph store is open. */
  identity: (request: Request) => Promise<Handled>;
  /** The product's GraphQL schema (decision 0036): the SDL its published manifest derives, as `application/graphql`. */
  graphqlSchema: (request: Request) => Promise<Handled>;
  /** One GraphQL operation against the product's graph (decision 0036, section 2): the one read API a page uses. */
  graphql: (request: Request) => Promise<Handled>;
  /** The authored writes (section 8: creating, updating and deleting a person's entity is a command, not a read). */
  authored: (request: Request) => Promise<Handled>;
  status: (request: Request) => Promise<Handled>;
  /** What the agent spent on one kind: per run, plugin run, field and model (madarch-stm0.4, decision 0035, item 22). */
  kindUsage: (request: Request) => Promise<Handled>;
  source: (request: Request) => Promise<Handled>;
  /** The newest run's trace as the run page states it: per step its time, its memory and its names. */
  run: (request: Request) => Promise<Handled>;
  fill: (request: Request) => Promise<Handled>;
  /** Starts the fill page’s selected kinds, with their dependencies in order. */
  fillSelected: (request: Request) => Promise<Handled>;
  fillRuns: (request: Request) => Promise<Handled>;
  /** A person's «Пауза»: the page and the commit in progress are finished, and the run ends before the next one. */
  pause: (request: Request) => Promise<Handled>;
  /** A person's «Остановить»: the run ends now; the body's `confirm` is the second press that ends it. */
  stop: (request: Request) => Promise<Handled>;
  agents: (request: Request) => Promise<Handled>;
  chooseAgent: (request: Request) => Promise<Handled>;
  products: (request: Request) => Promise<Handled>;
  reset: (request: Request) => Promise<Handled>;
  settings: (request: Request) => Promise<Handled>;
  answer: (request: Request) => Promise<Handled>;
  correction: (request: Request) => Promise<Handled>;
  problemDismiss: (request: Request) => Promise<Handled>;
  problemTask: (request: Request) => Promise<Handled>;
  refreshPlan: (request: Request) => Promise<Handled>;
  productSettings: (request: Request) => Promise<Handled>;
  agentChoices: (request: Request) => Promise<Handled>;
  /** Assigns one model role to an (agent, model) pair, or removes it (madarch-j6ho.2). */
  modelRole: (request: Request) => Promise<Handled>;
  /** The graph verdict coverage and rows, or the two budgets a run may spend (madarch-mwhd.1). */
  graphVerdicts: (request: Request) => Promise<Handled>;
  rewritePages: (request: Request) => Promise<Handled>;
  startFresh: (request: Request) => Promise<Handled>;
  journal: (request: Request) => Promise<Handled>;
  proposeTask: (request: Request) => Promise<Handled>;
  createTask: (request: Request) => Promise<Handled>;
  closeTask: (request: Request) => Promise<Handled>;
  runTask: (request: Request) => Promise<Handled>;
}

/** The languages the source view names a file by, from its extension; a file it does not know is plain text. */
const SOURCE_LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', mjs: 'javascript', go: 'go', sql: 'sql', json: 'json', yaml: 'yaml', yml: 'yaml',
  md: 'markdown', proto: 'protobuf', prisma: 'prisma', sh: 'shell', toml: 'toml', mod: 'go',
};

/** The language of a source file, for the highlighting its view uses. */
function languageOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (name === 'Dockerfile' || name.startsWith('Dockerfile.')) return 'dockerfile';
  if (name === 'Makefile') return 'makefile';
  return SOURCE_LANGUAGES[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? 'text';
}

/** The largest file the source view shows whole. */
const SOURCE_VIEW_BYTES = 2 * 1024 * 1024;

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
  const guarded = (what: string, work: (request: Request) => Promise<Handled>, needsPublication = true, allowPending = false) => async (request: Request): Promise<Handled> => {
    try {
      const publication = manifestPublicationState(product.folder);
      // Identity and product selection read no catalogue or schema and remain available during startup.
      if (needsPublication && publication !== undefined && publication.status !== 'published' && !(allowPending && publication.status === 'pending')) {
        const response = json(503, {
          publication: publication.status,
          message: publication.status === 'pending'
            ? `${here()}: The catalogue is being published. Please wait; no catalogue is available yet.`
            : `${here()}: The catalogue could not be published: ${publication.message}`,
        });
        response.headers.set('cache-control', 'no-store');
        if (publication.status === 'pending') response.headers.set('retry-after', '1');
        return { response };
      }
      return await work(request);
    } catch (error) {
      if (error instanceof AuthoredRefusal) return refused(error.status, { message: error.message, ...(error.field === undefined ? {} : { field: error.field }), ...('conflict' in error && error.conflict !== undefined ? { conflict: error.conflict as { field: string; current: unknown; author: string } } : {}) });
      if (error instanceof LoopRefusal) return refused(error.status, { message: error.message });
      if (error instanceof WikiReadError) {
        errorLog(`the knowledge wiki could not ${what}: ${error.message}`);
        return refused(500, { message: error.message });
      }
      errorLog(`the knowledge wiki could not ${what}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      return refused(500, { message: `${here()}: the wiki could not ${what}; the cause is in the server's log` });
    }
  };
  /**
 * The body of a fill press: the kinds checked and run-scoped agent and cap options. Every kind is one
 * the manifest declares — a name the manifest does not hold is refused by name with the kinds it does, never dropped —
 * the agent is a string or null, and the cap is a whole number of tokens, 1 or more, or null for no cap.
 */
  async function selectionBody(request: Request): Promise<
    | { readonly selection: { readonly selected: readonly string[]; readonly agent: string | null; readonly tokenCap: number | null } }
  | { readonly bad: Handled }
> {
  const plain = notJson(request);
  if (plain !== undefined) return { bad: refused(415, { message: `${here()}: ${plain}` }) };
  let body: unknown;
  try { body = await request.json(); } catch (error) { return { bad: refused(400, { message: `${here()}: the request body is not JSON: ${(error as Error).message}` }) }; }
  const asked = body as { selected?: unknown; agent?: unknown; tokenCap?: unknown } | null;
  if (asked === null || typeof asked !== 'object') return { bad: refused(400, { message: `${here()}: the body is { selected: [kind...], agent?, tokenCap? }` }) };
  const selected = asked.selected;
  if (!Array.isArray(selected) || selected.some((kind) => typeof kind !== 'string' || kind.trim() === '')) {
    return { bad: refused(400, { field: 'selected', message: `${here()}: "selected" is the list of entity kinds the catalogue has checked, each a kind of the product's manifest` }) };
  }
  if (asked.agent !== undefined && asked.agent !== null && typeof asked.agent !== 'string') {
    return { bad: refused(400, { field: 'agent', message: `${here()}: "agent" is the id of the agent the panel chose, or null for none` }) };
  }
  if (asked.tokenCap !== undefined && asked.tokenCap !== null && (typeof asked.tokenCap !== 'number' || !Number.isInteger(asked.tokenCap) || asked.tokenCap < 1)) {
    return { bad: refused(400, { field: 'tokenCap', message: `${product.folder}/madarch/catalog.yaml:1: token cap must be a positive integer` }) };
  }
  return { selection: { selected: (selected as string[]).map((kind) => kind.trim()), agent: (asked.agent as string | null | undefined) ?? null, tokenCap: (asked.tokenCap as number | null | undefined) ?? null } };
}


  return {
    graphqlSchema: guarded('read the GraphQL schema', async () => ({
      response: new Response(await product.graphqlSchema(), { headers: { 'content-type': 'application/graphql; charset=utf-8' } }),
    }), false),
    graphql: guarded('run a GraphQL query', async (request) => {
      if (request.method !== 'POST') return refused(405, { message: `${import.meta.path}:1: a GraphQL operation is sent with POST` });
      const plain = notJson(request);
      if (plain !== undefined) return refused(415, { message: `${import.meta.path}:1: ${plain}` });
      let body: unknown;
      try { body = await request.json(); } catch { return refused(400, { message: `${import.meta.path}:1: the request body must be JSON: { query, variables?, operationName?, lang? }` }); }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return refused(400, { message: `${import.meta.path}:1: the body is { query, variables?, operationName?, lang? }` });
      const held = body as Record<string, unknown>;
      if (typeof held['query'] !== 'string' || held['query'].trim() === '') return refused(400, { field: 'query', message: `${import.meta.path}:1: "query" is the GraphQL operation's text` });
      if (held['variables'] !== undefined && held['variables'] !== null && (typeof held['variables'] !== 'object' || Array.isArray(held['variables']))) return refused(400, { field: 'variables', message: `${import.meta.path}:1: "variables" is an object of the operation's variables` });
      if (held['operationName'] !== undefined && held['operationName'] !== null && typeof held['operationName'] !== 'string') return refused(400, { field: 'operationName', message: `${import.meta.path}:1: "operationName" is the name of the operation to run, or null` });
      if (held['lang'] !== undefined && typeof held['lang'] !== 'string') return refused(400, { field: 'lang', message: `${import.meta.path}:1: "lang" is the reader's interface language` });
      const answer = await product.graphql({
        query: held['query'],
        ...(held['variables'] === undefined || held['variables'] === null ? {} : { variables: held['variables'] as Readonly<Record<string, unknown>> }),
        ...(held['operationName'] === undefined ? {} : { operationName: held['operationName'] as string | null }),
        ...(held['lang'] === undefined ? {} : { lang: held['lang'] as string }),
      });
      return { response: json(answer.status, answer.body) };
    }),
    authored: guarded('change an authored entity', async (request) => {
      const url = new URL(request.url);
      const kind = url.searchParams.get('kind') ?? '';
      const uid = url.searchParams.get('uid') ?? undefined;
      // The authored *reads* are GraphQL's (section 8); the commands that change an entity are kept.
      const methods = { POST: 'create', PATCH: 'update', DELETE: 'delete' } as const;
      const action = methods[request.method as keyof typeof methods];
      if (action === undefined) return refused(405, { message: `${import.meta.path}:1: the authored write is POST, PATCH or DELETE; an authored entity is read through /graphql` });
      const crossSite = foreign(request);
      if (crossSite !== undefined) return refused(403, { message: `${import.meta.path}:1: ${crossSite}` });
      const plain = notJson(request);
      if (plain !== undefined) return refused(415, { message: `${import.meta.path}:1: ${plain}` });
      let raw: unknown;
      try { raw = await request.json(); } catch { return refused(400, { message: `${import.meta.path}:1: the request body must be JSON` }); }
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return refused(400, { message: `${import.meta.path}:1: the body is {values?, words?}` });
      const held = raw as Record<string, unknown>;
      if (held['words'] !== undefined && typeof held['words'] !== 'string') return refused(422, { field: 'words', message: `${import.meta.path}:1: words must be text, kept verbatim` });
      if (held['values'] !== undefined && (held['values'] === null || typeof held['values'] !== 'object' || Array.isArray(held['values']))) return refused(422, { field: 'values', message: `${import.meta.path}:1: values must be an object keyed by field` });
      const body = { ...(held['words'] === undefined ? {} : { words: held['words'] as string }), ...(held['values'] === undefined ? {} : { values: held['values'] as Readonly<Record<string, unknown>> }) };
      const match = request.headers.get('if-match');
      if (match !== null && !/^"[0-9]+"$/u.test(match)) return refused(400, { field: 'if-match', message: `${import.meta.path}:1: If-Match must contain one quoted entity revision from ETag` });
      const answer = await product.authored(action, kind, { ...body, ...(uid === undefined ? {} : { uid }), ...(match === null ? {} : { ifRevision: match.slice(1, -1) }) });
      const response = json(action === 'create' ? 201 : 200, answer);
      if (answer.entity !== undefined && 'revision' in answer.entity) response.headers.set('ETag', `"${String(answer.entity.revision)}"`);
      return { response };
    }),
    identity: guarded('read the product identity', async () => {
      const identity = product.product();
      if ('message' in identity) throw new WikiReadError(identity.message);
      return { response: json(200, { id: identity.id, name: identity.name }) };
    }, false),
    status: guarded('read the product', async () => ({ response: json(200, own ? { ...(await product.status()), own: true } : await product.status()) }), false),
    kindUsage: guarded('read the kind\'s agent spend', async (request) => {
      const kind = new URL(request.url).searchParams.get('kind');
      if (kind === null || kind.trim() === '') return refused(400, { field: 'kind', message: '"kind" is required: a kind the manifest declares' });
      return { response: json(200, { usage: await product.kindUsage(kind) }) };
    }),
    source: guarded('read the source', async (request) => {
      const query = new URL(request.url).searchParams;
      const path = query.get('path');
      const repo = query.get('repo');
      if (path === null || path === '') return refused(400, { field: 'path', message: '"path" is required: the file, relative to its repository' });
      if (path.startsWith('/') || path.includes('\0') || path.split('/').includes('..')) {
        return refused(400, { field: 'path', message: `"${path}" is not a path inside a repository` });
      }
      // The source view answers the text the graph was filled with, at the commit it was filled from (section 8): a past
      // commit this graph cannot name is refused rather than answered with the current tree's bytes.
      if (query.has('at')) return refused(409, { field: 'at', message: `historical source is not covered: this graph holds the text of the commit it was filled from, and no other` });
      const read = await product.source(repo === null || repo === '' ? null : repo, path);
      if (read === undefined) return refused(404, { field: 'path', message: `the file ${path} is not in ${repo === null || repo === '' ? 'the product repository' : `the repository ${repo}`} at the commit the graph was filled from` });
      // A past commit's text the graph cannot name is a 404 that says why, never the current tree's bytes under that commit's name.
      if ('absent' in read) return refused(404, { field: 'path', message: read.absent });
      if (Buffer.byteLength(read.text) > SOURCE_VIEW_BYTES) return refused(413, { field: 'path', message: `the file ${path} is ${Buffer.byteLength(read.text)} bytes, past the ${SOURCE_VIEW_BYTES} the source view shows` });
      return { response: json(200, { repo: repo === '' ? null : repo, path, language: languageOf(path), commit: read.commit, text: read.text }) };
    }),
    run: guarded('read the run', async (request) => {
      const query = new URL(request.url).searchParams;
      const runId = query.get('run');
      const run = await product.runView(runId === null || runId === '' ? undefined : runId);
      if (run === null) return refused(404, { message: 'src/server/knowledge.ts:356: the store holds no such fill run' });
      return { response: json(200, { run }) };
    }),
    fill: guarded('start the fill', async (request) => {
      const crossSite = foreign(request);
      if (crossSite !== undefined) return refused(403, { message: crossSite });
      // madarch's own wiki is documentation, but it is a product repository: its own files are read by a fill, and its pages
      // are the graph's (madarch-hsqs stage C). It has no code repository and no agent stage, so the fill reads its files only.
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
    }, true, true),
    fillRuns: guarded('read fill history', async (request) => {
      const runId = new URL(request.url).searchParams.get('run');
      const runs = await product.fillRuns(runId ?? undefined);
      if (runId !== null && runs.length === 0) return refused(404, { message: `${here()}: this product holds no run ${JSON.stringify(runId)}` });
      return { response: json(200, runId === null ? { runs } : { run: runs[0] }) };
    }),
    fillSelected: guarded('fill the selected entities', async (request) => {
      const crossSite = foreign(request); if (crossSite !== undefined) return refused(403, { message: `${here()}: ${crossSite}` });
      if (own) return refused(409, { message: `${here()}: madarch's own wiki is documentation: it has no code to read and no entities of a product to fill` });
      const asked = await selectionBody(request);
      if ('bad' in asked) return asked.bad;
      const kinds = readKinds(product.folder);
      if (!kinds.present) return refused(409, { message: `${kinds.file}:1: the product has no kinds manifest: the catalogue shows the kinds that file declares` });
      const targets = readFillTargets(kinds.manifest, { entities: asked.selection.selected });
      if (!targets.ok) return refused(400, { field: 'selected', message: targets.message });
      const started = await product.startFill({ selected: asked.selection.selected, agent: asked.selection.agent, ...(asked.selection.tokenCap === null ? {} : { tokenCap: asked.selection.tokenCap }), targets: { kinds: targets.targets.order, ...(targets.targets.vertex === undefined ? {} : { vertex: targets.targets.vertex }) } });
      if (!started.started) return refused(409, { message: started.message });
      return { response: json(202, { runId: started.runId, fill: started.fill, order: targets.targets.order }) };
    }, true, true),
    pause: guarded('pause the fill', async (request) => {
      const crossSite = foreign(request);
      if (crossSite !== undefined) return refused(403, { message: `${here()}: ${crossSite}` });
      if (own) return refused(409, { message: `${here()}: madarch's own wiki is documentation: there is no run to pause` });
      const runId = new URL(request.url).searchParams.get('run');
      if (runId !== null) {
        if (runId.trim() === '') return refused(400, { field: 'run', message: `${here()}: run must name one fill run` });
        const controlled = await product.controlFillRun(runId, 'pause');
        if (!controlled.ok) return refused(controlled.status, { message: controlled.message });
        return { response: json(200, controlled) };
      }
      const paused = await product.pauseRun();
      if (!paused.ok) return refused(paused.status, { message: paused.message });
      return { response: json(200, { fill: paused.fill, writer: paused.writer }) };
    }),
    stop: guarded('stop the fill', async (request) => {
      const crossSite = foreign(request);
      if (crossSite !== undefined) return refused(403, { message: `${here()}: ${crossSite}` });
      if (own) return refused(409, { message: `${here()}: madarch's own wiki is documentation: there is no run to stop` });
      // The second press confirms: the first answer counts the pages this run rewrote and says that they stay.
      let confirm = false;
      if (request.headers.get('content-type')?.includes('application/json')) {
        let body: unknown;
        try { body = await request.json(); } catch (error) { return refused(400, { message: `${here()}: the request body is not JSON: ${(error as Error).message}` }); }
        const asked = (body as { confirm?: unknown } | null)?.confirm;
        if (asked !== undefined && typeof asked !== 'boolean') return refused(400, { field: 'confirm', message: `${here()}: "confirm" is true for the press that ends the run: the answer to the first press names the pages it keeps` });
        confirm = asked === true;
      }
      const runId = new URL(request.url).searchParams.get('run');
      if (runId !== null) {
        if (runId.trim() === '') return refused(400, { field: 'run', message: `${here()}: run must name one fill run` });
        if (!confirm) return refused(409, { field: 'confirm', message: `${here()}: stopping this run requires confirm: true; its published records stay` });
        const controlled = await product.controlFillRun(runId, 'stop');
        if (!controlled.ok) return refused(controlled.status, { message: controlled.message });
        return { response: json(200, controlled) };
      }
      const stopped = await product.stopRun({ confirm });
      if (!stopped.ok) return refused(stopped.status, { message: stopped.message });
      return { response: json(200, { fill: stopped.fill, writer: stopped.writer }) };
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
    settings: guarded('read the settings', async (request) => {
      // The settings file is the user's, outside any product: a failure on it is told whole, with its path.
      const settled = <T>(work: () => T): T => { try { return work(); } catch (error) { throw new WikiReadError((error as Error).message); } };
      // The roles are the product's own: the manifest declares them, the engine keeps none.
      const roles = choosableRoles(await product.declaredRoles());
      if (request.method === 'GET') return { response: json(200, { ...settled(() => readSettings(env, roles)), roles }) };
      const crossSite = foreign(request);
      if (crossSite !== undefined) return refused(403, { message: crossSite });
      let body: unknown;
      try { body = await request.json(); } catch (error) { return refused(400, { message: `the request body is not JSON: ${(error as Error).message}` }); }
      const role = (body as { role?: unknown } | null)?.role;
      if (typeof role !== 'string' || !roles.includes(role)) return refused(400, { field: 'role', accepted: roles.join(', '), message: `"role" is ${JSON.stringify(role)}: the roles are ${roles.join(', ')}` });
      return { response: json(200, { ...settled(() => writeRole(env, role, roles)), roles }) };
    }),
    reset: guarded('start over', async (request) => {
      const crossSite = foreign(request);
      if (crossSite !== undefined) return refused(403, { message: `${product.folder}:1: ${crossSite}` });
      if (own) return refused(403, { message: `${product.folder}:1: madarch's own wiki is documentation, not a product to start over: its pages are not rewritten here` });
      // A GET asks what a reset would remove and keep; a POST does it.
      if (request.method === 'GET') return { response: json(200, await product.resetPlan()) };
      let expected: ResetPlan | undefined;
      if (request.headers.get('content-type')?.includes('application/json')) {
        let body: unknown;
        try { body = await request.json(); } catch (error) { return refused(400, { message: `${product.folder}:1: the request body is not JSON: ${(error as Error).message}` }); }
        const preview = (body as { preview?: unknown } | null)?.preview;
        if (preview !== undefined) {
          if (preview === null || typeof preview !== 'object' || (['store', 'agentPages', 'keptPages', 'unansweredQuestions', 'keptAnswers'] as const).some((key) => !Array.isArray((preview as Record<string, unknown>)[key]) || ((preview as Record<string, unknown>)[key] as unknown[]).some((entry) => typeof entry !== 'string'))) return refused(400, { message: `${product.folder}:1: preview is the complete reset plan read from product settings` });
          expected = preview as ResetPlan;
        }
      }
      const done = await product.reset(expected);
      if (!done.ok) return refused(409, { message: done.message });
      return { response: json(200, done.plan) };
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
    problemDismiss: guarded('record that a problem is not one', async (request) => {
      const crossSite = foreign(request); if (crossSite !== undefined) return refused(403, { message: crossSite });
      if (own) return refused(403, { message: "madarch's own wiki is documentation: a dismissal belongs to the product's repository" });
      const plain = notJson(request); if (plain !== undefined) return refused(415, { message: plain });
      let body: unknown; try { body = await request.json(); } catch (error) { return refused(400, { message: `the request body is not JSON: ${(error as Error).message}` }); }
      const value = body as { id?: unknown; reason?: unknown } | null;
      if (typeof value?.id !== 'string' || value.id.trim() === '') return refused(400, { field: 'id', message: '"id" is the problem the page listed' });
      if (typeof value.reason !== 'string') return refused(400, { field: 'reason', message: '"reason" is required: why the problem is not one' });
      try {
        return { response: json(201, await product.dismissProblem(value.id, value.reason)) };
      } catch (error) {
        if (error instanceof LoopRefusal) return refused(error.status, { field: error.status === 404 ? 'id' : 'reason', message: error.message });
        throw error;
      }
    }),
    problemTask: guarded('create a task from a problem', async (request) => {
      const crossSite = foreign(request); if (crossSite !== undefined) return refused(403, { message: crossSite });
      if (own) return refused(403, { message: "madarch's own wiki is documentation: a task is opened in the product's repository" });
      const plain = notJson(request); if (plain !== undefined) return refused(415, { message: plain });
      let body: unknown; try { body = await request.json(); } catch (error) { return refused(400, { message: `the request body is not JSON: ${(error as Error).message}` }); }
      const id = (body as { id?: unknown } | null)?.id;
      if (typeof id !== 'string' || id.trim() === '') return refused(400, { field: 'id', message: '"id" is the problem the page listed' });
      try {
        return { response: json(201, await product.createProblemTask(id)) };
      } catch (error) {
        if (error instanceof LoopRefusal) return refused(error.status, { field: 'id', message: error.message });
        throw error;
      }
    }),
    refreshPlan: guarded('plan the refresh', async (request) => {
      const language = new URL(request.url).searchParams.get('language');
      if (language !== null && language !== 'en' && language !== 'ru') return refused(400, { field: 'language', message: `"language" is en or ru, got ${JSON.stringify(language)}` });
      return { response: json(200, await product.refreshPlan(language ?? undefined)) };
    }),
    productSettings: guarded('read the product settings', async (request) => {
      if (request.method === 'GET') return { response: json(200, { ...(await product.settingsView()), ...(own ? { own: true } : {}) }) };
      const crossSite = foreign(request);
      if (crossSite !== undefined) return refused(403, { message: crossSite });
      if (own) return refused(403, { message: "madarch's own wiki is documentation: it has no agent, no pages to write and no settings of a product" });
      const plain = notJson(request);
      if (plain !== undefined) return refused(415, { message: plain });
      let body: unknown;
      try { body = await request.json(); } catch (error) { return refused(400, { message: `the request body is not JSON: ${(error as Error).message}` }); }
      const asked = body as { language?: unknown; model?: unknown; reasoning?: unknown; editorialRequestsPerPage?: unknown } | null;
      if (asked === null || typeof asked !== 'object') return refused(400, { message: 'the body is { language?, model?, reasoning?, editorialRequestsPerPage? }' });
      for (const field of ['model', 'reasoning'] as const) {
        const value = asked[field];
        if (value !== undefined && value !== null && typeof value !== 'string') return refused(400, { field, message: `"${field}" is a value the agent reports, or null for the agent's own` });
      }
      if (asked.editorialRequestsPerPage !== undefined) {
        if (typeof asked.editorialRequestsPerPage !== 'number') return refused(400, { field: 'editorialRequestsPerPage', message: `"editorialRequestsPerPage" is the most revision requests one page may receive: an integer from 0 to ${MAX_EDITORIAL_REQUESTS}` });
        const saved = await product.setEditorialRequestsPerPage(asked.editorialRequestsPerPage);
        if (!saved.ok) return refused(saved.status, { field: 'editorialRequestsPerPage', message: saved.message });
      }
      if (asked.language !== undefined) {
        if (typeof asked.language !== 'string') return refused(400, { field: 'language', message: '"language" is the language the pages are written in: en or ru' });
        const saved = await product.setLanguage(asked.language);
        if (!saved.ok) return refused(409, { field: 'language', message: saved.message });
      }
      if (asked.model !== undefined || asked.reasoning !== undefined) {
        const chosen = await product.chooseModel(asked.model as string | null | undefined, asked.reasoning as string | null | undefined);
        if (!chosen.ok) return refused(chosen.status, { message: chosen.message });
      }
      return { response: json(200, await product.settingsView()) };
    }),
    agentChoices: guarded('ask the agent for its models', async (request) => {
      // Asking starts the agent's adapter on this machine: only this wiki's own page may.
      const crossSite = foreign(request);
      if (crossSite !== undefined) return refused(403, { message: crossSite });
      const query = new URL(request.url).searchParams;
      const addressed = query.get('agent');
      const answer = addressed === null
        ? await product.agentChoices(query.get('fresh') === '1')
        : await product.agentChoicesForRole(addressed, query.get('fresh') === '1');
      if (!answer.ok) return refused(409, { message: answer.message });
      return { response: json(200, answer) };
    }),
    modelRole: guarded('assign the model role', async (request) => {
      const crossSite = foreign(request);
      if (crossSite !== undefined) return refused(403, { message: crossSite });
      if (own) return refused(403, { message: "madarch's own wiki is documentation: it has no model roles to assign" });
      const plain = notJson(request);
      if (plain !== undefined) return refused(415, { message: plain });
      let body: unknown;
      try { body = await request.json(); } catch (error) { return refused(400, { message: `the request body is not JSON: ${(error as Error).message}` }); }
      const asked = body as { role?: unknown; agent?: unknown; model?: unknown; reasoning?: unknown; install?: unknown } | null;
      if (typeof asked?.role !== 'string') return refused(400, { field: 'role', message: '"role" is required: writing, classification, analysis or editing' });
      if (asked.agent !== null && typeof asked.agent !== 'string') return refused(400, { field: 'agent', message: '"agent" is an agent id, or null to remove the role' });
      for (const field of ['model', 'reasoning'] as const) {
        const value = asked[field];
        if (value !== undefined && value !== null && typeof value !== 'string') return refused(400, { field, message: `"${field}" is a value the agent reports, or null for the agent's own` });
      }
      if (asked.install !== undefined && typeof asked.install !== 'boolean') return refused(400, { field: 'install', message: '"install" is true or false' });
      const done = await product.chooseRole(asked.role, asked.agent, asked.model as string | null | undefined, asked.reasoning as string | null | undefined, asked.install === true);
      if (!done.ok) return refused(done.status, { field: done.message.includes('role') ? 'role' : done.message.includes('agent') ? 'agent' : undefined, message: done.message });
      return { response: json(200, { role: done.role, pair: done.pair, roles: product.modelRoles() }) };
    }),
    graphVerdicts: guarded('read the graph verdicts', async (request) => {
      if (request.method === 'GET') {
        const query = new URL(request.url).searchParams;
        if (query.get('peek') === '1') {
          const state = product.graphVerdictSettings();
          return { response: json(200, {
            file: state.file, budgets: state.budgets, cached: true,
            metrics: { checked: 0, reused: state.report?.totals.items ?? 0, judgeItems: 0, modelCalls: 0 },
            ...(state.report === undefined ? {} : { report: state.report }),
            total: state.report?.totals.items ?? 0, offset: 0, limit: 0, rows: [],
          }) };
        }
        const verdict = query.get('verdict');
        // `non-valid` is what the settings page reads: every row a person still has to look at, valid ones excluded.
        if (verdict !== null && verdict !== 'valid' && verdict !== 'invalid' && verdict !== 'unreviewed' && verdict !== 'non-valid') return refused(400, { field: 'verdict', accepted: 'valid, invalid, unreviewed or non-valid', message: `"verdict" is ${JSON.stringify(verdict)}` });
        const role = query.get('role');
        if (role !== null && role !== 'node' && role !== 'edge') return refused(400, { field: 'role', accepted: 'node or edge', message: `"role" is ${JSON.stringify(role)}` });
        const kind = query.get('kind');
        const askedLimit = query.get('limit');
        const limit = askedLimit === null ? 200 : Number(askedLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return refused(400, { field: 'limit', accepted: '1 to 1000', message: `"limit" is ${JSON.stringify(askedLimit)}` });
        const askedOffset = query.get('offset');
        const offset = askedOffset === null ? 0 : Number(askedOffset);
        if (!Number.isInteger(offset) || offset < 0) return refused(400, { field: 'offset', accepted: 'a whole number from 0', message: `"offset" is ${JSON.stringify(askedOffset)}` });
        const view = await product.graphVerdicts({ force: query.get('force') === '1' });
        const all = view.rows.filter((row) => (verdict === null || (verdict === 'non-valid' ? row.verdict !== 'valid' : row.verdict === verdict)) && (role === null || row.role === role) && (kind === null || row.kind === kind));
        const rows = all.slice(offset, offset + limit);
        return { response: json(200, { file: view.file, budgets: view.budgets, cached: view.cached, metrics: view.metrics, report: view.report, total: all.length, offset, limit, rows }) };
      }
      const crossSite = foreign(request);
      if (crossSite !== undefined) return refused(403, { message: crossSite });
      if (own) return refused(403, { message: "madarch's own wiki is documentation: it has no graph verdicts to configure" });
      const plain = notJson(request);
      if (plain !== undefined) return refused(415, { message: plain });
      let body: unknown;
      try { body = await request.json(); } catch (error) { return refused(400, { message: `the request body is not JSON: ${(error as Error).message}` }); }
      const asked = body as { itemsPerRun?: unknown; modelCallsPerRun?: unknown } | null;
      if (asked === null || typeof asked !== 'object') return refused(400, { message: 'the body is { itemsPerRun, modelCallsPerRun }' });
      if (typeof asked.itemsPerRun !== 'number') return refused(400, { field: 'itemsPerRun', message: `"itemsPerRun" is ${JSON.stringify(asked.itemsPerRun)}: a whole number of items, 0 or more` });
      if (typeof asked.modelCallsPerRun !== 'number') return refused(400, { field: 'modelCallsPerRun', message: `"modelCallsPerRun" is ${JSON.stringify(asked.modelCallsPerRun)}: a whole number of judge calls, 0 or more` });
      const done = product.setGraphVerdictBudgets(asked.itemsPerRun, asked.modelCallsPerRun);
      if (!done.ok) return refused(done.status, { message: done.message });
      const state = product.graphVerdictSettings();
      return { response: json(200, { budgets: done.budgets, ...(state.report === undefined ? {} : { report: state.report }) }) };
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
      let expected: ResetPlan | undefined;
      if (request.headers.get('content-type')?.includes('application/json')) {
        let body: unknown;
        try { body = await request.json(); } catch (error) { return refused(400, { message: `the request body is not JSON: ${(error as Error).message}` }); }
        const preview = (body as { preview?: unknown } | null)?.preview;
        if (preview !== undefined) {
          if (preview === null || typeof preview !== 'object' || (['store', 'agentPages', 'keptPages', 'unansweredQuestions', 'keptAnswers'] as const).some((key) => !Array.isArray((preview as Record<string, unknown>)[key]) || ((preview as Record<string, unknown>)[key] as unknown[]).some((entry) => typeof entry !== 'string'))) return refused(400, { message: 'preview is the complete reset plan read from product settings' });
          expected = preview as ResetPlan;
        }
      }
      const done = await product.startFresh(expected);
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
    proposeTask: guarded('propose the task of an answer', async (request) => {
      const crossSite = foreign(request);
      if (crossSite !== undefined) return refused(403, { message: crossSite });
      const plain = notJson(request);
      if (plain !== undefined) return refused(415, { message: plain });
      let body: unknown;
      try { body = await request.json(); } catch (error) { return refused(400, { message: `the request body is not JSON: ${(error as Error).message}` }); }
      const asked = body as { question?: unknown; choice?: unknown; language?: unknown } | null;
      if (typeof asked?.question !== 'string') return refused(400, { field: 'question', message: '"question" is required: the id of the answered question the task comes from' });
      if (asked.choice !== 'code' && asked.choice !== 'docs') return refused(400, { field: 'choice', message: '"choice" is code (the code is right, the documents are old) or docs (the documents are right, the code must change)' });
      try {
        const language = asked.language === 'ru' || asked.language === 'en' ? asked.language : undefined;
        return { response: json(200, await product.proposeTask(asked.question, asked.choice, language)) };
      } catch (error) {
        throw error;
      }
    }),
    createTask: guarded('create a task', async (request) => {
      const crossSite = foreign(request); if (crossSite !== undefined) return refused(403, { message: crossSite });
      const plain = notJson(request); if (plain !== undefined) return refused(415, { message: plain });
      let body: unknown; try { body = await request.json(); } catch (error) { return refused(400, { message: `the request body is not JSON: ${(error as Error).message}` }); }
      const value = body as { question?: unknown; title?: unknown; grounds?: unknown; scope?: unknown } | null;
      if (typeof value?.question !== 'string' || typeof value.title !== 'string' || !Array.isArray(value.grounds) || !Array.isArray(value.scope)) return refused(400, { message: 'question, title, grounds and scope are required to confirm a task' });
      if (value.grounds.some((ground) => typeof ground !== 'string' || ground.trim() === '')) return refused(400, { field: 'grounds', message: '"grounds" is a list of non-empty graph keys' });
      const result = await product.createTask({ question: value.question, title: value.title, grounds: value.grounds as string[], scope: value.scope as import('../loop/tasks.js').TaskScope[] });
      return { response: json(201, result) };
    }),
    closeTask: guarded('close a task by hand', async (request) => {
      const crossSite = foreign(request);
      if (crossSite !== undefined) return refused(403, { message: crossSite });
      const plain = notJson(request);
      if (plain !== undefined) return refused(415, { message: plain });
      let body: unknown;
      try { body = await request.json(); } catch (error) { return refused(400, { message: `the request body is not JSON: ${(error as Error).message}` }); }
      const id = (body as { id?: unknown } | null)?.id;
      if (typeof id !== 'string' || id.trim() === '') return refused(400, { field: 'id', message: '"id" is required: the task to close by hand' });
      const result = await product.closeTask(id);
      return { response: json(200, result) };
    }),
    runTask: guarded('fix the pages of a task now', async (request) => {
      const crossSite = foreign(request);
      if (crossSite !== undefined) return refused(403, { message: crossSite });
      if (own) return refused(403, { message: "madarch's own wiki is documentation, not a product to rewrite: its pages are not written here" });
      const plain = notJson(request);
      if (plain !== undefined) return refused(415, { message: plain });
      let body: unknown;
      try { body = await request.json(); } catch (error) { return refused(400, { message: `the request body is not JSON: ${(error as Error).message}` }); }
      const id = (body as { id?: unknown } | null)?.id;
      if (typeof id !== 'string' || id.trim() === '') return refused(400, { field: 'id', message: '"id" is required: the task whose pages the run fixes' });
      const done = await product.runTask(id);
      if (!done.ok) return refused(409, { field: 'id', message: done.message });
      return { response: json(202, { task: done.task, pages: done.pages, fill: done.fill }) };
    }),
    products: guarded('list the products', async () => ({ response: json(200, { current: product.folder, products: siblings() }) }), false),
  };
}
