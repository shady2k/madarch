
/**
 * The command client (decision 0036, section 7): the one way a command component asks the server's retained command
 * reads and presses its commands. A page's graph data comes through `/graphql`; the fill's plan, its agents, its runs and
 * its controls are workflow state, not graph data, and they are read here.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

// ---- the answers the commands give -------------------------------------------------------------------------------

/** One field of a selected kind and the plugins that fill it, in plan order. */
export interface FillPlanField {
  readonly field: string;
  /** The field's reader-facing name from its declaration, when it declares one. */
  readonly labels?: Readonly<Record<string, string>>;
  readonly producers: readonly string[];
}

/** One selected kind's place in the plan. */
export interface FillPlanKind {
  readonly kind: string;
  readonly fields: readonly FillPlanField[];
  /** The fields an agent fills, alone or beside a producer it refines. */
  readonly agentFields: readonly string[];
}

/** One unit the plan runs: an output of a plugin for a kind. */
export interface FillPlanUnit {
  readonly plugin: string;
  readonly kind: string;
}

/** The kinds and fields the agent fills: such a plan runs only once an agent is chosen. */
export interface FillPlanNeed {
  readonly kind: string;
  readonly fields: readonly string[];
}

/** One kind nothing in the manifest produces, with the missing plugin when the manifest names one. */
export interface FillPlanError {
  readonly kind: string;
  readonly fields: readonly string[];
  readonly plugin?: string;
  readonly message: string;
}

/** `POST /api/fill-plan`: the plan of one press, before any unit runs. */
export interface FillPlanAnswer {
  readonly plan: FillPlanView;
}

export interface FillPlanView {
  readonly plugins: readonly { readonly name: string; readonly labels: Readonly<Record<string, string>> }[];
  readonly selectedKinds: readonly string[];
  readonly requestedKinds: readonly string[];
  readonly added: readonly { readonly kind: string; readonly neededBy: string }[];
  readonly order: readonly string[];
  readonly units: readonly FillPlanUnit[];
  readonly kinds: readonly FillPlanKind[];
  readonly needsAgent: readonly FillPlanNeed[];
  readonly errors: readonly FillPlanError[];
  readonly skipped: readonly { readonly kind: string; readonly fields: readonly string[]; readonly reason: string }[];
  readonly pluginsOnly: boolean;
}

/** One agent `GET /api/agents` offers, and the one saved for this product. */
export interface AgentOffer {
  readonly id: string;
  readonly label: string;
  readonly installed: boolean;
  readonly login: 'signed-in' | 'not-signed-in' | 'unknown';
  readonly loginDetail: string;
  readonly where: string | null;
  readonly version: string | null;
  readonly install: { readonly kind: 'npm' | 'bundled'; readonly package?: string; readonly version?: string; readonly size?: string; readonly folder?: string; readonly program?: string; readonly note?: string } | null;
}

export interface AgentsAnswer {
  readonly agents: readonly AgentOffer[];
  readonly chosen: { readonly id: string; readonly label: string } | null;
}

/** One option an agent reports, and the values it offers. */
export interface AgentChoiceValue {
  readonly value: string;
  readonly name: string;
  readonly description?: string;
}

export interface AgentChoice {
  readonly configId: string | null;
  readonly name: string;
  readonly current: string | null;
  readonly values: readonly AgentChoiceValue[];
}

/** What an agent reports of its own model choices (`GET /api/agent-choices`). */
export interface AgentChoicesAnswer {
  readonly agent: { readonly id: string; readonly label: string };
  readonly choices: { readonly model: AgentChoice | null; readonly reasoning: AgentChoice | null };
}

/** One pair a model role is assigned to. */
export interface ModelPair {
  readonly agent: string;
  readonly model?: string;
  readonly reasoning?: string;
}

/** One model role as the settings resolve it. */
export interface ResolvedModelRole {
  readonly role: string;
  readonly pair: ModelPair | null;
  readonly source: 'assigned' | 'fallback' | 'none';
  readonly fallbackFrom?: string;
  readonly note?: string;
}

export interface ModelRoleView {
  readonly defaultRole: string;
  readonly defaultPair: ModelPair | null;
  readonly roles: readonly ResolvedModelRole[];
}

/** `GET /api/product-settings`: how this product is set on this machine. */
export interface ProductSettingsAnswer {
  readonly product: { readonly name: string; readonly id: string };
  readonly folder: string;
  readonly store: string;
  readonly language: string;
  readonly chosenAgent: { readonly id: string; readonly label: string; readonly model?: string; readonly reasoning?: string } | null;
  readonly roles: ModelRoleView;
  readonly agentNames: Readonly<Record<string, string>>;
  readonly bounds: {
    readonly turns: number;
    readonly minutes: number;
    readonly toolCalls: number;
    readonly writeAttempts: number;
    readonly maxDomains: number;
    readonly editorialRequestsPerPage: number;
  };
  /** The cap a fill runs under when the person names none (madarch-64o5.90). */
  readonly tokenCap: number;
  readonly danger?: unknown;
  readonly dangerError?: string;
  readonly busy: boolean;
  readonly own?: boolean;
}

/** `GET /api/settings`: the reader's own role on this machine. */
export interface ReaderSettingsAnswer {
  readonly role: string;
  readonly asked: boolean;
  readonly roles: readonly string[];
}

/** One place or entity a problem names. */
export interface ProblemLink {
  readonly label: string;
  readonly href: string | null;
  readonly key: string | null;
}

/** One problem the server computed from the graph and the fill. */
export interface Problem {
  readonly id: string;
  readonly identity: string;
  readonly section: string;
  readonly rule: string;
  readonly kind: string;
  readonly sonar: string;
  readonly severity: string;
  readonly fixer: 'agent' | 'person';
  readonly closed: boolean;
  readonly place: ProblemLink;
  readonly entity: ProblemLink | null;
  readonly evidence: readonly ProblemLink[];
  readonly scope?: unknown;
  readonly page: string | null;
  readonly pageTitle: string | null;
  readonly statement: string | null;
  readonly sentence: string | null;
  readonly target: string | null;
  readonly reason: string;
  readonly textKey?: string;
  readonly textArgs?: Readonly<Record<string, string | number>>;
  readonly file: string;
  readonly line: number | null;
  readonly source?: string;
  readonly by: { readonly name: string; readonly email: string; readonly verified: string } | null;
  readonly at: string | null;
}

export interface ProblemCategory {
  readonly rule: string;
  readonly kind: string;
  readonly section: string;
  readonly sonar: string;
  readonly severity: string;
  readonly fixer: 'agent' | 'person';
  readonly count: number;
  readonly open: number;
  readonly closed: number;
  readonly label?: Readonly<Record<string, string>>;
}

/** `GET /api/problems`: the open problems, grouped by rule. */
export interface ProblemListing {
  readonly problems: readonly Problem[];
  readonly categories: readonly ProblemCategory[];
  readonly sections: Readonly<Record<string, number>>;
  readonly open: number;
  readonly closed: number;
  readonly dismissed: number;
  readonly notes: readonly { readonly message: string; readonly textKey?: string; readonly textArgs?: Record<string, string | number> }[];
}

/** The sidebar's count, from `/api/problems?count=1`. */
export interface ProblemsCount {
  readonly open: number;
  readonly closed: number;
  readonly dismissed: number;
  readonly sections: Readonly<Record<string, number>>;
}

/** One Markdown document the graph holds. */
export interface SourceDocument {
  readonly repo: string | null;
  readonly path: string;
  readonly title: string;
  readonly kind: string;
  readonly id: string | null;
}

export interface SourceRepository {
  readonly name: string | null;
  readonly present: boolean;
  readonly filled: boolean;
}

/** `GET /api/sources`: the product's documents and repositories. */
export interface SourcesAnswer {
  readonly documents: readonly SourceDocument[];
  readonly repositories: readonly SourceRepository[];
  readonly truncated: readonly { readonly repo: string | null; readonly shown: number; readonly total: number }[];
  readonly note?: string;
}

/** The product's fill state, as much as the fill page and its button read (`GET /api/status`). */
export interface FillStatusAnswer {
  readonly fill: { readonly state: string; readonly runId?: string };
  readonly product?: { readonly name: string; readonly id: string };
  readonly repositories?: readonly { readonly name: string; readonly filled: boolean }[];
  /** Whether a fill ever succeeded on this product. */
  readonly filled?: boolean;
  /** madarch's own wiki is documentation: it offers no fill. */
  readonly own?: boolean;
}

/** One kind and plugin of a run: how much of it is done and in what state. */
export interface FillRunGroup {
  readonly kind: string;
  readonly group: string | null;
  readonly plugin: string;
  readonly done: number;
  readonly total: number;
  readonly state: string;
}

/** One thing a run recorded, as the run's own sequence states it. */
export interface FillRunEvent {
  readonly seq: number;
  readonly at: string;
  readonly stage: string;
  readonly unitId: string;
  readonly type: string;
  readonly summary: string;
}

/** `GET /api/fill-runs?run=<id>`: one run's durable state, its groups, its events and its usage. */
export interface FillRunDetail {
  readonly runId: string;
  readonly state: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
  readonly elapsedMs: number;
  readonly remainingMs: number | null;
  readonly selected: readonly string[] | null;
  readonly order: readonly string[] | null;
  readonly vertex: string | null;
  readonly groups: readonly FillRunGroup[];
  readonly units: readonly { readonly unitId: string; readonly stage: string; readonly scope: string; readonly status: string; readonly generation: number; readonly attempts: number }[];
  readonly events: readonly FillRunEvent[];
  readonly records: number;
  readonly publishedUnits: number;
  readonly agentUsage: { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number } | null;
}

// ---- the client -------------------------------------------------------------------------------------------------

export class CommandError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

function errorOf(body: unknown, status: number): { message: string; code?: string } {
  if (body !== null && typeof body === 'object') {
    const held = body as { message?: unknown; error?: { message?: unknown; code?: unknown } };
    if (typeof held.error?.message === 'string') return { message: held.error.message, ...(typeof held.error.code === 'string' ? { code: held.error.code } : {}) };
    if (typeof held.message === 'string') return { message: held.message };
  }
  return { message: `the server answered ${String(status)}` };
}

async function command<T>(base: string, path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      credentials: 'same-origin',
      ...init,
      headers: { accept: 'application/json', ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
    });
  } catch (error) {
    throw new CommandError(`the request failed (${error instanceof Error ? error.message : String(error)})`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) { const error = errorOf(body, response.status); throw new CommandError(error.message, error.code); }
  return body as T;
}

const query = (params: Record<string, string | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, value);
  return search.size === 0 ? '' : `?${search.toString()}`;
};

/** The plan of one press of these kinds (`POST /api/fill-plan`): producers, agent fields and abnormal errors. */
export function readFillPlan(base: string, selected: readonly string[], signal?: AbortSignal, pluginsOnly = false): Promise<FillPlanAnswer> {
  return command<FillPlanAnswer>(base, '/api/fill-plan', { method: 'POST', body: JSON.stringify({ selected, ...(pluginsOnly ? { pluginsOnly: true } : {}) }), ...(signal === undefined ? {} : { signal }) });
}

/** `GET /api/product`: the product's identity, read from its manifest alone. */
export const readProduct = (base: string, signal?: AbortSignal): Promise<{ readonly id: string; readonly name: string; readonly folder?: string }> => command(base, '/api/product', signal === undefined ? {} : { signal });

/** The agents the reader may pick, and the one the product saved. */
export const readAgents = (base: string, signal?: AbortSignal): Promise<AgentsAnswer> => command<AgentsAnswer>(base, '/api/agents', signal === undefined ? {} : { signal });

/** The models the chosen agent reports; asking starts its adapter on this machine. `fresh` asks it again. */
export const readAgentChoices = (base: string, agent: string, signal?: AbortSignal, fresh = false): Promise<AgentChoicesAnswer> =>
  command<AgentChoicesAnswer>(base, `/api/agent-choices${query({ agent, ...(fresh ? { fresh: '1' } : {}) })}`, signal === undefined ? {} : { signal });

/** Saves the agent that writes this product's pages; `install` is the yes to fetching an adapter that is not here. */
export const chooseAgent = (base: string, agent: string | null, install = false): Promise<{ chosen: { id: string; label: string } | null }> =>
  command(base, '/api/agent', { method: 'POST', body: JSON.stringify({ agent, install }) });

/** Assigns one model role to an agent, or removes it with null. */
export const chooseModelRole = (base: string, role: string, agent: string | null, options: { readonly model?: string | null; readonly reasoning?: string | null; readonly install?: boolean } = {}): Promise<{ roles: ModelRoleView }> =>
  command(base, '/api/model-role', { method: 'POST', body: JSON.stringify({ role, agent, ...options }) });

/** `GET /api/product-settings`: the product's settings on this machine. */
export const readProductSettings = (base: string, signal?: AbortSignal): Promise<ProductSettingsAnswer> => command(base, '/api/product-settings', signal === undefined ? {} : { signal });

/** Saves the settings the retained route takes: the pages' language, the agent's model and reasoning, the editorial bound. */
export const saveProductSettings = (base: string, change: { readonly language?: string; readonly model?: string | null; readonly reasoning?: string | null; readonly editorialRequestsPerPage?: number; readonly tokenCap?: number }): Promise<ProductSettingsAnswer> =>
  command(base, '/api/product-settings', { method: 'POST', body: JSON.stringify(change) });

/** `GET /api/settings`: the reader's own role on this machine. */
export const readReaderSettings = (base: string, signal?: AbortSignal): Promise<ReaderSettingsAnswer> => command(base, '/api/settings', signal === undefined ? {} : { signal });

/** Keeps the reader's role on this machine. */
export const saveReaderRole = (base: string, role: string): Promise<ReaderSettingsAnswer> => command(base, '/api/settings', { method: 'POST', body: JSON.stringify({ role }) });

/** `GET /api/problems`: the open problems, grouped by rule. */
export const readProblems = (base: string, signal?: AbortSignal): Promise<ProblemListing> => command(base, '/api/problems', signal === undefined ? {} : { signal });

/** The sidebar's count: the same listing's open total, without its rows. */
export const readProblemsCount = (base: string, signal?: AbortSignal): Promise<ProblemsCount> => command(base, '/api/problems?count=1', signal === undefined ? {} : { signal });

/** Records that a problem is not one, in the product's repository. */
export const dismissProblem = (base: string, id: string, reason: string): Promise<unknown> => command(base, '/api/problem-dismiss', { method: 'POST', body: JSON.stringify({ id, reason }) });

/** Opens the task a problem names. */
export const makeProblemTask = (base: string, id: string): Promise<unknown> => command(base, '/api/problem-task', { method: 'POST', body: JSON.stringify({ id }) });

/** `GET /api/sources`: the product's Markdown documents and repositories. */
export const readSources = (base: string, signal?: AbortSignal): Promise<SourcesAnswer> => command(base, '/api/sources', signal === undefined ? {} : { signal });

/** The product's own fill state, for the page's lock and the top bar's button. */
export const readFillStatus = (base: string, signal?: AbortSignal): Promise<FillStatusAnswer> => command<FillStatusAnswer>(base, '/api/status', signal === undefined ? {} : { signal });

/** The past runs, newest first. */
export const readFillRuns = (base: string, signal?: AbortSignal): Promise<{ runs: readonly FillRunDetail[] }> => command(base, '/api/fill-runs', signal === undefined ? {} : { signal });

/** One run, by its id. */
export const readFillRun = (base: string, runId: string, signal?: AbortSignal): Promise<{ run: FillRunDetail }> => command(base, `/api/fill-runs${query({ run: runId })}`, signal === undefined ? {} : { signal });

/** Starts the fill of the kinds checked: their dependencies and order are the server's. */
export const startFillSelection = (base: string, selection: { readonly selected: readonly string[]; readonly agent: string | null; readonly tokenCap: number | null; readonly pluginsOnly?: boolean }): Promise<{ runId: string; order: readonly string[] }> =>
  command(base, '/api/fill-selected', { method: 'POST', body: JSON.stringify(selection) });

/** A person's «Пауза». */
export const pauseFillRun = (base: string, runId: string): Promise<unknown> => command(base, `/api/pause${query({ run: runId })}`, { method: 'POST', body: '{}' });

/** A person's «Остановить», after the second press that confirms it. */
export const stopFillRun = (base: string, runId: string): Promise<unknown> => command(base, `/api/stop${query({ run: runId })}`, { method: 'POST', body: JSON.stringify({ confirm: true }) });

/** The product's one change stream, for a page that stays open while a fill runs. */
export const eventsAddress = (base: string): string => `${base}/api/events`;

// ---- the reads a component uses -----------------------------------------------------------------------------------

/** What one command read holds: its answer, the message of a failed read, and the way to read it again. */
export interface CommandRead<T> {
  readonly data: T | null;
  readonly error: string | null;
  readonly busy: boolean;
  readonly reload: () => void;
}

/**
 * One command read, re-run when its key changes or its `reload` is pressed. The loader is held in a ref, so a component
 * may write it inline; the key says when it must be read.
 */
export function useCommandRead<T>(key: string, load: (signal: AbortSignal) => Promise<T>, enabled = true): CommandRead<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(enabled);
  const [nonce, setNonce] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    if (!enabled) {
      setData(null);
      setBusy(false);
      return;
    }
    const controller = new AbortController();
    let alive = true;
    setBusy(true);
    loader.current(controller.signal).then(
      (answer) => { if (alive) { setData(answer); setError(null); setBusy(false); } },
      (failure: unknown) => { if (alive && !controller.signal.aborted) { setError(failure instanceof Error ? failure.message : String(failure)); setBusy(false); } },
    );
    return () => { alive = false; controller.abort(); };
  }, [key, enabled, nonce]);
  const reload = useCallback(() => { setNonce((at) => at + 1); }, []);
  return { data, error, busy, reload };
}

/** Calls the listener whenever the product's change stream says something changed; silent where the browser has none. */
export function useChangeStream(base: string, onChange: () => void): void {
  const listener = useRef(onChange);
  listener.current = onChange;
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const stream = new EventSource(eventsAddress(base));
    stream.addEventListener('change', () => { listener.current(); });
    return () => { stream.close(); };
  }, [base]);
}
