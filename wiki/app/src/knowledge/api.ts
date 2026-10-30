import { appPath } from '../app-base.js';
import { historyQuery } from './history-context.js';
import { readJson, RequestError } from '../api.js';
import type { AgentChoices, AgentOffer, AnswerResult, Block, CorrectionResult, CreatedTask, DiagramRenderer, DiagramView, DocumentListing, DocumentPageModel, EntityListing, FillState, Glossary, GraphVerdictBudgets, GraphVerdictFilter, GraphVerdictReport, GraphVerdictRole, GraphVerdictView, ModelRoleId, ModelRoleView, Neighborhood, PageJournal, PageModel, ProblemListing, ProductChoice, ProductSettings, QuestionDetail, QuestionListing, RefreshPreview, SourceFile, StatementModel, TaskDetail, TaskImpact, TaskListing, TaskProposal, TaskRow, TaskScope, UserSettings, WikiStatus } from './types.js';

/** The wiki's status: manifest, kinds, repositories, fill. */
export const getStatus = (signal?: AbortSignal): Promise<WikiStatus> => readJson<WikiStatus>('read the wiki', '/api/k/status', signal);

/** One entity's page. */
export const getPage = (id: string, lang: string, signal?: AbortSignal, compose?: (reason: string) => string): Promise<PageModel> => readJson<PageModel>(`read the page of ${id}`, `/api/k/page?id=${encodeURIComponent(id)}&lang=${lang === 'ru' ? 'ru' : 'en'}${historyQuery()}`, signal, compose);

/** The statement view of one sentence of a page. */
export const getStatement = (id: string, sentence: string, turn: number, signal?: AbortSignal): Promise<StatementModel> => readJson<StatementModel>('read the statement', `/api/k/statement?id=${encodeURIComponent(id)}&sentence=${encodeURIComponent(sentence)}${turn > 0 ? `&n=${turn}` : ''}`, signal);

/** One page of a kind's entities. */
export function getEntities(kind: string, options: { q?: string; after?: string } = {}, signal?: AbortSignal): Promise<EntityListing> {
  const query = new URLSearchParams({ kind, limit: '100' });
  if (options.q !== undefined && options.q !== '') query.set('q', options.q);
  if (options.after !== undefined) query.set('after', options.after);
  return readJson<EntityListing>(`list the entities of kind ${kind}`, `/api/k/entities?${query.toString()}`, signal);
}

/** One file of a repository, as the graph was filled from it. */
export function getSource(repo: string | null, path: string, signal?: AbortSignal): Promise<SourceFile> {
  const query = new URLSearchParams({ path });
  if (repo !== null) query.set('repo', repo);
  return readJson<SourceFile>(`read the source of ${path}`, `/api/k/source?${query.toString()}${historyQuery()}`, signal);
}

/** The products the selector offers: the home's, or this one alone. */
export async function getProducts(signal?: AbortSignal): Promise<ProductChoice[]> {
  const mounted = /^\/products\/[^/]+/.test(window.location.pathname);
  try {
    if (mounted) {
      const response = await fetch('/api/products', { signal });
      if (response.ok) return ((await response.json()) as { products: ProductChoice[] }).products;
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
  }
  return (await readJson<{ products: ProductChoice[] }>('list the products', '/api/k/products', signal)).products;
}

/** The agents the reader can let write the pages, and the one chosen for this product. */
export const getAgents = (signal?: AbortSignal): Promise<{ agents: AgentOffer[]; chosen: { id: string; label: string } | null }> => readJson('read the agents', '/api/k/agents', signal);

/** The reader's choice of the agent that writes the pages; `install` is the yes to fetching its adapter. `null` is no agent. */
export async function chooseAgent(agent: string | null, install: boolean): Promise<void> {
  let response: Response;
  try {
    response = await fetch(appPath('/api/k/agent'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent, install }) });
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
    response = await fetch(appPath('/api/k/model-role'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role, agent, ...options }) });
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
    response = await fetch(appPath('/api/k/fill'), agent === undefined ? { method: 'POST' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent, ...(language === undefined ? {} : { language }) }) });
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

/** The wiki's one change stream: the server says `change` when a file of the product or a commit of the fill changes what a page shows. */
export const eventsAddress = (): string => appPath('/api/events');

/** What starting the product over would remove and keep. */
export type ResetPlan = { store: string[]; agentPages: string[]; keptPages: string[]; unansweredQuestions: string[]; keptAnswers: string[] };

export const getResetPlan = (signal?: AbortSignal): Promise<ResetPlan> => readJson<ResetPlan>('read what starting over removes', '/api/k/reset', signal);

/** Starts the product over; the answer is the server's refusal in words when it cannot. */
export async function resetProduct(): Promise<void> {
  let response: Response;
  try {
    response = await fetch(appPath('/api/k/reset'), { method: 'POST' });
  } catch (error) {
    throw new RequestError('start over', `the request failed (${error instanceof Error ? error.message : String(error)})`);
  }
  if (response.ok) return;
  let reason = `the server answered ${response.status}`;
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string') reason = body.message;
  } catch {
    // the status stands
  }
  throw new RequestError('start over', reason, response.status);
}

// ---- the product settings page (madarch-m38l.11) -----------------------------------------------

export const getProductSettings = (signal?: AbortSignal): Promise<ProductSettings> => readJson<ProductSettings>('read the product settings', '/api/k/product-settings', signal);

/** What the chosen agent reports over ACP as its models and reasoning levels; `fresh` asks the agent again. */
export const getAgentChoices = (fresh = false, signal?: AbortSignal): Promise<AgentChoices> => readJson<AgentChoices>('ask the agent for its models', `/api/k/agent-choices${fresh ? '?fresh=1' : ''}`, signal);

/** Asks one agent (not only the writing one) for the models it reports; a role's pair is chosen among them. */
export const getAgentChoicesFor = (agent: string, fresh = false, signal?: AbortSignal): Promise<AgentChoices> => {
  const query = new URLSearchParams({ agent });
  if (fresh) query.set('fresh', '1');
  return readJson<AgentChoices>('ask the agent for its models', `/api/k/agent-choices?${query.toString()}`, signal);
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
  return await readJson<GraphVerdictView>('read the graph verdicts', `/api/k/graph-verdicts${search.size === 0 ? '' : `?${search.toString()}`}`, signal);
}

/** Saves what one graph verdict run may spend. */
export async function saveGraphVerdictBudgets(itemsPerRun: number, modelCallsPerRun: number): Promise<{ budgets: GraphVerdictBudgets; report?: GraphVerdictReport }> {
  return await post<{ budgets: GraphVerdictBudgets; report?: GraphVerdictReport }>('save the graph verdict budgets', '/api/k/graph-verdicts', { itemsPerRun, modelCallsPerRun });
}

/** Saves the page language, the model and the reasoning level (`null` is the agent's own). */
export const saveProductSettings = (settings: { language?: string; model?: string | null; reasoning?: string | null; editorialRequestsPerPage?: number }): Promise<ProductSettings> => post<ProductSettings>('save the settings', '/api/k/product-settings', settings);

/** Adds items of the starter set to the product's manifest; answers the files written. */
export const addStarter = (ids: string[]): Promise<{ written: string[] }> => post<{ written: string[] }>('add to the manifest', '/api/k/starter', { ids });

/** «Rewrite the pages»: the agent's pages go, the graph stays, a fill writes them again. */
export const rewritePages = (): Promise<unknown> => post<unknown>('rewrite the pages', '/api/k/rewrite-pages', {});

/** «Start from scratch»: pages, graph, manifest and templates are put at the current set, and a fresh fill starts. */
export const startFresh = (preview?: ResetPlan): Promise<{ fillRefused?: string }> => post<{ fillRefused?: string }>('start from scratch', '/api/k/start-fresh', preview === undefined ? {} : { preview });

/** The Markdown documents of the product and of its connected repositories. */
export const getDocuments = (signal?: AbortSignal): Promise<DocumentListing> => readJson<DocumentListing>('list the documents', '/api/k/documents', signal);

/** One Markdown document as a page. */
export function getDocument(repo: string | null, path: string, signal?: AbortSignal): Promise<DocumentPageModel> {
  const query = new URLSearchParams({ path });
  if (repo !== null) query.set('repo', repo);
  return readJson<DocumentPageModel>(`read the document ${path}`, `/api/k/document?${query.toString()}`, signal);
}

/** The terms of the product's glossaries. */
export const getGlossary = (signal?: AbortSignal): Promise<Glossary> => readJson<Glossary>('read the glossary', '/api/k/glossary', signal);

/** The reader's settings on this machine: the role, and whether they were asked. */
export const getSettings = (signal?: AbortSignal): Promise<UserSettings> => readJson<UserSettings>('read the settings', '/api/k/settings', signal);

/** Keeps the role the reader chose (a skip is "everything"). */
export async function setRole(role: string): Promise<UserSettings> {
  let response: Response;
  try {
    response = await fetch(appPath('/api/k/settings'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role }) });
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
  return readJson<Neighborhood>(`read the neighbours of ${id}`, `/api/k/neighborhood?${query.toString()}${historyQuery()}`, signal);
}

// ---- the loop of questions and corrections (madarch-m38l.7) ----------------------------------

export const getQuestions = (signal?: AbortSignal): Promise<QuestionListing> => readJson<QuestionListing>('list the questions', '/api/k/questions', signal);

export const getQuestion = (id: string, signal?: AbortSignal): Promise<QuestionDetail> => readJson<QuestionDetail>(`read the question ${id}`, `/api/k/question?id=${encodeURIComponent(id)}`, signal);

export const getProblems = (signal?: AbortSignal): Promise<ProblemListing> => readJson<ProblemListing>('list the problems', '/api/k/problems', signal);

/** «Не проблема»: the reason is kept as a file in the product repository. */
export const dismissProblem = (id: string, reason: string): Promise<{ file: string; committed: boolean; note?: string; commit?: string }> => post('dismiss the problem', '/api/k/problem-dismiss', { id, reason });

/** «Создать задачу»: a task scoped to the place the problem names (madarch-m38l.14). */
export const createProblemTask = (id: string): Promise<CreatedTask> => post<CreatedTask>('create a task from the problem', '/api/k/problem-task', { id });

/** Which pages a refresh would touch and why, before it is pressed; `language` is the one the reader means to ask for. */
export const getRefreshPlan = (language?: string, signal?: AbortSignal): Promise<RefreshPreview> => readJson<RefreshPreview>('plan the refresh', `/api/k/refresh-plan${language === undefined ? '' : `?language=${encodeURIComponent(language)}`}`, signal);

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
export const answerQuestion = (question: string, text: string): Promise<AnswerResult> => post<AnswerResult>('save the answer', '/api/k/answer', { question, text });

/** A person's correction of a statement (`<page id>#<statement name>`): "wrong, because ...". */
export const correctStatement = (statement: string, reason: string): Promise<CorrectionResult> => post<CorrectionResult>('save the correction', '/api/k/correction', { statement, reason });

/** One block of a page, by the line of its template: what a deferred diagram reads to draw itself. */
export const getBlock = (id: string, block: string, lang: string, signal?: AbortSignal): Promise<Block> => readJson<Block>(`read the block ${block} of the page of ${id}`, `/api/k/block?id=${encodeURIComponent(id)}&block=${encodeURIComponent(block)}&lang=${lang === 'ru' ? 'ru' : 'en'}${historyQuery()}`, signal);

/** What the agent did to write one page: the records of the newest run that wrote it, or of the run asked for. */
export const getJournal = (id: string, run: string | null, signal?: AbortSignal): Promise<PageJournal> => readJson<PageJournal>(`read the journal of ${id}`, `/api/k/journal?id=${encodeURIComponent(id)}${run === null ? '' : `&run=${encodeURIComponent(run)}`}`, signal);
/** The views a specification asks for (a drill-down or a way up replaces a diagram in place). */
export const getViews = (query: string, lang: string, signal?: AbortSignal): Promise<{ renderer: DiagramRenderer; views: DiagramView[] }> => readJson<{ renderer: DiagramRenderer; views: DiagramView[] }>('read the diagram view', `/api/k/view?${query}&lang=${lang === 'ru' ? 'ru' : 'en'}`, signal);

/** Where the frame of a view in the LikeC4 or archify renderer is served (the app's base is added). */
export const viewFrameAddress = (query: string, renderer: 'likec4' | 'archify', lang: string): string => appPath(`/api/k/view-frame?${query}&renderer=${renderer}&lang=${lang === 'ru' ? 'ru' : 'en'}`);

/** The product's tasks, open first, each with what its change reaches through the graph. */
export const getTasks = (signal?: AbortSignal): Promise<TaskListing> => readJson('list the tasks', '/api/k/tasks', signal);

/** One task with its complete impact: the pages a run would rewrite and the marks it stands on. */
export const getTask = (id: string, signal?: AbortSignal): Promise<TaskDetail> => readJson(`read the task ${id}`, `/api/k/task?id=${encodeURIComponent(id)}`, signal);

/** The task an answer proposes: the scope its grounds name and what it reaches, before anything is written. */
export const proposeTask = (question: string, choice: 'code' | 'docs', language: string): Promise<TaskProposal> => post<TaskProposal>('propose the task of the answer', '/api/k/task-propose', { question, choice, language });

/** What the reader's edited scope reaches through the graph: the preview follows the scope, not the answer it came from. */
export const getScopeImpact = (scope: TaskScope[]): Promise<TaskImpact> => post<TaskImpact>('compute what the scope reaches', '/api/k/task-impact', { scope });

/** Confirms the reader's edited proposal: only now is a task written, as the reader, in the product repository. */
export const createTask = (input: { question: string; title: string; grounds: string[]; scope: TaskScope[] }): Promise<CreatedTask> => post<CreatedTask>('confirm the task', '/api/k/task-create', input);

/** Closes a task by hand; a commit that names the task and touches its scope closes it without this. */
export const closeTask = (id: string): Promise<{ task: { slug: string; id: string }; state: 'closed'; committed: boolean; note?: string }> => post('close the task', '/api/k/task-close', { id });

/** «Поправить страницы сейчас»: a run over exactly the pages this task's impact lists. */
export const runTask = (id: string): Promise<{ task: TaskRow; pages: string[]; fill: FillState }> => post('fix the task pages now', '/api/k/task-run', { id });
