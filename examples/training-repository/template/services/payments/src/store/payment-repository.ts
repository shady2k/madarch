import { PrismaClient, Payment as PaymentRow } from '@prisma/client';
import { Payment, PaymentStatus } from '../domain/payment';
// @@ since refunds
import { Refund } from '../domain/refund';
// @@ end

/** What the payment service needs from storage. */
export interface PaymentRepository {
  create(payment: Payment): Promise<void>;
  save(payment: Payment): Promise<void>;
  findById(id: string): Promise<Payment | undefined>;
  findByIdempotencyKey(key: string): Promise<Payment | undefined>;
// @@ since refunds
  addRefund(refund: Refund): Promise<void>;
// @@ end
// @@ since refund-cap
  /** The sum of the refunds already made on the payment, in cents. */
  refundedTotal(paymentId: string): Promise<number>;
// @@ end
}

/** PaymentRepository over Prisma and the payments database. */
export class PrismaPaymentRepository implements PaymentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(payment: Payment): Promise<void> {
    await this.prisma.payment.create({
      data: {
        id: payment.id,
        orderId: payment.orderId,
        amountCents: payment.amountCents,
        currency: payment.currency,
        status: payment.status,
        idempotencyKey: payment.idempotencyKey,
        createdAt: payment.createdAt,
      },
    });
  }

  async save(payment: Payment): Promise<void> {
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: payment.status,
        providerReference: payment.providerReference ?? null,
        declineReason: payment.declineReason ?? null,
        capturedAt: payment.capturedAt ?? null,
      },
    });
  }

  async findById(id: string): Promise<Payment | undefined> {
    const row = await this.prisma.payment.findUnique({ where: { id } });
    return row ? toPayment(row) : undefined;
  }

  async findByIdempotencyKey(key: string): Promise<Payment | undefined> {
    const row = await this.prisma.payment.findUnique({ where: { idempotencyKey: key } });
    return row ? toPayment(row) : undefined;
  }

// @@ since refunds
  async addRefund(refund: Refund): Promise<void> {
    await this.prisma.refund.create({
      data: {
        id: refund.id,
        paymentId: refund.paymentId,
        amountCents: refund.amountCents,
        reason: refund.reason ?? null,
        createdAt: refund.createdAt,
      },
    });
  }

// @@ end
// @@ since refund-cap
  async refundedTotal(paymentId: string): Promise<number> {
    const total = await this.prisma.refund.aggregate({ where: { paymentId }, _sum: { amountCents: true } });
    return total._sum.amountCents ?? 0;
  }
// @@ end
}

function toPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    orderId: row.orderId,
    amountCents: row.amountCents,
    currency: row.currency,
    status: row.status as PaymentStatus,
    idempotencyKey: row.idempotencyKey,
    providerReference: row.providerReference ?? undefined,
    declineReason: row.declineReason ?? undefined,
    createdAt: row.createdAt,
    capturedAt: row.capturedAt ?? undefined,
  };
}
