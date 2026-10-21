import { CartLine } from './pricing';

/** The fields of an order checkout reads (contracts/openapi/orders.yaml, schema Order). */
export interface Order {
  id: string;
  status: string;
  totalCents: number;
}

export class OrdersError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'OrdersError';
  }
}

/** HTTP client of the orders service, written against contracts/openapi/orders.yaml. */
export class OrdersClient {
  constructor(private readonly baseUrl: string) {}

  /** POST /orders. The idempotency key makes a repeated checkout return the same order. */
// @@ until request-ids
  async placeOrder(auth: string, items: CartLine[], discountPercent: number, idempotencyKey: string): Promise<Order> {
// @@ end
// @@ since request-ids
  async placeOrder(
    auth: string,
    requestId: string,
    items: CartLine[],
    discountPercent: number,
    idempotencyKey: string,
  ): Promise<Order> {
// @@ end
    const response = await fetch(`${this.baseUrl}/orders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: auth,
        'idempotency-key': idempotencyKey,
// @@ since request-ids
        'x-request-id': requestId,
// @@ end
      },
      body: JSON.stringify({ items, discountPercent }),
    });
    if (!response.ok) {
      throw new OrdersError(response.status, await errorMessage(response));
    }
    return (await response.json()) as Order;
  }

// @@ since grpc-client
  /** POST /orders/{id}/cancel, used when the payment did not go through. */
// @@ end
// @@ since grpc-client until request-ids
  async cancelOrder(auth: string, orderId: string, reason: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/orders/${orderId}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
// @@ end
// @@ since request-ids
  async cancelOrder(auth: string, requestId: string, orderId: string, reason: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/orders/${orderId}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth, 'x-request-id': requestId },
// @@ end
// @@ since grpc-client
      body: JSON.stringify({ reason }),
    });
    if (!response.ok) {
      throw new OrdersError(response.status, await errorMessage(response));
    }
  }
// @@ end
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string };
    return body.message ?? `orders answered ${response.status}`;
  } catch {
    return `orders answered ${response.status}`;
  }
}
