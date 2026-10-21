import express, { Express } from 'express';
// @@ since persist-pay
import { PrismaClient } from '@prisma/client';
// @@ end
import { authenticate, errorHandler, requestLogger } from './api/middleware';
// @@ since legacy-report
import { legacyReportRoutes } from './api/legacy-report';
// @@ end
import { paymentRoutes } from './api/routes';
import { PaymentService } from './domain/payment-service';

export interface AppDeps {
  service: PaymentService;
// @@ since persist-pay
  prisma: PrismaClient;
// @@ end
  jwtSecret: string;
}

/** Builds the Express app: middleware first, then the routes, the error handler last. */
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json());
  app.use(requestLogger);

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  const auth = authenticate(deps.jwtSecret);
  app.use('/payments', auth, paymentRoutes(deps.service));
// @@ since legacy-report
  app.use('/reports', auth, legacyReportRoutes(deps.prisma));
// @@ end

  app.use(errorHandler);
  return app;
}
