// @@ since persist-pay
import { PrismaClient } from '@prisma/client';
// @@ end
import { createApp } from './app';
import { loadConfig } from './config';
import { PaymentService } from './domain/payment-service';
// @@ since payment-events
import { KafkaEventSink } from './events/publishers';
// @@ end
// @@ since grpc-server
import { startGrpcServer } from './grpc/server';
// @@ end
import { logger } from './logging/logger';
// @@ since cardnet until factory
import { Cardnet } from './providers/cardnet';
// @@ end
// @@ since factory
import { PaymentClientFactory } from './providers/factory';
// @@ end
// @@ since persist-pay
import { PrismaPaymentRepository } from './store/payment-repository';
// @@ end

const HTTP_PORT = 8081;
// @@ since grpc-server
const GRPC_PORT = 50051;
// @@ end

/** The composition root: builds every collaborator once and passes it on through constructors. */
async function main(): Promise<void> {
  const config = loadConfig();
// @@ since persist-pay
  const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
// @@ end
// @@ since payment-events
  const sink = await KafkaEventSink.connect(config.kafkaBrokers);
// @@ end
// @@ until cardnet
  const service = new PaymentService({});
// @@ end
// @@ since cardnet until factory
  const service = new PaymentService({ provider: new Cardnet() });
// @@ end
// @@ since factory until persist-pay
  const service = new PaymentService({ provider: PaymentClientFactory.create(config.paymentProvider) });
// @@ end
// @@ since persist-pay until payment-events
  const service = new PaymentService({
    provider: PaymentClientFactory.create(config.paymentProvider),
    repository: new PrismaPaymentRepository(prisma),
  });
// @@ end
// @@ since payment-events until retries
  const service = new PaymentService({
    provider: PaymentClientFactory.create(config.paymentProvider),
    repository: new PrismaPaymentRepository(prisma),
    sink,
  });
// @@ end
// @@ since retries
  const service = new PaymentService({
    provider: PaymentClientFactory.create(config.paymentProvider),
    repository: new PrismaPaymentRepository(prisma),
    sink,
    timeoutMs: config.paymentTimeoutMs,
  });
// @@ end

// @@ until persist-pay
  createApp({ service, jwtSecret: config.jwtSecret }).listen(HTTP_PORT, () => {
    logger.info({ port: HTTP_PORT }, 'payments http listening');
  });
// @@ end
// @@ since persist-pay until factory
  createApp({ service, prisma, jwtSecret: config.jwtSecret }).listen(HTTP_PORT, () => {
    logger.info({ port: HTTP_PORT }, 'payments http listening');
  });
// @@ end
// @@ since factory until retries
  createApp({ service, prisma, jwtSecret: config.jwtSecret }).listen(HTTP_PORT, () => {
    logger.info({ port: HTTP_PORT, provider: config.paymentProvider }, 'payments http listening');
  });
// @@ end
// @@ since retries
  createApp({ service, prisma, jwtSecret: config.jwtSecret }).listen(HTTP_PORT, () => {
    logger.info({ port: HTTP_PORT, provider: config.paymentProvider, timeoutMs: config.paymentTimeoutMs }, 'payments http listening');
  });
// @@ end
// @@ since grpc-server
  await startGrpcServer(service, GRPC_PORT);
// @@ end
}

main().catch((error) => {
  logger.error({ err: error }, 'payments failed to start');
  process.exit(1);
});
