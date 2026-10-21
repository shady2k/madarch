import path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

/** contracts/proto/payments.proto, found from src and from dist alike. */
const PROTO_PATH = path.resolve(__dirname, '../../../contracts/proto/payments.proto');

export interface AuthorizeResult {
  paymentId: string;
  status: string;
  declineReason: string;
}

interface PaymentsStub extends grpc.Client {
  authorize(
    request: Record<string, unknown>,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, reply: AuthorizeResult) => void,
  ): void;
}

/** gRPC client of the payments service: the Payments service of payments.proto. */
export class PaymentsClient {
  private readonly stub: PaymentsStub;

  constructor(
    address: string,
    private readonly deadlineMs: number,
  ) {
    const definition = protoLoader.loadSync(PROTO_PATH, { keepCase: false, longs: Number, defaults: true });
    const loaded = grpc.loadPackageDefinition(definition) as unknown as {
      payments: { v1: { Payments: new (address: string, credentials: grpc.ChannelCredentials) => PaymentsStub } };
    };
    this.stub = new loaded.payments.v1.Payments(address, grpc.credentials.createInsecure());
  }

  /** Calls Authorize with a deadline; the idempotency key makes a repeated call return the first payment. */
  authorize(orderId: string, amountCents: number, currency: string, cardToken: string, idempotencyKey: string): Promise<AuthorizeResult> {
    const deadline = new Date(Date.now() + this.deadlineMs);
    return new Promise((resolve, reject) => {
      this.stub.authorize({ orderId, amountCents, currency, cardToken, idempotencyKey }, { deadline }, (error, reply) => {
        if (error) {
          reject(error);
        } else {
          resolve(reply);
        }
      });
    });
  }

  close(): void {
    this.stub.close();
  }
}
