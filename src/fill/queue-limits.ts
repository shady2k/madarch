import { DEFAULT_HOST_LIMITS } from '../plugin/host-limits.js';

/** How long the queue allows silence between run or unit claim heartbeats. */
export const RUN_JOB_HEARTBEAT_SECONDS = 30;

/**
 * Covers the plugin host's runBound (src/plugin/host.ts:912): max(runMs, agentUnitMs + 60 s),
 * plus its handshake and five minutes for orchestration. Heartbeat checks liveness, not this ceiling.
 */
export function unitJobAttemptSeconds(agentMinutes = DEFAULT_HOST_LIMITS.agentUnitMs / 60_000): number {
  const agentUnitMs = Math.max(DEFAULT_HOST_LIMITS.agentUnitMs, agentMinutes * 60_000);
  return Math.ceil((DEFAULT_HOST_LIMITS.handshakeMs + Math.max(DEFAULT_HOST_LIMITS.runMs, agentUnitMs + 60_000)) / 1000) + 5 * 60;
}

/** The default claim ceiling, before the product's plugin bounds are read. */
export const UNIT_JOB_ATTEMPT_SECONDS = unitJobAttemptSeconds();
