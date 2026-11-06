/**
 * What a served repository's fill is doing, as it happens (madarch-8bdc.2.5): one
 * JSON line per durable fill event in `<store>/fill.log`, beside the graph, and a
 * running count of what was planned, published, failed and blocked per stage.
 *
 * The file is the person's answer to "why is nothing happening": every event the
 * orchestrator commits is written here with the time it happened and, for a
 * pass, how long each part of it took and how many units the run held. The MCP's
 * `graph building` answer and its standard error read the same snapshot, so no
 * external database reader is needed to see how far a fill stands.
 */
import { appendFileSync } from 'node:fs';
/** The shape the orchestrator's progress sink hands the log: one durable event, its kind a text. */
interface FillLogEvent {
  readonly runId: string;
  readonly seq: number;
  readonly at: number;
  readonly stage: string;
  readonly unitId: string;
  readonly generation: number | null;
  readonly kind: string;
  readonly summary: string;
}

/** What one stage has done so far. */
interface StageProgress {
  readonly planned: number;
  readonly published: number;
  readonly failed: number;
  readonly blocked: number;
}

/** One scheduler pass as the log records it: what it cost and what the run held. */
interface PassTiming {
  readonly pass: number;
  readonly units: number;
  readonly ms: number;
  readonly phases: Readonly<Record<string, number>>;
}

/** One step that took the longest between two events of one unit. */
interface SlowestStep {
  readonly unitId: string;
  readonly from: string;
  readonly to: string;
  readonly ms: number;
}

/** What the fill has done so far: the whole run and each stage, the last event and the slowest step. */
export interface FillLogSnapshot {
  readonly planned: number;
  readonly published: number;
  readonly failed: number;
  readonly blocked: number;
  readonly stages: Readonly<Record<string, StageProgress>>;
  readonly last: string | null;
  readonly slowest: SlowestStep | null;
  readonly pass: PassTiming | null;
}

/** The fill's own log, written beside the graph it builds. */
export class FillLog {
  private readonly stageProgress = new Map<string, { planned: number; published: number; failed: number; blocked: number }>();
  private readonly lastEvent = new Map<string, { at: number; kind: string }>();
  private planned = 0;
  private published = 0;
  private failed = 0;
  private blocked = 0;
  private last: string | null = null;
  private slowest: SlowestStep | null = null;
  private pass: PassTiming | null = null;
  private sinceAnnounce = 0;

  constructor(private readonly file: string, private readonly announce?: (line: string) => void) {}

  /** Receives one durable event: writes its line, counts it and announces the state now and then. */
  readonly sink = (event: FillLogEvent): void => {
    appendFileSync(this.file, `${JSON.stringify({
      at: new Date(event.at).toISOString(),
      loggedAt: new Date().toISOString(),
      runId: event.runId,
      seq: event.seq,
      stage: event.stage,
      unitId: event.unitId,
      generation: event.generation,
      kind: event.kind,
      summary: event.summary,
    })}\n`, 'utf8');
    this.count(event);
  };

  /** The state as the last event left it. */
  snapshot(): FillLogSnapshot {
    const stages: Record<string, StageProgress> = {};
    for (const [stage, held] of [...this.stageProgress].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) stages[stage] = { ...held };
    return { planned: this.planned, published: this.published, failed: this.failed, blocked: this.blocked, stages, last: this.last, slowest: this.slowest, pass: this.pass };
  }

  /** One line a person reads: the totals, each stage that has done anything, and the slowest step. */
  line(): string {
    const held = this.snapshot();
    const stages = Object.entries(held.stages).map(([stage, one]) => `${stage} ${one.planned}/${one.published}/${one.failed}`).join(', ');
    const slowest = held.slowest === null ? '' : `; slowest ${held.slowest.unitId} ${held.slowest.from}→${held.slowest.to} ${(held.slowest.ms / 1000).toFixed(1)}s`;
    const pass = held.pass === null ? '' : `; pass ${held.pass.pass} on ${held.pass.units} units took ${(held.pass.ms / 1000).toFixed(1)}s (${Object.entries(held.pass.phases).map(([phase, ms]) => `${phase} ${(ms / 1000).toFixed(1)}s`).join(', ')})`;
    return `fill: planned ${held.planned}, published ${held.published}, failed ${held.failed}, blocked ${held.blocked}${stages === '' ? '' : `; stages ${stages}`}${slowest}${pass}; last ${held.last ?? 'none'}`;
  }

  private count(event: FillLogEvent): void {
    const previous = event.unitId === '' ? undefined : this.lastEvent.get(event.unitId);
    if (previous !== undefined) {
      const ms = event.at - previous.at;
      if (ms > 0 && (this.slowest === null || ms > this.slowest.ms)) this.slowest = { unitId: event.unitId, from: previous.kind, to: event.kind, ms };
    }
    if (event.unitId !== '') this.lastEvent.set(event.unitId, { at: event.at, kind: event.kind });
    if (event.stage !== '') {
      const held = this.stageProgress.get(event.stage) ?? { planned: 0, published: 0, failed: 0, blocked: 0 };
      if (event.kind === 'unit-planned') { held.planned += 1; this.planned += 1; }
      if (event.kind === 'unit-published') { held.published += 1; this.published += 1; }
      if (event.kind === 'unit-failed') { held.failed += 1; this.failed += 1; }
      if (event.kind === 'unit-blocked') { held.blocked += 1; this.blocked += 1; }
      this.stageProgress.set(event.stage, held);
    }
    if (event.kind === 'pass-timing') {
      try {
        const parsed = JSON.parse(event.summary) as PassTiming;
        if (typeof parsed.pass === 'number' && typeof parsed.units === 'number' && typeof parsed.ms === 'number' && typeof parsed.phases === 'object') this.pass = parsed;
      } catch {
        // A pass line this reader cannot parse is still in the file; the snapshot keeps the last good one.
      }
    }
    this.last = `${event.kind}${event.unitId === '' ? '' : ` ${event.unitId}`}: ${event.summary}`;
    this.sinceAnnounce += 1;
    if (this.announce !== undefined && (this.sinceAnnounce >= 25 || event.kind === 'unit-failed' || event.kind === 'unit-blocked' || event.kind === 'run-completed' || event.kind === 'run-completed-partial')) {
      this.sinceAnnounce = 0;
      this.announce(this.line());
    }
  }
}
