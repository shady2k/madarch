
/**
 * The meter of a plugin's agent part (madarch-stm0.4, decision 0035, item 22): every model call is counted from the
 * agent's own usage reports — the model, the tokens in and out and the cost — per plugin run, kind and field, and the
 * run stops with the reason when a declared bound is crossed.
 *
 * What the protocol reports, as this meter reads it:
 *
 * - A `usage_update` (ACP's `SessionUpdate.usage_update`, read on 2026-11-11 at
 *   `agentclientprotocol.com/protocol/v1/prompt-turn.md`, section "Session usage updates") states the session's context
 *   (`used`, `size`, both required) and, when the adapter reports it, `cost: { amount, currency }`, whose amount is the
 *   **cumulative** cost of the session. It carries no token counts of its own.
 * - The tokens in and out come from the adapter's equivalent: the `usage` of the `session/prompt` answer. The library's
 *   generated schema (`@agentclientprotocol/sdk` 1.9.0, `PromptResponse.usage`) marks it unstable and says its fields
 *   are the "Total … across all turns"; the adapter checked here, `@agentclientprotocol/claude-agent-acp` 0.106.0
 *   (`dist/v1/acp-agent.js`, `sessionUsage`), fills it from the session's accumulated usage, so it is cumulative too.
 *   The published v1 schema states no usage on the answer at all, so an agent that reports none is a row that says so,
 *   never a zero.
 *
 * Because both reports are cumulative, the meter never adds two reports: it keeps the last total of each session and
 * counts the difference, and a reading that fell below the one before it is taken as the whole increment, because the
 * running total restarted under it. A row is one plugin run's spend in one kind, one field and one model; `turns`
 * counts the prompt turns, reported or not.
 *
 * The bounds are declared, never picked here: a plugin's `bounds:` in the product's manifest (decision 0035, item 22:
 * "a token and cost bound per run") is the unit meter's own bound, and the catalogue's token cap for the whole fill run
 * (`fill_selection_settings`, the person's press) is the one counter its plugin runs share, an `AgentRunBudget`. A
 * crossed bound is a value, `AgentUsageStop`, that names the unit, the scope and the numbers; `runTurn` cancels the
 * turn on it, and the caller ends the unit with it.
 *
 * The spend is written through `src/adapters/agent-usage.ts` after every turn (a crash costs the turn in flight, never
 * the run), and each turn's increment is one `agent.usage` span of the run's trace, so `madarch trace` and the run page
 * state what the model calls cost.
 */
import type { AcpPromptResult, AcpUpdate, AcpUsageReport } from './acp.js';
import type { AgentUsageAmount, AgentUsageRecord } from '../adapters/agent-usage.js';
import type { PluginBounds } from '../product/manifest/kinds.js';
import { byCodePoint } from '../model/order.js';
import { withSpanSync } from '../obs/trace.js';

/** The site every message and span of this module names. */
const WHERE = 'src/fill/agent-meter.ts';

/** One bound crossed, as the caller ends the unit with it. */
export interface AgentUsageStop {
  /** Which bound: the plugin's own, declared in the manifest, or the whole fill run's, declared in the fill's settings. */
  readonly scope: 'plugin' | 'run';
  readonly bound: 'tokens' | 'cost';
  /** What was spent when the bound was crossed: tokens, or the amount in `currency`. */
  readonly spent: number;
  readonly limit: number;
  /** The currency of a cost bound, and null for a token bound. */
  readonly currency: string | null;
  /** The unit whose run stopped, and its plugin. */
  readonly unit: string;
  readonly plugin: string;
  /** The words a person reads: the file and site, the unit, what was spent and the bound. */
  readonly message: string;
}

/**
 * The tokens one row spent: the largest of the total the agent reported and the sum of its parts, so a bound counts
 * what the agent itself said it spent and never less.
 */
export function spentTokensOf(tokens: { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number }): number {
  return Math.max(tokens.totalTokens, tokens.inputTokens + tokens.outputTokens);
}

/** One number as the report of a turn states it, when it is a number a meter can count. */
function counted(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The difference a cumulative reading adds, taking a reading that fell below the last as a restarted total. */
function incrementOf(current: number, last: number | undefined): number {
  if (last === undefined || current < last) return current;
  return current - last;
}

/** A number with its thousands separated, for the words of a stop. */
function tokensText(tokens: number): string {
  return tokens.toLocaleString('en-US');
}

/** The amounts of one row, in code point order of their currency. */
function sortedAmounts(cost: ReadonlyMap<string, number>): AgentUsageAmount[] {
  return [...cost.entries()].map(([currency, amount]) => ({ amount: Number(amount.toFixed(6)), currency }))
    .sort((left, right) => byCodePoint(left.currency, right.currency));
}

/**
 * The one counter the plugin runs of a fill run share: the catalogue's token cap bounds the whole run, so every meter
 * of that run spends from this one, and the bound that is crossed is the run's own. (The fill's settings declare no
 * cost cap: a cost bound is the product's, per plugin, in its manifest.)
 */
export class AgentRunBudget {
  /** The tokens the run spent so far, as the meters reported them. */
  #tokens = 0;
  readonly #limit: number | undefined;

  constructor(options: { readonly tokens?: number } = {}) {
    if (options.tokens !== undefined && (!Number.isInteger(options.tokens) || options.tokens < 1)) {
      throw new Error(`${WHERE}:AgentRunBudget: a token bound is a whole number of 1 or more, not ${JSON.stringify(options.tokens)}`);
    }
    this.#limit = options.tokens;
  }

  /** The tokens the run spent so far. */
  get tokens(): number {
    return this.#tokens;
  }

  /** Spends one increment, and answers the bound it crossed, if it crossed one. */
  spend(tokens: number): { readonly bound: 'tokens'; readonly spent: number; readonly limit: number; readonly currency: null } | undefined {
    if (tokens > 0) this.#tokens += tokens;
    const limit = this.#limit;
    if (limit !== undefined && this.#tokens > limit) return { bound: 'tokens', spent: this.#tokens, limit, currency: null };
    return undefined;
  }
}

/** The part of a session a metered turn needs: one prompt, its updates and the caller's signal. */
interface MeterableSession {
  prompt(text: string, options?: { onUpdate?: (update: AcpUpdate) => void; signal?: AbortSignal }): Promise<AcpPromptResult>;
}

/** One row the meter holds, before it becomes a stored record. */
interface MeterRow {
  readonly unit: string;
  readonly kind: string;
  readonly field: string;
  readonly model: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  readonly cost: Map<string, number>;
  turns: number;
  reported: boolean;
  stopped: 'tokens' | 'cost' | null;
}

/** What the meter knows of one ACP session: the last cumulative report of each number. */
interface SessionBaseline {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  readonly cost: Map<string, number>;
}

export interface AgentMeterOptions {
  /** The fill run the spend belongs to, as its trace names it. */
  readonly run: string;
  /** The plugin run's unit id. */
  readonly unit: string;
  readonly plugin: string;
  readonly pluginVersion: string;
  /** The kind the unit fills, until a turn names another (a whole-graph plugin answers several in one unit). */
  readonly kind: string;
  /** The bounds the product's manifest declares for one run of this plugin. */
  readonly bounds?: PluginBounds;
  /** The counter the whole fill run is held to, shared by the run's plugin meters. */
  readonly budget?: AgentRunBudget;
  /** Where the rows go after every turn; `src/adapters/agent-usage.ts`'s `recordAgentUsage` is what a fill passes. */
  readonly save?: (rows: readonly AgentUsageRecord[]) => Promise<void> | void;
}

/** The fields one prompt turn is metered into. */
export interface MeterTurnOptions {
  /** The kind the turn works on; the meter's own kind when it is left out. */
  readonly kind?: string;
  /** The field the turn was asked to fill; `''` is the unit's work in the kind as a whole. */
  readonly field?: string;
  /** The model the session uses, as the adapter names it; null when it names none. */
  readonly model?: string | null;
}

/**
 * The meter of one plugin run: created per unit, told each prompt turn and each `session/update` the turn streams, and
 * asked whether a bound was crossed. `meterSessionUpdate` is the one function the agent part calls per session update;
 * `beginTurn` names what the turn is filling, and `endTurn` counts the turn's report and writes the spend.
 */
export class AgentMeter {
  readonly #options: AgentMeterOptions;
  readonly #rows = new Map<string, MeterRow>();
  readonly #sessions = new Map<string, SessionBaseline>();
  /** The session whose reports are cumulative now. */
  #session = '';
  #turn: Required<MeterTurnOptions>;
  #context: { readonly used: number; readonly size: number } | undefined;
  #stop: AgentUsageStop | undefined;

  constructor(options: AgentMeterOptions) {
    if (options.run.trim() === '' || options.unit.trim() === '' || options.plugin.trim() === '' || options.kind.trim() === '') {
      throw new Error(`${WHERE}:AgentMeter: a meter is named by its run, its unit, its plugin and its kind, and one of them is empty (${JSON.stringify({ run: options.run, unit: options.unit, plugin: options.plugin, kind: options.kind })})`);
    }
    this.#options = options;
    this.#turn = { kind: options.kind, field: '', model: null };
  }

  /** A new ACP session: its cumulative reports start from its own zero. */
  beginSession(): void {
    this.#session = String(Number(this.#session) + 1);
  }

  /** The turn about to be asked: what it fills and the model it runs on. */
  beginTurn(options: MeterTurnOptions = {}): void {
    this.#turn = {
      kind: options.kind ?? this.#options.kind,
      field: options.field ?? '',
      model: options.model === undefined ? this.#turn.model : options.model,
    };
  }

  /**
   * One `session/update` of the session: a `usage_update`'s cost is counted here, and the context it states is kept
   * beside it. Answers the bound this update crossed, if it crossed one, so the caller can cancel the turn; the first
   * crossing stands, and a later one does not replace it.
   */
  meterSessionUpdate(update: AcpUpdate): AgentUsageStop | undefined {
    if (update.kind === 'usage' && update.contextUsed !== undefined && update.contextSize !== undefined) {
      this.#context = { used: update.contextUsed, size: update.contextSize };
    }
    if (update.kind === 'usage' && update.cost !== undefined) {
      const baseline = this.#baseline();
      const last = baseline.cost.get(update.cost.currency);
      const delta = incrementOf(update.cost.amount, last);
      baseline.cost.set(update.cost.currency, update.cost.amount);
      if (delta > 0) this.#add(0, 0, 0, [{ amount: delta, currency: update.cost.currency }]);
    }
    return this.#stop;
  }

  /**
   * The turn ended: its answer's usage is counted (a cumulative report less the session's last), the turn is one more
   * of the row, and the spend is written. Answers the bound this turn crossed, if it crossed one.
   */
  async endTurn(result: { readonly usage?: AcpUsageReport }): Promise<AgentUsageStop | undefined> {
    const usage = result.usage;
    const row = this.#row();
    row.turns += 1;
    let tokensIn = 0;
    let tokensOut = 0;
    let tokensTotal = 0;
    if (usage !== undefined) {
      const baseline = this.#baseline();
      const input = counted(usage.inputTokens);
      const output = counted(usage.outputTokens);
      const total = counted(usage.totalTokens);
      tokensIn = input === undefined ? 0 : incrementOf(input, baseline.inputTokens);
      tokensOut = output === undefined ? 0 : incrementOf(output, baseline.outputTokens);
      tokensTotal = total === undefined ? 0 : incrementOf(total, baseline.totalTokens);
      if (input !== undefined) baseline.inputTokens = input;
      if (output !== undefined) baseline.outputTokens = output;
      if (total !== undefined) baseline.totalTokens = total;
      if (input !== undefined || output !== undefined || total !== undefined) {
        row.reported = true;
        this.#add(tokensIn, tokensOut, tokensTotal, []);
      }
    }
    this.#writeSpan(tokensIn, tokensOut, tokensTotal);
    await this.#save();
    return this.#stop;
  }

  /** The bound that ended this run, when one did. */
  stop(): AgentUsageStop | undefined {
    return this.#stop;
  }

  /** The session's context as its last `usage_update` stated it. */
  context(): { readonly used: number; readonly size: number } | undefined {
    return this.#context;
  }

  /** Every row this meter holds, as the store and the page read them. */
  rows(): AgentUsageRecord[] {
    return [...this.#rows.values()].map((row) => ({
      run: this.#options.run,
      unit: row.unit,
      plugin: this.#options.plugin,
      pluginVersion: this.#options.pluginVersion,
      kind: row.kind,
      field: row.field,
      model: row.model,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      totalTokens: row.totalTokens,
      cost: sortedAmounts(row.cost)[0] ?? null,
      turns: row.turns,
      reported: row.reported,
      stopped: row.stopped,
    }));
  }

  /** The run's spend as it stands: tokens in, out and total, and the cost per currency. */
  spent(): { readonly tokens: number; readonly cost: readonly AgentUsageAmount[] } {
    let tokens = 0;
    const cost = new Map<string, number>();
    for (const row of this.#rows.values()) {
      tokens += spentTokensOf(row);
      for (const [currency, amount] of row.cost) cost.set(currency, (cost.get(currency) ?? 0) + amount);
    }
    return { tokens, cost: sortedAmounts(cost) };
  }

  /**
   * One prompt turn of a session, metered: the updates go through `meterSessionUpdate`, the answer through `endTurn`,
   * and a bound the updates cross cancels the turn at once — the ACP cancel and the answer as cancelled, exactly as the
   * caller's own signal does (`src/fill/acp.ts`). The turn's own answer may cross a bound too; then it has already
   * ended, and the stop is the caller's to end the unit with.
   */
  async runTurn(session: MeterableSession, prompt: string, options: MeterTurnOptions & { readonly signal?: AbortSignal } = {}): Promise<{ readonly result: AcpPromptResult; readonly stop: AgentUsageStop | undefined }> {
    this.beginTurn({ ...(options.kind === undefined ? {} : { kind: options.kind }), ...(options.field === undefined ? {} : { field: options.field }), ...(options.model === undefined ? {} : { model: options.model }) });
    const controller = new AbortController();
    const outer = options.signal;
    const signal = outer === undefined ? controller.signal : AbortSignal.any([controller.signal, outer]);
    const onUpdate = (update: AcpUpdate): void => {
      const stop = this.meterSessionUpdate(update);
      if (stop !== undefined && !controller.signal.aborted) controller.abort();
    };
    let result: AcpPromptResult;
    try {
      result = await session.prompt(prompt, { onUpdate, signal });
    } catch (error) {
      // A failed prompt still spent its streamed usage; retain the prompt's original failure.
      await this.endTurn({}).catch(() => undefined);
      throw error;
    }
    const stop = await this.endTurn(result);
    return { result, stop };
  }

  /** Writes the rows this meter holds now, if anything metered this run: what a unit writes once, before it ends. */
  async flush(): Promise<void> {
    await this.#save();
  }

  #baseline(): SessionBaseline {
    const held = this.#sessions.get(this.#session);
    if (held !== undefined) return held;
    const made: SessionBaseline = { cost: new Map() };
    this.#sessions.set(this.#session, made);
    return made;
  }

  #row(): MeterRow {
    const key = `${this.#turn.kind}\u0000${this.#turn.field}\u0000${this.#turn.model ?? '\u0001'}`;
    const held = this.#rows.get(key);
    if (held !== undefined) return held;
    const made: MeterRow = {
      unit: this.#options.unit, kind: this.#turn.kind, field: this.#turn.field, model: this.#turn.model,
      inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: new Map(), turns: 0, reported: false, stopped: null,
    };
    this.#rows.set(key, made);
    return made;
  }

  /** Counts one increment into the turn's row, and checks the declared bounds against what is spent now. */
  #add(inputTokens: number, outputTokens: number, totalTokens: number, cost: readonly AgentUsageAmount[]): void {
    const row = this.#row();
    row.inputTokens += inputTokens;
    row.outputTokens += outputTokens;
    row.totalTokens += totalTokens;
    for (const amount of cost) row.cost.set(amount.currency, (row.cost.get(amount.currency) ?? 0) + amount.amount);
    if (this.#stop !== undefined) return;
    // The run's shared counter is spent here, with the same increment: it bounds the whole fill run, and the plugin's own
    // bound is checked against the meter's rows. Either may cross first; the first crossing is the reason the run stops.
    const increment = this.#incrementTokens(inputTokens, outputTokens, totalTokens);
    const budget = this.#options.budget;
    const shared = budget === undefined ? undefined : budget.spend(increment);
    if (shared !== undefined) {
      row.stopped = shared.bound;
      this.#stop = this.#stopOf('run', shared);
      return;
    }
    const spent = this.spent();
    const bounds = this.#options.bounds;
    if (bounds === undefined) return;
    if (bounds.tokens !== undefined && spent.tokens > bounds.tokens) {
      row.stopped = 'tokens';
      this.#stop = this.#stopOf('plugin', { bound: 'tokens', spent: spent.tokens, limit: bounds.tokens, currency: null });
      return;
    }
    const limit = bounds.cost;
    if (limit !== undefined) {
      const held = spent.cost.find((amount) => amount.currency === limit.currency);
      if (held !== undefined && held.amount > limit.amount) {
        row.stopped = 'cost';
        this.#stop = this.#stopOf('plugin', { bound: 'cost', spent: held.amount, limit: limit.amount, currency: limit.currency });
      }
    }
  }

  /** The tokens one increment spent: the largest of the reported total and the sum of its parts. */
  #incrementTokens(inputTokens: number, outputTokens: number, totalTokens: number): number {
    return spentTokensOf({ inputTokens, outputTokens, totalTokens });
  }

  #stopOf(scope: 'plugin' | 'run', crossed: { readonly bound: 'tokens' | 'cost'; readonly spent: number; readonly limit: number; readonly currency: string | null }): AgentUsageStop {
    const kind = this.#turn.kind;
    const limitWords = crossed.bound === 'tokens' ? `${tokensText(crossed.limit)}-token` : `${String(crossed.limit)} ${String(crossed.currency)}`;
    const boundWords = scope === 'plugin'
      ? `${limitWords} bound the product's manifest declares for one run of the plugin`
      : `${limitWords} cap the fill's settings declare for the whole run`;
    const spentWords = crossed.bound === 'tokens' ? `${tokensText(crossed.spent)} tokens` : `${String(crossed.spent)} ${String(crossed.currency)}`;
    return {
      scope,
      bound: crossed.bound,
      spent: crossed.spent,
      limit: crossed.limit,
      currency: crossed.currency,
      unit: this.#options.unit,
      plugin: this.#options.plugin,
      message: `${WHERE}:AgentMeter: the plugin run ${this.#options.unit} spent ${spentWords} in the kind ${kind}, past the ${boundWords}: the run stops with that reason`,
    };
  }

  /** One span of the run's trace for the turn's increment: what this turn's model calls cost. */
  #writeSpan(inputTokens: number, outputTokens: number, totalTokens: number): void {
    const row = this.#row();
    const attributes: Record<string, string | number | boolean> = {
      'agent.run': this.#options.run,
      'agent.unit': this.#options.unit,
      'agent.plugin': this.#options.plugin,
      'agent.plugin.version': this.#options.pluginVersion,
      'agent.kind': row.kind,
      'agent.field': row.field,
      'agent.model': row.model ?? '',
      'agent.tokens.input': inputTokens,
      'agent.tokens.output': outputTokens,
      'agent.tokens.total': totalTokens,
      'agent.turns': 1,
      'agent.reported': row.reported,
      'agent.row.tokens.input': row.inputTokens,
      'agent.row.tokens.output': row.outputTokens,
      'agent.row.tokens': spentTokensOf(row),
    };
    for (const amount of this.#incrementCosts(row)) attributes[`agent.cost.${amount.currency}`] = amount.amount;
    if (this.#context !== undefined) {
      attributes['agent.context.used'] = this.#context.used;
      attributes['agent.context.size'] = this.#context.size;
    }
    if (this.#stop !== undefined) {
      attributes['agent.bound.stop'] = this.#stop.bound;
      attributes['agent.bound.scope'] = this.#stop.scope;
      attributes['agent.bound.limit'] = this.#stop.limit;
    }
    withSpanSync('agent.usage', attributes, () => undefined);
  }

  /** The cost this turn added, per currency: the row's total less what the row held before this turn. */
  #incrementCosts(row: MeterRow): AgentUsageAmount[] {
    const held = this.#lastCostByRow.get(row) ?? new Map<string, number>();
    const added: AgentUsageAmount[] = [];
    for (const [currency, amount] of row.cost) {
      const before = held.get(currency) ?? 0;
      if (amount > before) added.push({ amount: Number((amount - before).toFixed(6)), currency });
    }
    this.#lastCostByRow.set(row, new Map(row.cost));
    return added;
  }

  /** What each row's cost stood at when its last span was written. */
  readonly #lastCostByRow = new Map<MeterRow, Map<string, number>>();

  async #save(): Promise<void> {
    const save = this.#options.save;
    if (save === undefined) return;
    await save(this.rows());
  }
}

