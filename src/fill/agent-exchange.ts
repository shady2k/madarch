/**
 * The record of one agent unit's whole ACP exchange (madarch-64o5.88): what madarch
 * handed the agent, every tool call it made and what came back, the answer it returned,
 * the tokens it was charged and the time it took — kept by madarch itself, beside the
 * run's trace, so the exchange never lives only in the agent's own transcript.
 *
 * What a record holds and what it never holds: the prompt madarch built (the plugin's
 * instructions, the graph files the unit may open, the unit's task and the output
 * contract), the update kinds `message`, `thought`, `tool-call`, `tool-call-update`,
 * `plan` and any unknown one, every file the agent read through madarch's file
 * callbacks, the answer text, the agent's own usage report, and the stop reason. It
 * never holds an environment value, an authentication header, the adapter's standard
 * error or anything else the agent process was started with: those are the host's, not
 * the exchange's, and a secret in a record is a secret in a file a reader may open.
 *
 * The bounds are the record's own: each text, the prompt, the answer and each list have
 * their own cut, and their sum keeps one unit's exchange under a few hundred kilobytes.
 * A cut is always said — `cut`, `stepsDropped`, `openedDropped` — so a reader is never
 * shown less than the record holds without being told.
 *
 * One file per unit, under `<store>/traces/<run>.agents/`: units of one run may run at
 * once, and a file each is a write no other unit's write can interleave. The folder goes
 * with the run's trace when the trace is trimmed.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { byCodePoint } from '../model/order.js';
import type { AcpUpdate } from './acp.js';
import { agentExchangeFolder, recordFileName } from './run-records.js';

// The folder is read here and written by `src/fill/run-records.ts`: a test and the run's own reader name it from here.
export { agentExchangeFolder };

/** The schema tag of a record, so a reader knows what it read. */
export const AGENT_EXCHANGE_SCHEMA = 'madarch.agent-exchange@1';
/** The characters one text field of a step holds before it is cut. */
const TEXT_CHARACTERS = 4_000;
/** The characters the prompt holds before it is cut: the plugin's words, the file list, the task, the contract. */
const PROMPT_CHARACTERS = 48_000;
/** The characters the answer and a step's detail hold. */
const ANSWER_CHARACTERS = 8_000;
/** How many steps, files the unit could open, and file reads one record keeps, and how much the steps may take. */
export const MAX_STEPS = 300;
const MAX_FILE_NAMES = 100;
const MAX_OPENED = 200;
const MAX_STEPS_BYTES = 128 * 1024;
/** The characters one file name, a title or a tool call's path holds. */
const MAX_FILE_NAME_CHARACTERS = 300;

/** The step kinds the record keeps: the protocol's own tag, as madarch names it. */
const STEP_KINDS: Readonly<Record<string, AgentExchangeStep['kind']>> = {
  message: 'message', thought: 'thought', 'tool-call': 'tool-call', 'tool-call-update': 'tool-call-update', plan: 'plan', other: 'other',
};

/** One file read the agent made through madarch's file callbacks: which file, which lines, how many bytes. */
export interface AgentExchangeOpen {
  readonly at: string;
  readonly repository: string;
  readonly path: string;
  readonly line?: number;
  readonly limit?: number;
  readonly bytes: number;
}

/** One step of the exchange, as the agent streamed it. */
export interface AgentExchangeStep {
  readonly at: string;
  /** The protocol's own tag: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`. */
  readonly sessionUpdate: string;
  readonly kind: 'message' | 'thought' | 'tool-call' | 'tool-call-update' | 'plan' | 'other';
  /** A tool call's title, and its kind (`read`, `edit`, `execute`, …) and status as the agent reported them. */
  readonly title?: string;
  readonly tool?: string;
  readonly status?: string;
  /** The file a tool call names in its locations, when it names one. */
  readonly path?: string;
  /** A message or a thought's text. */
  readonly text?: string;
  /** A tool call's own input and output, as the agent reported them, serialized and cut. */
  readonly detail?: string;
  readonly bytes?: number;
  readonly cut?: boolean;
}

/** What the agent was given: the prompt as sent, the task object, and the files it could open. */
export interface AgentExchangeGiven {
  readonly prompt: string;
  readonly bytes: number;
  readonly cut: boolean;
  readonly task: unknown;
  /** The graph files the unit's roots exposed, as virtual names (`repository/path`); the first `MAX_FILE_NAMES`. */
  readonly files: readonly string[];
  readonly filesTotal: number;
}

/** What the agent returned, and its own usage report. */
export interface AgentExchangeReturned {
  readonly text: string;
  readonly bytes: number;
  readonly cut: boolean;
}

export interface AgentExchangeUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly context?: { readonly used: number; readonly size: number };
  readonly turns: number;
  readonly reported: boolean;
}

/** One agent unit's whole exchange, as madarch keeps it with the run. */
export interface AgentExchangeRecord {
  readonly schema: typeof AGENT_EXCHANGE_SCHEMA;
  readonly run: string;
  /** The plugin turn's unit id, `<plugin>:<kind>` (with `@<vertex>` for a scoped unit). */
  readonly unit: string;
  readonly agent: string;
  readonly model: string | null;
  readonly session: string | null;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  /** How the unit ended: the agent answered, the unit failed, or the turn was cancelled. */
  readonly state: 'turned' | 'failed' | 'cancelled';
  readonly given: AgentExchangeGiven;
  readonly steps: readonly AgentExchangeStep[];
  /** How many steps, and how many file reads, the bounds left out. */
  readonly stepsDropped: number;
  readonly opened: readonly AgentExchangeOpen[];
  readonly openedDropped: number;
  readonly returned: AgentExchangeReturned | null;
  readonly usage: AgentExchangeUsage | null;
  /** The protocol's stop reason: `end_turn`, `cancelled`, `max_tokens`. */
  readonly stop: string | null;
  /** Why the unit failed, in madarch's own words, when it did. */
  readonly failure: string | null;
}

/** Cuts a text to its bound, answering the text and whether it was cut. */
function cut(text: string, characters: number): { text: string; cut: boolean } {
  return text.length <= characters ? { text, cut: false } : { text: text.slice(0, characters), cut: true };
}

/** The serialization of a value for a detail field: a string as it stands, anything else as JSON, cut. */
function serialize(value: unknown, characters: number): { text: string; bytes: number; cut: boolean } | undefined {
  if (value === undefined) return undefined;
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try { text = JSON.stringify(value) ?? String(value); } catch { text = String(value); }
  }
  const held = cut(text, characters);
  return { text: held.text, bytes: Buffer.byteLength(text, 'utf8'), cut: held.cut };
}

/** A text as the object it spells, or the text itself when it does not spell one. */
function parseOr(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

/** The file a tool call names in its locations, when it names one. */
function locationPath(raw: unknown): string | undefined {
  const locations = (raw as { locations?: unknown } | null)?.locations;
  if (!Array.isArray(locations)) return undefined;
  for (const entry of locations) {
    const path = (entry as { path?: unknown } | null)?.path;
    if (typeof path === 'string' && path !== '') return path;
  }
  return undefined;
}

/** The file one unit's exchange is kept in: its unit id, made a file name, and a digest so two ids stay two files. */
export function agentExchangeFile(folder: string, unit: string): string {
  return join(folder, recordFileName(unit, 'json'));
}

/**
 * The record of one agent unit, built as the unit runs and written once it ends. The
 * caller creates it before the agent starts, so a unit that never answered still leaves
 * what it was given and why it failed.
 */
export class AgentExchangeRecorder {
  private readonly startedAt = new Date();
  private model: string | null = null;
  private session: string | null = null;
  private given: AgentExchangeGiven = { prompt: '', bytes: 0, cut: false, task: null, files: [], filesTotal: 0 };
  private readonly steps: AgentExchangeStep[] = [];
  private stepsDropped = 0;
  private stepsBytes = 0;
  private readonly opened: AgentExchangeOpen[] = [];
  private openedDropped = 0;
  private returned: AgentExchangeReturned | null = null;
  private usage: AgentExchangeUsage | null = null;
  private stopReason: string | null = null;
  private state: AgentExchangeRecord['state'] = 'turned';
  private failure: string | null = null;
  private written: string | undefined;
  constructor(private readonly options: { readonly folder: string; readonly run: string; readonly unit: string; readonly agent: string }) {}

  /** What madarch handed the agent: the prompt it sent, the task object and the files it may open. */
  setGiven(given: { readonly prompt: string; readonly task: unknown; readonly files: readonly string[] }): void {
    const prompt = cut(given.prompt, PROMPT_CHARACTERS);
    const task = serialize(given.task, ANSWER_CHARACTERS);
    this.given = {
      prompt: prompt.text, bytes: Buffer.byteLength(given.prompt, 'utf8'), cut: prompt.cut,
      // The task as the object it was, unless the bound cut it: then its cut text stands in its place.
      task: task === undefined ? null : parseOr(task.text),
      files: given.files.slice(0, MAX_FILE_NAMES).map((file) => cut(file, MAX_FILE_NAME_CHARACTERS).text),
      filesTotal: given.files.length,
    };
  }

  /** The session the unit's turn runs in, and the model it reports. */
  setSession(session: string, model: string | null): void {
    this.session = session;
    this.model = model;
  }

  /** One `session/update` of the turn, kept as a step of the record within its bounds. */
  step(update: AcpUpdate): void {
    // A mode, a command list, a config change and a usage update are the protocol's own bookkeeping: the usage is kept
    // in the record's own field, and the rest says nothing about what the unit was given or did.
    const kind = STEP_KINDS[update.kind];
    if (kind === undefined) return;
    if (this.steps.length >= MAX_STEPS) { this.stepsDropped += 1; return; }
    const raw = update.raw as Record<string, unknown> | null | undefined;
    const path = kind === 'message' || kind === 'thought' ? undefined : locationPath(raw);
    const detail = kind === 'message' || kind === 'thought' ? undefined
      : serialize(raw?.['rawOutput'] ?? raw?.['rawInput'] ?? (kind === 'plan' ? raw?.['entries'] : undefined), TEXT_CHARACTERS);
    const text = kind === 'message' || kind === 'thought' ? (update.text === undefined ? undefined : cut(update.text, TEXT_CHARACTERS)) : undefined;
    const held: AgentExchangeStep = {
      at: update.at, sessionUpdate: update.sessionUpdate, kind,
      ...(update.title === undefined ? {} : { title: cut(update.title, MAX_FILE_NAME_CHARACTERS).text }),
      ...(update.toolKind === undefined ? {} : { tool: update.toolKind }),
      ...(update.status === undefined ? {} : { status: update.status }),
      ...(path === undefined ? {} : { path: cut(path, MAX_FILE_NAME_CHARACTERS).text }),
      ...(text === undefined ? {} : { text: text.text, cut: text.cut, bytes: Buffer.byteLength(update.text ?? '', 'utf8') }),
      ...(detail === undefined ? {} : { detail: detail.text, bytes: detail.bytes, cut: detail.cut }),
    };
    // The bytes one step adds are what the bound counts: a turn that talks for a page still leaves a record a person
    // can open.
    const size = Buffer.byteLength(JSON.stringify(held), 'utf8');
    if (this.stepsBytes + size > MAX_STEPS_BYTES) { this.stepsDropped += 1; return; }
    this.stepsBytes += size;
    this.steps.push(held);
  }

  /** One file the agent read through madarch's file callbacks. */
  fileOpen(read: { readonly repository: string; readonly path: string; readonly line?: number; readonly limit?: number; readonly bytes: number }): void {
    if (this.opened.length >= MAX_OPENED) { this.openedDropped += 1; return; }
    this.opened.push({
      at: new Date().toISOString(), repository: read.repository, path: read.path,
      ...(read.line === undefined ? {} : { line: read.line }),
      ...(read.limit === undefined ? {} : { limit: read.limit }),
      bytes: read.bytes,
    });
  }

  /** What the agent returned, as its message text. */
  answer(text: string, stopReason: string | null): void {
    const held = cut(text, ANSWER_CHARACTERS);
    this.returned = { text: held.text, bytes: Buffer.byteLength(text, 'utf8'), cut: held.cut };
    this.stopReason = stopReason;
    this.state = stopReason === 'cancelled' ? 'cancelled' : 'turned';
  }

  /** The agent's own usage report, as reported and never invented. */
  setUsage(report: AgentExchangeUsage): void {
    this.usage = {
      ...(report.inputTokens === undefined ? {} : { inputTokens: report.inputTokens }),
      ...(report.outputTokens === undefined ? {} : { outputTokens: report.outputTokens }),
      ...(report.totalTokens === undefined ? {} : { totalTokens: report.totalTokens }),
      ...(report.context === undefined ? {} : { context: { used: report.context.used, size: report.context.size } }),
      turns: report.turns, reported: report.reported,
    };
  }

  /** The unit failed: the reason in madarch's own words is what the record keeps. A cancelled turn keeps its word. */
  failed(error: unknown): void {
    if (this.state !== 'cancelled') this.state = 'failed';
    this.failure = cut(error instanceof Error ? error.message : String(error), ANSWER_CHARACTERS).text;
  }

  /** The unit was cancelled by its run or its turn's own bound. */
  cancelled(): void {
    if (this.state === 'turned') this.state = 'cancelled';
  }

  /** Writes the record once, and answers its path; a record that cannot be written is not the unit's failure. */
  finish(): string | undefined {
    if (this.written !== undefined) return this.written;
    const endedAt = new Date();
    const record: AgentExchangeRecord = {
      schema: AGENT_EXCHANGE_SCHEMA,
      run: this.options.run, unit: this.options.unit, agent: this.options.agent,
      model: this.model, session: this.session,
      startedAt: this.startedAt.toISOString(), endedAt: endedAt.toISOString(), durationMs: Math.max(0, endedAt.getTime() - this.startedAt.getTime()),
      state: this.state, given: this.given,
      steps: [...this.steps], stepsDropped: this.stepsDropped,
      opened: [...this.opened], openedDropped: this.openedDropped,
      returned: this.returned, usage: this.usage, stop: this.stopReason, failure: this.failure,
    };
    const text = `${JSON.stringify(record, null, 1)}\n`;
    try {
      mkdirSync(this.options.folder, { recursive: true });
      const file = agentExchangeFile(this.options.folder, this.options.unit);
      writeFileSync(file, text, 'utf8');
      this.written = file;
    } catch {
      // The record is evidence, not the work: a folder that cannot be written must not fail the unit.
    }
    return this.written;
  }
}

/** What a run's exchanges read as: the records, and the files of the folder that were not one. */
export interface AgentExchangesRead {
  readonly units: readonly AgentExchangeRecord[];
  readonly problems: readonly string[];
}

/**
 * The exchanges one run kept, in code point order of their unit ids. A folder that is
 * not there is a run that ran no agent unit (or one whose trace was trimmed): no records
 * and no problems.
 */
export function readRunAgentExchanges(tracesFolder: string, run: string): AgentExchangesRead {
  const folder = agentExchangeFolder(tracesFolder, run);
  let names: string[];
  try { names = readdirSync(folder); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { units: [], problems: [] };
    return { units: [], problems: [`${folder}: the agent exchanges of run ${JSON.stringify(run)} cannot be read: ${(error as Error).message}`] };
  }
  const units: AgentExchangeRecord[] = [];
  const problems: string[] = [];
  for (const name of names.filter((held) => held.endsWith('.json')).sort(byCodePoint)) {
    const file = join(folder, name);
    try {
      const record = JSON.parse(readFileSync(file, 'utf8')) as AgentExchangeRecord;
      if (record.schema !== AGENT_EXCHANGE_SCHEMA || typeof record.unit !== 'string' || typeof record.given !== 'object' || record.given === null) throw new Error(`not a ${AGENT_EXCHANGE_SCHEMA} record`);
      units.push(record);
    } catch (error) {
      problems.push(`${file}: ${(error as Error).message}`);
    }
  }
  return { units, problems };
}
