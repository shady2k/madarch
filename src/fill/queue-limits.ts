import { DEFAULT_HOST_LIMITS } from '../plugin/host-limits.js';

export const RUN_JOB_HEARTBEAT_SECONDS = 30;

// The longest legal plugin unit is host.agentUnitMs plus host.handshakeMs.
// Five minutes remain for orchestration before/after the plugin; heartbeat, not this ceiling, checks liveness.
export const UNIT_JOB_ATTEMPT_SECONDS = Math.ceil((DEFAULT_HOST_LIMITS.agentUnitMs + DEFAULT_HOST_LIMITS.handshakeMs) / 1000) + 5 * 60;
