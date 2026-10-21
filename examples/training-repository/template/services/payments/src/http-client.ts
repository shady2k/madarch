/** The few fields of a response the providers read. */
export interface HttpResponse {
  status: number;
  json(): Promise<unknown>;
}

interface HttpClient {
  request(url: string, init: RequestInit): Promise<HttpResponse>;
}

function createClient(timeoutMs: number): HttpClient {
  return {
    request: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
  };
}

// Looks like a shared module-level client, but it is not a singleton: every
// request below replaces it with a client that carries that request's own
// timeout. The variable is module-level by habit; nothing relies on it
// surviving between two calls.
let client: HttpClient | undefined;

/** Sends one request with its own client; 10 s is the transport ceiling, the payment timeout is applied above it. */
export async function request(url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<HttpResponse> {
  client = createClient(timeoutMs);
  return client.request(url, init);
}
