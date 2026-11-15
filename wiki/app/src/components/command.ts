
/**
 * The command client (decision 0036, section 7): the one way a command component asks the server's retained command
 * reads and presses its commands. A page's graph data comes through `/graphql`; the fill's plan, its agents, its runs and
 * its controls are workflow state, not graph data, and they are read here.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { connectionGeneration, reportOffline, reportOnline, useConnection } from '../connection.js';
import { i18n } from '../i18n.js';

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

/** Whether a failed read or press could not reach the server at all, rather than being refused by it. */
export function isOffline(error: unknown): boolean {
  return error instanceof CommandError && error.code === 'offline';
}

/** The reader's one calm line for a server that cannot be reached; a press that fails shows it instead of a request's words. */
export const offlineWords = (): string => i18n.t('connection.offline');

function errorOf(body: unknown, status: number): { message: string; code?: string } {
  if (body !== null && typeof body === 'object') {
    const held = body as { message?: unknown; error?: { message?: unknown; code?: unknown } };
    if (typeof held.error?.message === 'string') return { message: held.error.message, ...(typeof held.error.code === 'string' ? { code: held.error.code } : {}) };
    if (typeof held.message === 'string') return { message: held.message };
  }
  return { message: `the server answered ${String(status)}` };
}

/** How many changes the tab's stream has seen; a read is fresh only at the count it answered under. */
let changes = 0;

async function command<T>(base: string, path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      credentials: 'same-origin',
      ...init,
      headers: { accept: 'application/json', ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
    });
  } catch (failure) {
    // A read the app itself abandoned (its component left) says nothing about the server.
    if (init.signal?.aborted === true) throw failure;
    reportOffline();
    throw new CommandError(offlineWords(), 'offline');
  }
  if (response.status === 503) {
    reportOffline('starting');
    throw new CommandError(offlineWords(), 'offline');
  }
  if (response.status === 502 || response.status === 504) {
    reportOffline();
    throw new CommandError(offlineWords(), 'offline');
  }
  reportOnline();
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
export const startFillSelection = (base: string, selection: { readonly selected: readonly string[]; readonly agent: string | null; readonly model?: string | null; readonly reasoning?: string | null; readonly tokenCap: number | null; readonly pluginsOnly?: boolean }): Promise<{ runId: string; order: readonly string[] }> =>
  command(base, '/api/fill-selected', { method: 'POST', body: JSON.stringify(selection) });

/** A person's «Пауза». */
export const pauseFillRun = (base: string, runId: string): Promise<unknown> => command(base, `/api/pause${query({ run: runId })}`, { method: 'POST', body: '{}' });

/** A person's «Остановить», after the second press that confirms it. */
export const stopFillRun = (base: string, runId: string): Promise<unknown> => command(base, `/api/stop${query({ run: runId })}`, { method: 'POST', body: JSON.stringify({ confirm: true }) });

/** The product's one change stream, for a page that stays open while a fill runs. */
export const eventsAddress = (base: string): string => `${base}/api/events`;

// ---- the reads a component uses -----------------------------------------------------------------------------------

/** One notice the product's change stream carries: its revision and, for a unit publication, the kinds and facts it changed. */
export interface ChangeNotice {
  readonly revision: string;
  readonly kinds?: readonly string[];
  readonly facts?: number;
  readonly structure?: boolean;
}

/** What one command read holds: its answer, the message of a failed read, and the way to read it again. */
export interface CommandRead<T> {
  readonly data: T | null;
  readonly error: string | null;
  readonly busy: boolean;
  readonly reload: () => void;
}

/**
 * The reads a page asks for, shared by every component that asks the same one (madarch-64o5.85): one entry per key holds
 * the answer, the failure, the request under way and the components listening. Two components that read the problems
 * count read it once; a page that opens again over unchanged data reuses its answer, and the product's one change stream
 * is what makes it read again. A read abandoned by its last listener is aborted, and its answer stays for the next page
 * that asks.
 */
interface ReadEntry {
  data: unknown;
  error: string | null;
  busy: boolean;
  /** Whether `data` is an answer (true) or the entry still holds nothing. */
  hasAnswer: boolean;
  /** The change count the answer was read at, so a page can tell an unchanged product from a moved one. */
  changeCount: number;
  /** The recovery count the answer was read under, so a return from offline always reads again. */
  generation: number;
  /** A page's own answer goes stale when its last reader leaves: the next page reads it again. */
  stale: boolean;
  readonly listeners: Set<() => void>;
  loader: ((signal: AbortSignal) => Promise<unknown>) | null;
  controller: AbortController | null;
}

const readEntries = new Map<string, ReadEntry>();
const queuedReloads = new Set<ReadEntry>();

function entryFor(key: string): ReadEntry {
  let entry = readEntries.get(key);
  if (entry === undefined) {
    entry = { data: null, error: null, busy: false, hasAnswer: false, changeCount: -1, generation: connectionGeneration(), stale: true, listeners: new Set(), loader: null, controller: null };
    readEntries.set(key, entry);
  }
  return entry;
}

function announce(entry: ReadEntry): void {
  for (const listener of entry.listeners) listener();
}

function start(entry: ReadEntry): void {
  if (entry.loader === null) return;
  entry.controller?.abort();
  const controller = new AbortController();
  entry.controller = controller;
  entry.busy = true;
  entry.error = null;
  announce(entry);
  const loader = entry.loader;
  const answeredAt = changes;
  loader(controller.signal).then(
    (answer) => {
      if (entry.controller !== controller) return;
      entry.controller = null;
      entry.data = answer;
      entry.hasAnswer = true;
      entry.changeCount = answeredAt;
      entry.generation = connectionGeneration();
      entry.stale = false;
      entry.error = null;
      entry.busy = false;
      announce(entry);
    },
    (failure: unknown) => {
      if (entry.controller !== controller) return;
      entry.controller = null;
      entry.busy = false;
      if (controller.signal.aborted) { announce(entry); return; }
      // The frame already says the server cannot be reached: a page does not repeat it in a request's words.
      entry.error = isOffline(failure) ? null : failure instanceof Error ? failure.message : String(failure);
      entry.hasAnswer = false;
      announce(entry);
    },
  );
}

/** One reload for every component that pressed in the same turn: they share the request, not one each. */
function requestReload(entry: ReadEntry): void {
  if (queuedReloads.has(entry)) return;
  queuedReloads.add(entry);
  queueMicrotask(() => {
    queuedReloads.delete(entry);
    if (entry.listeners.size > 0) start(entry);
  });
}

/**
 * One command read, shared by its key. A mount reads when the entry holds nothing, when the product changed since the
 * answer, or when the server has returned since; otherwise it shows the answer already held. `reload` reads again, and
 * components that press it together make one request.
 */
export function useCommandRead<T>(key: string, load: (signal: AbortSignal) => Promise<T>, enabled = true): CommandRead<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; busy: boolean }>({ data: null, error: null, busy: enabled });
  const loader = useRef(load);
  loader.current = load;
  const held = useRef<ReadEntry | null>(null);
  const connection = useConnection();
  // The banner's probe owns the retry schedule while the link is away; a retained page must not keep pressing beside it.
  const offline = useRef(connection.offline);
  offline.current = connection.offline;
  useEffect(() => {
    if (!enabled) {
      held.current = null;
      setState({ data: null, error: null, busy: false });
      return;
    }
    const entry = entryFor(key);
    held.current = entry;
    entry.loader = loader.current;
    const update = (): void => setState({ data: entry.data as T | null, error: entry.error, busy: entry.busy });
    entry.listeners.add(update);
    update();
    const returned = connection.generation !== entry.generation;
    entry.generation = connection.generation;
    const fresh = entry.hasAnswer && !entry.stale && entry.changeCount === changes && !returned;
    if (connection.offline && !entry.hasAnswer) return;
    if (returned) start(entry);
    else if (!entry.busy && !fresh) start(entry);
    return () => {
      if (held.current === entry) held.current = null;
      entry.listeners.delete(update);
      if (entry.listeners.size === 0) {
        entry.controller?.abort();
        entry.controller = null;
        entry.busy = false;
        entry.stale = true;
        forgetReadsWhenIdle();
      }
    };
  }, [key, enabled, connection.generation]);
  const reload = useCallback(() => {
    const entry = held.current;
    if (entry !== null && !offline.current) requestReload(entry);
  }, []);
  return { data: state.data, error: state.error, busy: state.busy, reload };
}

// ---- the product's one change stream ------------------------------------------------------------------------------

interface SharedStream {
  source: EventSource;
  readonly listeners: Set<(notice: ChangeNotice) => void>;
  /** Whether the current connection's opening revision was read. */
  opened: boolean;
  /** The last revision this tab read; a reconnect's opening revision is a change only if it moved. */
  seenRevision: string | undefined;
}

const changeStreams = new Map<string, SharedStream>();

function wire(stream: SharedStream): void {
  const source = stream.source;
  stream.opened = false;
  source.addEventListener('change', (event: MessageEvent<string>) => {
    let notice: ChangeNotice = { revision: '' };
    try {
      const data = JSON.parse(event.data) as Record<string, unknown>;
      notice = {
        revision: typeof data['revision'] === 'string' ? data['revision'] : '',
        ...(Array.isArray(data['kinds']) ? { kinds: data['kinds'].filter((kind): kind is string => typeof kind === 'string') } : {}),
        ...(typeof data['facts'] === 'number' ? { facts: data['facts'] } : {}),
        ...(data['structure'] === true ? { structure: true } : {}),
      };
    } catch {
      // A notice without JSON is a revision change alone.
    }
    const opening = !stream.opened;
    stream.opened = true;
    if (opening) {
      // The first notice names the revision this connection opened at. It is not a change when it is the revision the
      // tab last read; it is one when the graph moved while the stream was away.
      if (stream.seenRevision === undefined || notice.revision === stream.seenRevision) {
        stream.seenRevision = notice.revision;
        return;
      }
    }
    stream.seenRevision = notice.revision;
    changes += 1;
    for (const listener of stream.listeners) listener(notice);
  });
  source.addEventListener('error', () => { reportOffline(); });
  source.addEventListener('open', () => { stream.opened = false; reportOnline(); });
}

function streamFor(base: string): SharedStream {
  let stream = changeStreams.get(base);
  if (stream === undefined) {
    stream = { source: new EventSource(eventsAddress(base)), listeners: new Set(), opened: false, seenRevision: undefined };
    wire(stream);
    changeStreams.set(base, stream);
  }
  return stream;
}

/** A server that refused the stream closes it for good; a return replaces it, keeping the last revision. */
function reopenChangeStream(base: string): void {
  const stream = changeStreams.get(base);
  if (stream === undefined || stream.source.readyState !== 2) return;
  const old = stream.source;
  stream.source = new EventSource(eventsAddress(base));
  wire(stream);
  old.close();
}

/** Calls the listener whenever the product's change stream says something changed; one stream is shared by every caller. */
export function useChangeStream(base: string, onChange: (notice: ChangeNotice) => void): void {
  const listener = useRef(onChange);
  listener.current = onChange;
  const connection = useConnection();
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const stream = streamFor(base);
    const call = (notice: ChangeNotice): void => { listener.current(notice); };
    stream.listeners.add(call);
    return () => {
      stream.listeners.delete(call);
      if (stream.listeners.size === 0) {
        stream.source.close();
        if (changeStreams.get(base) === stream) changeStreams.delete(base);
        forgetReadsWhenIdle();
      }
    };
  }, [base]);
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    if (connection.generation > 0) reopenChangeStream(base);
  }, [base, connection.generation]);
}

/** A tab with no reader and no stream forgets what it read: the next app on the page starts from nothing. */
function forgetReadsWhenIdle(): void {
  if (changeStreams.size > 0) return;
  for (const entry of readEntries.values()) if (entry.listeners.size > 0) return;
  for (const entry of readEntries.values()) entry.controller?.abort();
  readEntries.clear();
  queuedReloads.clear();
  changes = 0;
}
