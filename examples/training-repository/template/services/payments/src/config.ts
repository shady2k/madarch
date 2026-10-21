// @@ since factory
// TODO: source the provider secret from the vault when the sandbox is connected.

// @@ end
export interface Config {
// @@ since persist-pay
  /** Postgres connection string of the payments database (DATABASE_URL, required). */
  databaseUrl: string;
// @@ end
// @@ since payment-events
  /** Kafka brokers the events go to (KAFKA_BROKERS, required, comma-separated). */
  kafkaBrokers: string[];
// @@ end
  /** Secret of the HS256 tokens the HTTP API accepts (JWT_SECRET, required). */
  jwtSecret: string;
// @@ since factory
  /** Which payment provider adapter to use (PAYMENT_PROVIDER, default "cardnet"). */
  paymentProvider: string;
// @@ end
// @@ since retries
  /** How long one provider call may take, in milliseconds (PAYMENT_TIMEOUT_MS, default 3000). */
  paymentTimeoutMs: number;
// @@ end
}

// @@ since retries
const DEFAULT_PAYMENT_TIMEOUT_MS = 3000;

// @@ end
/** Reads the environment; throws one error naming every missing required variable. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing: string[] = [];
  const required = (name: string): string => {
    const value = env[name];
    if (!value) {
      missing.push(name);
      return '';
    }
    return value;
  };

// @@ since persist-pay
  const databaseUrl = required('DATABASE_URL');
// @@ end
// @@ since payment-events
  const kafkaBrokers = required('KAFKA_BROKERS');
// @@ end
  const jwtSecret = required('JWT_SECRET');
  if (missing.length > 0) {
    throw new Error(`missing required environment variables: ${missing.join(', ')}`);
  }

// @@ since retries
  // Not required: when PAYMENT_TIMEOUT_MS is absent or not a number, the default applies.
  const timeout = Number(env.PAYMENT_TIMEOUT_MS ?? DEFAULT_PAYMENT_TIMEOUT_MS);
// @@ end
  return {
// @@ since persist-pay
    databaseUrl,
// @@ end
// @@ since payment-events
    kafkaBrokers: kafkaBrokers.split(','),
// @@ end
    jwtSecret,
// @@ since factory
    paymentProvider: env.PAYMENT_PROVIDER ?? 'cardnet',
// @@ end
// @@ since retries
    paymentTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_PAYMENT_TIMEOUT_MS,
// @@ end
  };
}
