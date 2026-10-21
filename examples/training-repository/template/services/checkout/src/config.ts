export interface Config {
  /** Where the orders service listens (ORDERS_URL, default http://localhost:8080). */
  ordersUrl: string;
// @@ since apply-promotion
  /** Where the promotions service listens (PROMOTIONS_URL, default http://localhost:8082). */
  promotionsUrl: string;
// @@ end
// @@ since grpc-client
  /** host:port of the payments gRPC server (PAYMENTS_ADDR, default localhost:50051). */
  paymentsAddr: string;
  /** How long one gRPC call to payments may take (PAYMENTS_DEADLINE_MS, default 8000). */
  paymentsDeadlineMs: number;
// @@ end
}

/** Reads the environment; every value has a default, so checkout starts with nothing set. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    ordersUrl: env.ORDERS_URL ?? 'http://localhost:8080',
// @@ since apply-promotion
    promotionsUrl: env.PROMOTIONS_URL ?? 'http://localhost:8082',
// @@ end
// @@ since grpc-client
    paymentsAddr: env.PAYMENTS_ADDR ?? 'localhost:50051',
    paymentsDeadlineMs: Number(env.PAYMENTS_DEADLINE_MS ?? 8000),
// @@ end
  };
}
