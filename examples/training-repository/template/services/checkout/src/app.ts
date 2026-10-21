import express, { Express, NextFunction, Request, Response } from 'express';
import { checkoutRoutes } from './api/routes';
import { CheckoutService } from './checkout-service';
import { logger } from './logging/logger';

/** Builds the Express app of the checkout backend. */
export function createApp(service: CheckoutService): Express {
  const app = express();
  app.use(express.json());
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.use('/checkout', checkoutRoutes(service));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, 'checkout failed');
    res.status(502).json({ error: 'upstream_failed', message: 'a service checkout depends on did not answer' });
  });
  return app;
}
