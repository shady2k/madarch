/**
 * A unit stopped by a bound its run declares (owner's decision, 2026-11-15): the wall-clock bound of an agent unit, the
 * silence a plugin may keep, the run's own deadline, or the token cap the fill was pressed with. Another attempt meets
 * the same bound, so the run fails the unit with this reason instead of spending its retries on the same wall.
 *
 * It is an error and not a value because the stage's `execute` answers a draft, a split or a block, and a stop is none
 * of them: the plugin turn raises it, and the attempt's own phase fails the unit rather than retrying it.
 */
export class UnitBoundStop extends Error {
  constructor(
    /** Which bound stopped the unit: the agent's time, the plugin's silence, the run's time, or the fill's tokens. */
    readonly bound: 'agent-time' | 'plugin-silence' | 'run-time' | 'tokens',
    message: string,
  ) {
    super(message);
    this.name = 'UnitBoundStop';
  }
}
