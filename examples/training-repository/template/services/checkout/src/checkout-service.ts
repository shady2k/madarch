import { logger } from './logging/logger';
import { OrdersClient, OrdersError } from './orders-client';
// @@ since grpc-client
import { PaymentsClient } from './payments-client';
// @@ end
import { CartLine, previewTotal } from './pricing';
// @@ since apply-promotion
import { PromotionsClient } from './promotions-client';
// @@ end

export interface CheckoutRequest {
  items: CartLine[];
// @@ since apply-promotion
  promotionCode?: string;
// @@ end
// @@ since grpc-client
  cardToken: string;
  currency: string;
// @@ end
  /** The shopper's bearer token; checkout forwards it to orders. */
  auth: string;
// @@ since request-ids
  /** Ties the log lines of the services together (X-Request-Id). */
  requestId: string;
// @@ end
  /** The shopper's own key for this attempt (Idempotency-Key); repeating it repeats the same order and payment. */
  idempotencyKey: string;
}

// @@ until grpc-client
export type CheckoutResult =
  | { outcome: 'placed'; order: { id: string; status: string; totalCents: number } }
  | { outcome: 'rejected'; status: number; message: string };
// @@ end
// @@ since grpc-client
export type CheckoutResult =
  | { outcome: 'paid'; order: { id: string; status: string; totalCents: number }; paymentId: string }
  | { outcome: 'declined'; orderId: string; reason: string }
  | { outcome: 'rejected'; status: number; message: string };
// @@ end

// @@ until grpc-client
/** The checkout sequence so far: place the order at orders (HTTP). Payment comes next. */
// @@ end
// @@ since grpc-client
/**
 * The checkout sequence: apply the promotion, place the order at orders (HTTP),
 * authorize the payment at payments (gRPC), and cancel the order again when
 * the payment is declined or cannot be reached.
 */
// @@ end
export class CheckoutService {
// @@ until grpc-client
  constructor(private readonly orders: OrdersClient) {}
// @@ end
// @@ since grpc-client until apply-promotion
  constructor(
    private readonly orders: OrdersClient,
    private readonly payments: PaymentsClient,
  ) {}
// @@ end
// @@ since apply-promotion
  constructor(
    private readonly orders: OrdersClient,
    private readonly payments: PaymentsClient,
    private readonly promotions: PromotionsClient,
  ) {}
// @@ end

  async checkout(request: CheckoutRequest): Promise<CheckoutResult> {
// @@ until request-ids
    const log = logger;
// @@ end
// @@ since request-ids
    const log = logger.child({ requestId: request.requestId });
// @@ end

// @@ since apply-promotion
    let percent = 0;
    if (request.promotionCode) {
      const subtotal = previewTotal(request.items, 0).subtotalCents;
      const promotion = await this.promotions.apply(request.promotionCode, subtotal);
      if (promotion) {
        percent = promotion.percent;
      } else {
        log.info({ code: request.promotionCode }, 'promotion code does not apply');
      }
    }

// @@ end
// @@ until apply-promotion
    const percent = 0;
// @@ end
    let order;
    try {
// @@ until request-ids
      order = await this.orders.placeOrder(request.auth, request.items, percent, request.idempotencyKey);
// @@ end
// @@ since request-ids
      order = await this.orders.placeOrder(request.auth, request.requestId, request.items, percent, request.idempotencyKey);
// @@ end
    } catch (error) {
      if (error instanceof OrdersError && error.status < 500) {
        return { outcome: 'rejected', status: error.status, message: error.message };
      }
      throw error;
    }

// @@ until grpc-client
    log.info({ orderId: order.id }, 'checkout placed the order');
    return { outcome: 'placed', order };
  }
// @@ end
// @@ since grpc-client
    try {
      const payment = await this.payments.authorize(order.id, order.totalCents, request.currency, request.cardToken, `pay-${order.id}`);
      if (payment.status === 'captured') {
        log.info({ orderId: order.id, paymentId: payment.paymentId }, 'checkout paid');
        return { outcome: 'paid', order, paymentId: payment.paymentId };
      }
      await this.cancel(request, order.id, payment.declineReason || 'payment declined');
      return { outcome: 'declined', orderId: order.id, reason: payment.declineReason || 'payment declined' };
    } catch (error) {
      // The payment service could not be asked: do not leave an order waiting for a payment nobody will make.
      log.error({ err: error, orderId: order.id }, 'payment authorization failed');
      await this.cancel(request, order.id, 'payment service unavailable');
      throw error;
    }
  }

  private async cancel(request: CheckoutRequest, orderId: string, reason: string): Promise<void> {
    try {
// @@ end
// @@ since grpc-client until request-ids
      await this.orders.cancelOrder(request.auth, orderId, reason);
// @@ end
// @@ since request-ids
      await this.orders.cancelOrder(request.auth, request.requestId, orderId, reason);
// @@ end
// @@ since grpc-client
    } catch (error) {
      logger.error({ err: error, orderId }, 'could not cancel the order after a failed payment');
    }
  }
// @@ end
}
