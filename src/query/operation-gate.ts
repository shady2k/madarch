export type OperationGate = {
  snapshot<T>(work: () => Promise<T>): Promise<T>;
  write<T>(work: () => T | Promise<T>): Promise<T>;
};

type Operation = 'snapshot' | 'write';

interface Waiter {
  operation: Operation;
  grant(): void;
}

/**
 * Fair writer-preferring admission for one database owner. A server pool may
 * admit concurrent snapshots; a single-connection driver sets
 * `allowConcurrentSnapshots` to false so even readers cannot overlap on its
 * connection. In both modes, later snapshots cannot pass a queued writer.
 */
export function createOperationGate(options: { allowConcurrentSnapshots: boolean }): OperationGate {
  let activeSnapshots = 0;
  let activeWriter = false;
  const waiting: Waiter[] = [];

  function acquire(operation: Operation): Promise<void> {
    return new Promise<void>((grant) => {
      if (waiting.length === 0 && !activeWriter) {
        if (operation === 'snapshot' && (options.allowConcurrentSnapshots || activeSnapshots === 0)) {
          activeSnapshots++;
          grant();
          return;
        }
        if (operation === 'write' && activeSnapshots === 0) {
          activeWriter = true;
          grant();
          return;
        }
      }
      waiting.push({ operation, grant });
    });
  }

  function drain(): void {
    if (activeWriter || activeSnapshots > 0 || waiting.length === 0) return;
    if (waiting[0]!.operation === 'write') {
      const next = waiting.shift()!;
      activeWriter = true;
      next.grant();
      return;
    }
    if (options.allowConcurrentSnapshots) {
      while (waiting[0]?.operation === 'snapshot') {
        const next = waiting.shift()!;
        activeSnapshots++;
        next.grant();
      }
    } else {
      const next = waiting.shift()!;
      activeSnapshots++;
      next.grant();
    }
  }

  async function run<T>(operation: Operation, work: () => T | Promise<T>): Promise<T> {
    await acquire(operation);
    try {
      return await work();
    } finally {
      if (operation === 'snapshot') activeSnapshots--;
      else activeWriter = false;
      drain();
    }
  }

  return {
    snapshot: <T>(work: () => Promise<T>) => run('snapshot', work),
    write: <T>(work: () => T | Promise<T>) => run('write', work),
  };
}
