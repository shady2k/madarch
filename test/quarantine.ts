/** A quarantine always names its repair task; CI checks task state at the tracker gate, not here. */
export function quarantined<T extends { skip: T }>(task: string, registrar: T): T {
  if (!/^madarch-[a-z0-9]+(?:\.[0-9]+)*$/.test(task)) {
    throw new Error(`quarantine requires a tracker task id (madarch-<id>), received ${JSON.stringify(task)}`);
  }
  return process.env.MADARCH_QUARANTINE === '1' ? registrar : registrar.skip;
}
