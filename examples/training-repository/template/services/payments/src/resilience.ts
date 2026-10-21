/** Rejects with this when a call did not finish in time. */
export class TimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`no answer within ${timeoutMs} ms`);
    this.name = 'TimeoutError';
  }
}

/** Resolves with the call's result, or rejects with TimeoutError after timeoutMs. */
export async function withTimeout<T>(call: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([call, expired]);
  } finally {
    clearTimeout(timer);
  }
}

export interface RetryOptions {
  /** How many calls at most, the first included. */
  attempts: number;
  /** The wait before the second call; it doubles before each later one. */
  baseDelayMs: number;
  /** Whether a failure is worth another call. */
  isTransient: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

/** Calls fn until it succeeds, a failure is not transient, or the attempts are spent. */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!options.isTransient(error) || attempt === options.attempts) {
        break;
      }
      await sleep(options.baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}
