import http, { IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import * as grpc from '@grpc/grpc-js';
import { createApp } from '../src/app';
import { CheckoutService } from '../src/checkout-service';
import { OrdersClient } from '../src/orders-client';
import { PaymentsClient } from '../src/payments-client';
import { PromotionsClient } from '../src/promotions-client';
import { loadServiceDefinition } from './payments-stub';

/** Starts an HTTP server on a free port and records what it was asked. */
function listen(handler: (req: IncomingMessage, res: ServerResponse, body: any) => void) {
  const requests: Array<{ method?: string; url?: string; headers: IncomingMessage['headers']; body: any }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  return new Promise<{ url: string; requests: typeof requests; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

describe('checkout end to end', () => {
  let orders: Awaited<ReturnType<typeof listen>>;
  let promotions: Awaited<ReturnType<typeof listen>>;
  let paymentsServer: grpc.Server;
  let checkout: http.Server;
  let checkoutUrl: string;
  let paymentsClient: PaymentsClient;
  let paymentAnswer: { status: string; declineReason: string };
  let authorizeCalls: Array<Record<string, unknown>>;

  beforeEach(async () => {
    orders = await listen((req, res, body) => {
      if (req.method === 'POST' && req.url === '/orders') {
        // The stub prices like orders does: 8% tax on the discounted amount, none on zero-rated lines.
        let total = 0;
        for (const i of body.items) {
          const gross = i.priceCents * i.quantity;
          const net = gross - Math.round((gross * body.discountPercent) / 100);
          total += net + (i.zeroRated ? 0 : Math.round(net * 0.08));
        }
        json(res, 201, { id: 'ord_1', status: 'pending_payment', totalCents: total });
      } else {
        json(res, 200, { id: 'ord_1', status: 'cancelled', totalCents: 0 });
      }
    });
    promotions = await listen((_req, res, body) => {
      if (body.code === 'WELCOME10') {
        json(res, 200, { code: 'WELCOME10', discountCents: Math.floor(body.subtotalCents / 10), percent: 10 });
      } else {
        json(res, 404, { error: 'unknown_code' });
      }
    });

    authorizeCalls = [];
    paymentAnswer = { status: 'captured', declineReason: '' };
    paymentsServer = new grpc.Server();
    paymentsServer.addService(loadServiceDefinition(), {
      authorize: (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, callback: grpc.sendUnaryData<unknown>) => {
        authorizeCalls.push(call.request);
        callback(null, { paymentId: 'pay_1', ...paymentAnswer });
      },
    });
    const grpcPort = await new Promise<number>((resolve, reject) =>
      paymentsServer.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) => (error ? reject(error) : resolve(port))),
    );

    paymentsClient = new PaymentsClient(`127.0.0.1:${grpcPort}`, 2000);
    const service = new CheckoutService(new OrdersClient(orders.url), paymentsClient, new PromotionsClient(promotions.url));
    checkout = createApp(service).listen(0, '127.0.0.1');
    await new Promise((resolve) => checkout.once('listening', resolve));
    checkoutUrl = `http://127.0.0.1:${(checkout.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    paymentsClient.close();
    paymentsServer.forceShutdown();
    await Promise.all([orders.close(), promotions.close(), new Promise((done) => checkout.close(done))]);
  });

  const body = { items: [{ sku: 'A-1', quantity: 2, priceCents: 1000 }], cardToken: 'vault_1', promotionCode: 'WELCOME10' };
  const post = () =>
    fetch(`${checkoutUrl}/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token-1', 'x-request-id': 'req-1' },
      body: JSON.stringify(body),
    });

  it('places the order with the promotion percent and pays it', async () => {
    const response = await post();
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ order: { id: 'ord_1', status: 'pending_payment', totalCents: 1944 }, paymentId: 'pay_1' });

    const placed = orders.requests.find((r) => r.url === '/orders');
    expect(placed?.body.discountPercent).toBe(10);
    expect(placed?.headers.authorization).toBe('Bearer token-1');
    expect(authorizeCalls).toEqual([expect.objectContaining({ orderId: 'ord_1', amountCents: 1944, idempotencyKey: 'pay-ord_1' })]);
    expect(orders.requests.some((r) => r.url?.endsWith('/cancel'))).toBe(false);
  });

  it('cancels the order and answers 402 when the payment is declined', async () => {
    paymentAnswer = { status: 'declined', declineReason: 'insufficient funds' };
    const response = await post();
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ error: 'payment_declined', orderId: 'ord_1', reason: 'insufficient funds' });

    const cancel = orders.requests.find((r) => r.url === '/orders/ord_1/cancel');
    expect(cancel?.body).toEqual({ reason: 'insufficient funds' });
  });
});
