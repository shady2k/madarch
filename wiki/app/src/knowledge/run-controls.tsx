import type { WikiStatus } from './types.js';

/** A person paused the current run. */
export const runIsPaused = (status: WikiStatus): boolean => status.fill.state === 'paused' || status.writer.state === 'paused';

/** A person stopped the current run. */
export const runIsStopped = (status: WikiStatus): boolean => status.fill.state === 'stopped' || status.writer.state === 'stopped';
