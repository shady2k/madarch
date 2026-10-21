import { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { logger } from '../logging/logger';
import { PaymentNotFound } from '../domain/payment-service';
// @@ since refunds
import { RefundRejected } from '../domain/refund';
// @@ end

/** Logs one line per request with its method, path, status and duration. */
export const requestLogger: RequestHandler = (req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    logger.info({ method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started }, 'request');
  });
  next();
};

/** Rejects requests without a bearer token signed with the shared secret (HS256). */
export function authenticate(secret: string): RequestHandler {
  return (req, res, next) => {
    const header = req.get('Authorization') ?? '';
    if (!header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'unauthorized', message: 'missing bearer token' });
      return;
    }
    try {
      jwt.verify(header.slice('Bearer '.length), secret, { algorithms: ['HS256'] });
      next();
    } catch {
      res.status(401).json({ error: 'unauthorized', message: 'invalid token' });
    }
  };
}

/** Turns the errors the handlers throw into JSON responses; anything unknown is a 500. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof PaymentNotFound) {
    res.status(404).json({ error: 'not_found', message: err.message });
// @@ since refunds
  } else if (err instanceof RefundRejected) {
    res.status(409).json({ error: err.code, message: err.message });
// @@ end
  } else {
    logger.error({ err }, 'unhandled error');
    res.status(500).json({ error: 'internal', message: 'internal error' });
  }
}
