// @@ since request-ids
import { randomUUID } from 'node:crypto';
// @@ end
import { NextFunction, Request, Response, Router } from 'express';
import { CheckoutService } from '../checkout-service';
import { previewTotal } from '../pricing';

/** The shopper-facing routes of the checkout backend. */
export function checkoutRoutes(service: CheckoutService): Router {
  const router = Router();

  // Preview: what the cart costs with a discount percentage, before anything is placed.
  router.post('/preview', (req: Request, res: Response) => {
    const { items, percent } = req.body ?? {};
    if (!Array.isArray(items)) {
      res.status(400).json({ error: 'bad_request', message: 'items must be a list' });
      return;
    }
    res.json(previewTotal(items, Number(percent ?? 0)));
  });

// @@ until grpc-client
  // Checkout: places the order. 201 when it was placed.
// @@ end
// @@ since grpc-client
  // Checkout: the whole sequence. 201 when paid, 402 when the payment was declined.
// @@ end
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
// @@ until grpc-client
      const { items, promotionCode } = req.body ?? {};
      const auth = req.get('Authorization');
      if (!auth || !Array.isArray(items) || items.length === 0) {
        res.status(400).json({ error: 'bad_request', message: 'an Authorization header and items are required' });
        return;
      }
// @@ end
// @@ since grpc-client
      const { items, promotionCode, cardToken, currency } = req.body ?? {};
      const auth = req.get('Authorization');
      if (!auth || !Array.isArray(items) || items.length === 0 || !cardToken) {
        res.status(400).json({ error: 'bad_request', message: 'an Authorization header, items and a cardToken are required' });
        return;
      }
// @@ end
// @@ since request-ids
      const requestId = req.get('X-Request-Id') ?? randomUUID();
      res.setHeader('X-Request-Id', requestId);
// @@ end
      const result = await service.checkout({
        items,
// @@ since apply-promotion
        promotionCode,
// @@ end
// @@ since grpc-client
        cardToken,
        currency: currency ?? 'EUR',
// @@ end
        auth,
// @@ since request-ids
        requestId,
// @@ end
// @@ until request-ids
        idempotencyKey: req.get('Idempotency-Key') ?? '',
// @@ end
// @@ since request-ids
        idempotencyKey: req.get('Idempotency-Key') ?? requestId,
// @@ end
      });
      switch (result.outcome) {
// @@ until grpc-client
        case 'placed':
          res.status(201).json({ order: result.order });
          break;
// @@ end
// @@ since grpc-client
        case 'paid':
          res.status(201).json({ order: result.order, paymentId: result.paymentId });
          break;
        case 'declined':
          res.status(402).json({ error: 'payment_declined', orderId: result.orderId, reason: result.reason });
          break;
// @@ end
        case 'rejected':
          res.status(result.status).json({ error: 'order_rejected', message: result.message });
          break;
      }
    } catch (error) {
      next(error);
    }
  });

  return router;
}
