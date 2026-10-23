import { appPath } from '../app-base.js';
import { readJson, RequestError } from '../api.js';
import type { AgentChoices, AgentOffer, AnswerResult, ProductSettings, CorrectionResult, DocumentListing, Glossary, UserSettings, DocumentPageModel, Block, EntityListing, Neighborhood, PageModel, ProblemListing, PageJournal, ProductChoice, QuestionDetail, QuestionListing, RefreshPreview, SourceFile, StatementModel, WikiStatus } from './types.js';

/** The wiki's status: manifest, kinds, repositories, fill. */
export const getStatus = (signal?: AbortSignal): Promise<WikiStatus> => readJson<WikiStatus>('read the wiki', '/api/k/status', signal);

/** One entity's page. */
export const getPage = (id: string, lang: string, signal?: AbortSignal): Promise<PageModel> => readJson<PageModel>(`read the page of ${id}`, `/api/k/page?id=${encodeURIComponent(id)}&lang=${lang === 'ru' ? 'ru' : 'en'}`, signal);

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
  return readJson<SourceFile>(`read the source of ${path}`, `/api/k/source?${query.toString()}`, signal);
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
export type ResetPlan = { store: string[]; agentPages: string[]; keptPages: string[] };

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

/** Saves the page language, the model and the reasoning level (`null` is the agent's own). */
export const saveProductSettings = (settings: { language?: string; model?: string | null; reasoning?: string | null }): Promise<ProductSettings> => post<ProductSettings>('save the settings', '/api/k/product-settings', settings);

/** Adds items of the starter set to the product's manifest; answers the files written. */
export const addStarter = (ids: string[]): Promise<{ written: string[] }> => post<{ written: string[] }>('add to the manifest', '/api/k/starter', { ids });

/** «Rewrite the pages»: the agent's pages go, the graph stays, a fill writes them again. */
export const rewritePages = (): Promise<unknown> => post<unknown>('rewrite the pages', '/api/k/rewrite-pages', {});

/** «Start from scratch»: pages, graph, manifest and templates are put at the current set, and a fresh fill starts. */
export const startFresh = (): Promise<{ fillRefused?: string }> => post<{ fillRefused?: string }>('start from scratch', '/api/k/start-fresh', {});

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
  return readJson<Neighborhood>(`read the neighbours of ${id}`, `/api/k/neighborhood?${query.toString()}`, signal);
}

// ---- the loop of questions and corrections (madarch-m38l.7) ----------------------------------

export const getQuestions = (signal?: AbortSignal): Promise<QuestionListing> => readJson<QuestionListing>('list the questions', '/api/k/questions', signal);

export const getQuestion = (id: string, signal?: AbortSignal): Promise<QuestionDetail> => readJson<QuestionDetail>(`read the question ${id}`, `/api/k/question?id=${encodeURIComponent(id)}`, signal);

export const getProblems = (signal?: AbortSignal): Promise<ProblemListing> => readJson<ProblemListing>('list the problems', '/api/k/problems', signal);

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
export const getBlock = (id: string, line: number, lang: string, signal?: AbortSignal): Promise<Block> => readJson<Block>(`read the block at line ${line} of the page of ${id}`, `/api/k/block?id=${encodeURIComponent(id)}&line=${line}&lang=${lang === 'ru' ? 'ru' : 'en'}`, signal);

/** What the agent did to write one page: the records of the newest run that wrote it, or of the run asked for. */
export const getJournal = (id: string, run: string | null, signal?: AbortSignal): Promise<PageJournal> => readJson<PageJournal>(`read the journal of ${id}`, `/api/k/journal?id=${encodeURIComponent(id)}${run === null ? '' : `&run=${encodeURIComponent(run)}`}`, signal);
export const getTasks = (signal?: AbortSignal): Promise<import('./types.js').TaskListing> => readJson('list the tasks', '/api/k/tasks', signal);
export const getTaskImpact = async (grounds: string[]): Promise<import('./types.js').TaskImpact> => {
  const response = await fetch(appPath('/api/k/task-impact'), { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({grounds}) });
  if (!response.ok) throw new RequestError('compute task impact', `the server answered ${response.status}`);
  return await response.json() as import('./types.js').TaskImpact;
};
export const createTask = (input: {question:string;title:string;grounds:string[];scope: import('./types.js').PlannedTask['scope']}) => post<{task:import('./types.js').PlannedTask;committed:boolean;note?:string}>('confirm the task','/api/k/task',input);