import { Router } from 'express';
import { PaymentService } from '../domain/payment-service';
import { PaymentStatus } from '../domain/payment';

/** The /payments routes. */
export function paymentRoutes(service: PaymentService): Router {
  const router = Router();

  // Pay: the Idempotency-Key header is required; the same key never charges twice.
  router.post('/', async (req, res, next) => {
    try {
      const key = req.get('Idempotency-Key') ?? '';
      const { orderId, amountCents, currency, cardToken } = req.body ?? {};
// @@ until persist-pay
      if (!orderId || !Number.isInteger(amountCents) || !currency || !cardToken) {
        res.status(400).json({ error: 'bad_request', message: 'orderId, amountCents, currency and cardToken are required' });
        return;
      }
// @@ end
// @@ since persist-pay
      if (!key || !orderId || !Number.isInteger(amountCents) || !currency || !cardToken) {
        res.status(400).json({
          error: 'bad_request',
          message: 'an Idempotency-Key header and orderId, amountCents, currency and cardToken are required',
        });
        return;
      }
// @@ end
      const payment = await service.pay({
        orderId,
        amountCents,
        currency,
        cardToken: { vaultReference: cardToken },
        idempotencyKey: key,
      });
      res.status(payment.status === PaymentStatus.Captured ? 201 : 402).json(payment);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      res.json(await service.get(req.params.id));
    } catch (error) {
      next(error);
    }
  });

// @@ since refunds
  router.post('/:id/refunds', async (req, res, next) => {
    try {
      const { amountCents, reason } = req.body ?? {};
      res.status(201).json(await service.refund(req.params.id, amountCents, reason));
    } catch (error) {
      next(error);
    }
  });
// @@ end

  return router;
}
