/** A quarantine always names its repair task; CI checks task state at the tracker gate, not here. */
export function quarantined<T extends { skip: T }>(task: string, registrar: T, reason: 'slow' | 'flaky' | 'broken', since: string): T {
  if (!/^madarch-[a-z0-9]+(?:\.[0-9]+)*$/.test(task)) {
    throw new Error(`quarantine requires a tracker task id (madarch-<id>), received ${JSON.stringify(task)}`);
  }
  if (!['slow', 'flaky', 'broken'].includes(reason)) throw new Error('quarantine requires a reason: slow, flaky, or broken');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(since)) throw new Error('quarantine requires the introducing commit hash');
  return process.env.MADARCH_QUARANTINE === '1' ? registrar : registrar.skip;
}
