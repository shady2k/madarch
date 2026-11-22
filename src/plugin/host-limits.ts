/**
 * The bounds of one plugin run, each with a default a caller may lower: the
 * handshake, one unit (an iteration), the whole run, the silence allowed
 * between heartbeats while a unit runs, one message, one unit's whole answer,
 * the grace a stop gets, and the memory, cpu and process bounds of the
 * plugin's cgroup.
 */
export interface HostLimits {
  readonly handshakeMs: number;
  readonly unitMs: number;
  /**
   * How long one unit of a plugin that declares an agent part may run (owner's decision, 2026-11-15): an agent explores
   * the graph through its tools and needs minutes, so its unit lives while it works — every ACP event and tool call is a
   * sign of life — and the run's token cap and this bound are what stop it. The product's manifest names the bound per
   * plugin (`plugins[].bounds.minutes`).
   */
  readonly agentUnitMs: number;
  readonly runMs: number;
  readonly heartbeatMs: number;
  readonly maxMessageBytes: number;
  readonly maxUnitOutputBytes: number;
  readonly stopGraceMs: number;
  readonly memoryBytes: number;
  readonly cpuQuotaMicros: number;
  readonly cpuPeriodMicros: number;
  readonly pids: number;
}

/** The defaults: a minute a unit (half an hour one with an agent part), half an hour a run, five seconds of silence, a megabyte a message and eight a unit. */
export const DEFAULT_HOST_LIMITS: HostLimits = {
  handshakeMs: 10_000,
  unitMs: 60_000,
  agentUnitMs: 30 * 60_000,
  runMs: 30 * 60_000,
  heartbeatMs: 5_000,
  maxMessageBytes: 1_048_576,
  maxUnitOutputBytes: 8 * 1_048_576,
  stopGraceMs: 2_000,
  memoryBytes: 512 * 1_048_576,
  cpuQuotaMicros: 100_000,
  cpuPeriodMicros: 100_000,
  pids: 128,
};
