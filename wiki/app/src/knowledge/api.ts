import { appPath } from '../app-base.js';
import { historyQuery } from './history-context.js';
import { API } from './routes.js';
import { readJson, RequestError } from '../api.js';
import type { AgentChoices, AgentOffer, AnswerResult, Block, CatalogView, CorrectionResult, CreatedTask, DiagramRenderer, DiagramView, DocumentListing, DocumentPageModel, EntityListing, FillRunView, FillState, Glossary, GraphVerdictBudgets, GraphVerdictFilter, GraphVerdictReport, GraphVerdictRole, GraphVerdictView, KindUsageView, ModelRoleId, ModelRoleView, Neighborhood, PageJournal, PageModel, ProblemCategories, ProblemItems, ProblemSection, ProblemSources, ProductChoice, ProductSettings, QuestionDetail, QuestionListing, SearchView, SourceFile, StatementModel, TaskDetail, TaskImpact, TaskListing, TaskProposal, TaskRow, TaskScope, UserSettings, WikiStatus, WriterState } from './types.js';

/** The wiki's status: manifest, kinds, repositories, fill. */
export const getStatus = (signal?: AbortSignal): Promise<WikiStatus> => readJson<WikiStatus>('read the wiki', API.status, signal);

/** The entity catalogue: every kind the manifest declares, with its words, its count and what fills it (madarch-8bdc.2.5). */
export const getCatalog = (signal?: AbortSignal): Promise<CatalogView> => readJson<CatalogView>('read the entity catalogue', API.catalog, signal);

/** The wiki-wide search: pages and entities by title and text, grouped by kind (madarch-o0d). */
export const getSearch = (query: string, lang: string, signal?: AbortSignal): Promise<SearchView> => readJson<SearchView>('search the wiki', `${API.search}?${new URLSearchParams({ q: query, lang: lang === 'ru' ? 'ru' : 'en' }).toString()}`, signal);

/** One entity's page. */
export const getPage = (id: string, lang: string, signal?: AbortSignal, compose?: (reason: string) => string, after?: string | null): Promise<PageModel> => readJson<PageModel>(`read the page of ${id}`, `${API.page}?id=${encodeURIComponent(id)}&lang=${lang === 'ru' ? 'ru' : 'en'}${after === null || after === undefined ? '' : `&after=${encodeURIComponent(after)}`}${historyQuery()}`, signal, compose);

/** The statement view of one sentence of a page. */
export const getStatement = (id: string, sentence: string, turn: number, signal?: AbortSignal): Promise<StatementModel> => readJson<StatementModel>('read the statement', `${API.statement}?id=${encodeURIComponent(id)}&sentence=${encodeURIComponent(sentence)}${turn > 0 ? `&n=${turn}` : ''}`, signal);

/** One page of a kind's entities. */
export function getEntities(kind: string, options: { q?: string; after?: string } = {}, signal?: AbortSignal): Promise<EntityListing> {
  const query = new URLSearchParams({ kind, limit: '100' });
  if (options.q !== undefined && options.q !== '') query.set('q', options.q);
  if (options.after !== undefined) query.set('after', options.after);
  return readJson<EntityListing>(`list the entities of kind ${kind}`, `${API.entities}?${query.toString()}`, signal);
}

/** What the agent spent on a kind: every run counted, the newest listed (madarch-stm0.4, decision 0035, item 22). */
export function getKindUsage(kind: string, signal?: AbortSignal): Promise<{ usage: KindUsageView }> {
  return readJson<{ usage: KindUsageView }>(`read the agent spend on kind ${kind}`, `${API.kindUsage}?${new URLSearchParams({ kind }).toString()}`, signal);
}

/** One file of a repository, as the graph was filled from it. */
export function getSource(repo: string | null, path: string, signal?: AbortSignal): Promise<SourceFile> {
  const query = new URLSearchParams({ path });
  if (repo !== null) query.set('repo', repo);
  return readJson<SourceFile>(`read the source of ${path}`, `${API.source}?${query.toString()}${historyQuery()}`, signal);
}

/**
 * The products the selector offers: the server's list at `/api/products`. Under a
 * product's mount the product answers it; at the products home, the home does —
 * both name the same products, and only the product's answer carries `current`.
 */
export async function getProducts(signal?: AbortSignal): Promise<ProductChoice[]> {
  return (await readJson<{ products: ProductChoice[] }>('list the products', API.products, signal)).products;
}

/** The agents the reader can let write the pages, and the one chosen for this product. */
export const getAgents = (signal?: AbortSignal): Promise<{ agents: AgentOffer[]; chosen: { id: string; label: string } | null }> => readJson('read the agents', API.agents, signal);

/** The reader's choice of the agent that writes the pages; `install` is the yes to fetching its adapter. `null` is no agent. */
export async function chooseAgent(agent: string | null, install: boolean): Promise<void> {
  let response: Response;
  try {
    response = await fetch(appPath(API.agent), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent, install }) });
  } catch (error) {
    throw new RequestError('choose the agent', `the request failed (${error instanceof Error ? error.message : String(error)})`);
  }
  if (response.ok) return;
  let reason = `the server answered ${response.status}`;
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string') reason = body.message;
  } catch {
    // the status stands
  }
  throw new RequestError('choose the agent', reason, response.status);
}

/** Assigns one model role to an (agent, model) pair, or removes it with null (madarch-j6ho.2). */
export async function chooseModelRole(role: ModelRoleId, agent: string | null, options: { model?: string | null; reasoning?: string | null; install?: boolean } = {}): Promise<ModelRoleView> {
  let response: Response;
  try {
    response = await fetch(appPath(API.modelRole), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role, agent, ...options }) });
  } catch (error) {
    throw new RequestError('assign the model role', `the request failed (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!response.ok) {
    let reason = `the server answered ${response.status}`;
    try {
      const body = (await response.json()) as { error?: { message?: unknown } };
      if (typeof body.error?.message === 'string') reason = body.error.message;
    } catch {
      // the status stands
    }
    throw new RequestError('assign the model role', reason, response.status);
  }
  return ((await response.json()) as { roles: ModelRoleView }).roles;
}

/** Starts the fill; the answer is the server's refusal in words when it cannot start. */
export async function startFill(agent?: string | null, language?: string): Promise<void> {
  let response: Response;
  try {
    // The press names the agent it was made for; the server refuses it when another tab saved a different choice meanwhile.
    response = await fetch(appPath(API.fill), agent === undefined ? { method: 'POST' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent, ...(language === undefined ? {} : { language }) }) });
  } catch (error) {
    throw new RequestError('start the fill', `the request failed (${error instanceof Error ? error.message : String(error)})`);
  }
  if (response.ok) return;
  let reason = `the server answered ${response.status}`;
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string') reason = body.message;
  } catch {
    // the status stands
  }
  throw new RequestError('start the fill', reason, response.status);
}

/**
 * A person's «Пауза» (madarch-m38l.17): the page and the commit in progress are finished and the run ends before the next
 * one. The answer is the run's state as the server keeps it, and the server's words when there is nothing to pause.
 */
export const pauseRun = (): Promise<{ fill: FillState; writer: WriterState }> => post<{ fill: FillState; writer: WriterState }>('pause the run', API.pause, {});

/**
 * A person's «Остановить»: the run ends now, and the pages it already rewrote stand. The press that ends it is the second
 * one; the first answer is the server's refusal, naming the pages this run rewrote and that they stay.
 */
export const stopRun = (): Promise<{ fill: FillState; writer: WriterState }> => post<{ fill: FillState; writer: WriterState }>('stop the run', API.stop, { confirm: true });

/** The newest run's trace: per step its wall clock, its peak memory and its slowest names. */
export const getRun = (run: string | null, signal?: AbortSignal): Promise<{ run: FillRunView }> =>
  readJson('read the run', `${API.run}${run === null ? '' : `?run=${encodeURIComponent(run)}`}`, signal);

/** The wiki's one change stream: the server says `change` when a file of the product or a commit of the fill changes what a page shows. */
export const eventsAddress = (): string => appPath('/api/events');

/** What starting the product over would remove and keep. */
export type ResetPlan = { store: string[]; agentPages: string[]; keptPages: string[]; unansweredQuestions: string[]; keptAnswers: string[] };

// ---- the product settings page (madarch-m38l.11) -----------------------------------------------

export const getProductSettings = (signal?: AbortSignal): Promise<ProductSettings> => readJson<ProductSettings>('read the product settings', API.productSettings, signal);

/** What the chosen agent reports over ACP as its models and reasoning levels; `fresh` asks the agent again. */
export const getAgentChoices = (fresh = false, signal?: AbortSignal): Promise<AgentChoices> => readJson<AgentChoices>('ask the agent for its models', `${API.agentChoices}${fresh ? '?fresh=1' : ''}`, signal);

/** Asks one agent (not only the writing one) for the models it reports; a role's pair is chosen among them. */
export const getAgentChoicesFor = (agent: string, fresh = false, signal?: AbortSignal): Promise<AgentChoices> => {
  const query = new URLSearchParams({ agent });
  if (fresh) query.set('fresh', '1');
  return readJson<AgentChoices>('ask the agent for its models', `${API.agentChoices}?${query.toString()}`, signal);
};


/** The graph verdict coverage and an inspectable slice of rows (madarch-mwhd.1). `peek` reads the saved report and starts no judge. */
export async function getGraphVerdicts(query: { verdict?: GraphVerdictFilter; role?: GraphVerdictRole; kind?: string; limit?: number; offset?: number; force?: boolean; peek?: boolean } = {}, signal?: AbortSignal): Promise<GraphVerdictView> {
  const search = new URLSearchParams();
  if (query.verdict !== undefined) search.set('verdict', query.verdict);
  if (query.role !== undefined) search.set('role', query.role);
  if (query.kind !== undefined) search.set('kind', query.kind);
  if (query.limit !== undefined) search.set('limit', String(query.limit));
  if (query.offset !== undefined) search.set('offset', String(query.offset));
  if (query.force === true) search.set('force', '1');
  if (query.peek === true) search.set('peek', '1');
  return await readJson<GraphVerdictView>('read the graph verdicts', `${API.graphVerdicts}${search.size === 0 ? '' : `?${search.toString()}`}`, signal);
}

/** Saves what one graph verdict run may spend. */
export async function saveGraphVerdictBudgets(itemsPerRun: number, modelCallsPerRun: number): Promise<{ budgets: GraphVerdictBudgets; report?: GraphVerdictReport }> {
  return await post<{ budgets: GraphVerdictBudgets; report?: GraphVerdictReport }>('save the graph verdict budgets', API.graphVerdicts, { itemsPerRun, modelCallsPerRun });
}

/** Starts the fill the page asked for: the selected kinds, their dependencies added by the engine, in order. */
export const fillSelected = (selection: { selected: string[]; agent: string | null; tokenCap: number | null }): Promise<{ order: string[] }> => post<{ fill: FillState; order: string[] }>('fill the selected entities', API.fillSelected, selection);

export const saveProductSettings = (settings: { language?: string; model?: string | null; reasoning?: string | null; editorialRequestsPerPage?: number }): Promise<ProductSettings> => post<ProductSettings>('save the settings', API.productSettings, settings);

/** «Rewrite the pages»: the agent's pages go, the graph stays, a fill writes them again. */
export const rewritePages = (): Promise<unknown> => post<unknown>('rewrite the pages', API.rewritePages, {});

/** «Start from scratch»: pages, graph, manifest and templates are put at the current set, and a fresh fill starts. */
export const startFresh = (preview?: ResetPlan): Promise<{ fillRefused?: string }> => post<{ fillRefused?: string }>('start from scratch', API.startFresh, preview === undefined ? {} : { preview });

/** The Markdown documents of the product and of its connected repositories. */
export const getDocuments = (signal?: AbortSignal): Promise<DocumentListing> => readJson<DocumentListing>('list the documents', API.documents, signal);

/** One Markdown document as a page. */
export function getDocument(repo: string | null, path: string, signal?: AbortSignal): Promise<DocumentPageModel> {
  const query = new URLSearchParams({ path });
  if (repo !== null) query.set('repo', repo);
  return readJson<DocumentPageModel>(`read the document ${path}`, `${API.document}?${query.toString()}`, signal);
}

/** The terms of the product's glossaries. */
export const getGlossary = (signal?: AbortSignal): Promise<Glossary> => readJson<Glossary>('read the glossary', API.glossary, signal);

/** The reader's settings on this machine: the role, and whether they were asked. */
export const getSettings = (signal?: AbortSignal): Promise<UserSettings> => readJson<UserSettings>('read the settings', API.settings, signal);

/** Keeps the role the reader chose (a skip is "everything"). */
export async function setRole(role: string): Promise<UserSettings> {
  let response: Response;
  try {
    response = await fetch(appPath(API.settings), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role }) });
  } catch (error) {
    throw new RequestError('keep the role', `the request failed (${error instanceof Error ? error.message : String(error)})`);
  }
  if (response.ok) return (await response.json()) as UserSettings;
  let reason = `the server answered ${response.status}`;
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string') reason = body.message;
  } catch {
    // the status stands
  }
  throw new RequestError('keep the role', reason, response.status);
}

/** The neighbours of one entity, one hop: for a diagram that opens a node. */
export function getNeighborhood(id: string, options: { relation?: string; direction?: 'out' | 'in'; limit?: number } = {}, signal?: AbortSignal): Promise<Neighborhood> {
  const query = new URLSearchParams({ id, limit: String(options.limit ?? 8) });
  if (options.relation !== undefined) query.set('relation', options.relation);
  if (options.direction !== undefined) query.set('direction', options.direction);
  return readJson<Neighborhood>(`read the neighbours of ${id}`, `${API.neighborhood}?${query.toString()}${historyQuery()}`, signal);
}

// ---- the loop of questions and corrections (madarch-m38l.7) ----------------------------------

export const getQuestions = (signal?: AbortSignal): Promise<QuestionListing> => readJson<QuestionListing>('list the questions', API.questions, signal);

export const getQuestion = (id: string, signal?: AbortSignal): Promise<QuestionDetail> => readJson<QuestionDetail>(`read the question ${id}`, `${API.question}?id=${encodeURIComponent(id)}`, signal);

/** The Problems page's first level: one row per rule, with counts (madarch-8bdc.2.5). */
export function getProblemCategories(options: { section?: ProblemSection } = {}, signal?: AbortSignal): Promise<ProblemCategories> {
  const query = new URLSearchParams();
  if (options.section !== undefined) query.set('section', options.section);
  return readJson<ProblemCategories>('list the problem categories', `${API.problems}${query.size === 0 ? '' : `?${query.toString()}`}`, signal);
}

/** The second level: the sources of one category, one bounded page at a time. */
export function getProblemSources(rule: string, options: { after?: string } = {}, signal?: AbortSignal): Promise<ProblemSources> {
  const query = new URLSearchParams({ rule });
  if (options.after !== undefined) query.set('after', options.after);
  return readJson<ProblemSources>(`list the sources of ${rule}`, `${API.problems}?${query.toString()}`, signal);
}

/** The third level: the items of one source of one category, one bounded page at a time. */
export function getProblemItems(rule: string, source: string, options: { after?: string } = {}, signal?: AbortSignal): Promise<ProblemItems> {
  const query = new URLSearchParams({ rule, source });
  if (options.after !== undefined) query.set('after', options.after);
  return readJson<ProblemItems>(`list the problems of ${rule} in ${source}`, `${API.problems}?${query.toString()}`, signal);
}

/** «Не проблема»: the reason is kept as a file in the product repository. */
export const dismissProblem = (id: string, reason: string): Promise<{ file: string; committed: boolean; note?: string; commit?: string }> => post('dismiss the problem', API.problemDismiss, { id, reason });

/** «Создать задачу»: a task scoped to the place the problem names (madarch-m38l.14). */
export const createProblemTask = (id: string): Promise<CreatedTask> => post<CreatedTask>('create a task from the problem', API.problemTask, { id });

async function post<T>(what: string, url: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(appPath(url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (error) {
    throw new RequestError(what, `the request failed (${error instanceof Error ? error.message : String(error)})`);
  }
  if (response.ok) return (await response.json()) as T;
  let reason = `the server answered ${response.status}`;
  try {
    const answer = (await response.json()) as { message?: unknown; error?: { message?: unknown } };
    if (typeof answer.message === 'string') reason = answer.message;
    else if (typeof answer.error?.message === 'string') reason = answer.error.message;
  } catch {
    // the status stands
  }
  throw new RequestError(what, reason, response.status);
}

/** A person's answer to a question; the server writes it into the question's file and commits it. */
export const answerQuestion = (question: string, text: string): Promise<AnswerResult> => post<AnswerResult>('save the answer', API.answer, { question, text });

/** A person's correction of a statement (`<page id>#<statement name>`): "wrong, because ...". */
export const correctStatement = (statement: string, reason: string): Promise<CorrectionResult> => post<CorrectionResult>('save the correction', API.correction, { statement, reason });

/** One block of a page, by the line of its template: what a deferred diagram reads to draw itself. */
export const getBlock = (id: string, block: string, lang: string, signal?: AbortSignal): Promise<Block> => readJson<Block>(`read the block ${block} of the page of ${id}`, `${API.block}?id=${encodeURIComponent(id)}&block=${encodeURIComponent(block)}&lang=${lang === 'ru' ? 'ru' : 'en'}${historyQuery()}`, signal);

/** What the agent did to write one page: the records of the newest run that wrote it, or of the run asked for. */
export const getJournal = (id: string, run: string | null, signal?: AbortSignal): Promise<PageJournal> => readJson<PageJournal>(`read the journal of ${id}`, `${API.journal}?id=${encodeURIComponent(id)}${run === null ? '' : `&run=${encodeURIComponent(run)}`}`, signal);
/** The views a specification asks for (a drill-down or a way up replaces a diagram in place). */
export const getViews = (query: string, lang: string, signal?: AbortSignal): Promise<{ renderer: DiagramRenderer; views: DiagramView[] }> => readJson<{ renderer: DiagramRenderer; views: DiagramView[] }>('read the diagram view', `${API.view}?${query}&lang=${lang === 'ru' ? 'ru' : 'en'}`, signal);

/** Where the frame of a view in the LikeC4 or archify renderer is served (the app's base is added). */
export const viewFrameAddress = (query: string, renderer: 'likec4' | 'archify', lang: string): string => appPath(`${API.viewFrame}?${query}&renderer=${renderer}&lang=${lang === 'ru' ? 'ru' : 'en'}`);

/** The product's tasks, open first, each with what its change reaches through the graph. */
export const getTasks = (signal?: AbortSignal): Promise<TaskListing> => readJson('list the tasks', API.tasks, signal);

/** One task with its complete impact: the pages a run would rewrite and the marks it stands on. */
export const getTask = (id: string, signal?: AbortSignal): Promise<TaskDetail> => readJson(`read the task ${id}`, `${API.task}?id=${encodeURIComponent(id)}`, signal);

/** The task an answer proposes: the scope its grounds name and what it reaches, before anything is written. */
export const proposeTask = (question: string, choice: 'code' | 'docs', language: string): Promise<TaskProposal> => post<TaskProposal>('propose the task of the answer', API.taskPropose, { question, choice, language });

/** What the reader's edited scope reaches through the graph: the preview follows the scope, not the answer it came from. */
export const getScopeImpact = (scope: TaskScope[]): Promise<TaskImpact> => post<TaskImpact>('compute what the scope reaches', API.taskImpact, { scope });

/** Confirms the reader's edited proposal: only now is a task written, as the reader, in the product repository. */
export const createTask = (input: { question: string; title: string; grounds: string[]; scope: TaskScope[] }): Promise<CreatedTask> => post<CreatedTask>('confirm the task', API.taskCreate, input);

/** Closes a task by hand; a commit that names the task and touches its scope closes it without this. */
export const closeTask = (id: string): Promise<{ task: { slug: string; id: string }; state: 'closed'; committed: boolean; note?: string }> => post('close the task', API.taskClose, { id });

/** «Поправить страницы сейчас»: a run over exactly the pages this task's impact lists. */
export const runTask = (id: string): Promise<{ task: TaskRow; pages: string[]; fill: FillState }> => post('fix the task pages now', API.taskRun, { id });
