/**
 * What a run is likely to take, as the prepare page states it beside the press (madarch-64o5.90): the plan's plugin
 * units and the kinds the agent writes, at a named rate each. It is an estimate, not a bound: the writer's own limits
 * (WRITER_BOUNDS) remain the hard ones, and the cap is the most the run may spend.
 */
export const PLUGIN_MINUTES_PER_UNIT = 0.25;
export const AGENT_MINUTES_PER_KIND = 2;

/** The minutes a plan is expected to take, never less than one. */
export function fillEstimate(units: number, agentKinds: number): number {
  return Math.max(1, Math.ceil(units * PLUGIN_MINUTES_PER_UNIT + agentKinds * AGENT_MINUTES_PER_KIND));
}
