import path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { logger } from '../logging/logger';
import { PaymentService } from '../domain/payment-service';
// @@ since refunds
import { PaymentNotFound } from '../domain/payment-service';
import { RefundRejected } from '../domain/refund';
// @@ end

/** contracts/proto/payments.proto, found from src/grpc and from dist/grpc alike. */
export const PROTO_PATH = path.resolve(__dirname, '../../../../contracts/proto/payments.proto');

interface AuthorizeRequest {
  orderId: string;
  amountCents: number | string;
  currency: string;
  cardToken: string;
  idempotencyKey: string;
}

// @@ since refunds
interface RefundRequest {
  paymentId: string;
  amountCents: number | string;
  reason: string;
}
// @@ end

/** Loads the Payments service definition from the proto file. */
export function loadServiceDefinition(): grpc.ServiceDefinition {
  const definition = protoLoader.loadSync(PROTO_PATH, { keepCase: false, longs: Number, defaults: true });
  const loaded = grpc.loadPackageDefinition(definition) as unknown as {
    payments: { v1: { Payments: grpc.ServiceClientConstructor } };
  };
  return loaded.payments.v1.Payments.service;
}

/** The server implementation of the Payments service of payments.proto. */
export function paymentsHandlers(service: PaymentService): grpc.UntypedServiceImplementation {
  return {
    authorize: async (call: grpc.ServerUnaryCall<AuthorizeRequest, unknown>, callback: grpc.sendUnaryData<unknown>) => {
      const request = call.request;
      try {
        const payment = await service.pay({
          orderId: request.orderId,
          amountCents: Number(request.amountCents),
          currency: request.currency,
          cardToken: { vaultReference: request.cardToken },
          idempotencyKey: request.idempotencyKey,
        });
        callback(null, { paymentId: payment.id, status: payment.status, declineReason: payment.declineReason ?? '' });
      } catch (error) {
        logger.error({ err: error, orderId: request.orderId }, 'grpc authorize failed');
        callback({ code: grpc.status.INTERNAL, message: 'authorize failed' });
      }
    },
// @@ since refunds
    refund: async (call: grpc.ServerUnaryCall<RefundRequest, unknown>, callback: grpc.sendUnaryData<unknown>) => {
      const request = call.request;
      try {
        const refund = await service.refund(request.paymentId, Number(request.amountCents), request.reason || undefined);
        callback(null, { refundId: refund.id, status: 'refunded' });
      } catch (error) {
        if (error instanceof PaymentNotFound) {
          callback({ code: grpc.status.NOT_FOUND, message: error.message });
        } else if (error instanceof RefundRejected) {
          callback({ code: grpc.status.FAILED_PRECONDITION, message: error.message });
        } else {
          logger.error({ err: error, paymentId: request.paymentId }, 'grpc refund failed');
          callback({ code: grpc.status.INTERNAL, message: 'refund failed' });
        }
      }
    },
// @@ end
  };
}

/** Starts the gRPC server on the port and resolves once it is listening. */
export function startGrpcServer(service: PaymentService, port: number): Promise<grpc.Server> {
  const server = new grpc.Server();
  server.addService(loadServiceDefinition(), paymentsHandlers(service));
  return new Promise((resolve, reject) => {
    server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (error) => {
      if (error) {
        reject(error);
        return;
      }
      logger.info({ port }, 'payments grpc listening');
      resolve(server);
    });
  });
}
