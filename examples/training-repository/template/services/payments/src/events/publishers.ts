import { Kafka, Producer } from 'kafkajs';
import { Payment, PaymentStatus } from '../domain/payment';

/** The topic orders consumes (contracts/asyncapi/order-events.yaml, channel payments.events). */
export const PAYMENTS_TOPIC = 'payments.events';

export type PaymentEventType = 'payment.captured' | 'payment.failed' | 'payment.refunded';

/** Where events go. KafkaEventSink is the real one; tests pass a recording one. */
export interface EventSink {
  send(topic: string, key: string, value: string): Promise<void>;
}

export class KafkaEventSink implements EventSink {
  private constructor(private readonly producer: Producer) {}

  /** Connects a producer to the brokers. */
  static async connect(brokers: string[]): Promise<KafkaEventSink> {
    const producer = new Kafka({ clientId: 'payments', brokers }).producer({ idempotent: true });
    await producer.connect();
    return new KafkaEventSink(producer);
  }

  async send(topic: string, key: string, value: string): Promise<void> {
    await this.producer.send({ topic, messages: [{ key, value }] });
  }

  async close(): Promise<void> {
    await this.producer.disconnect();
  }
}

/**
 * Publishes one payment event, keyed by the order id so that all events of an
 * order reach the consumer in order. The JSON is what orders reads
 * (internal/consumer/payments.go).
 */
export async function publishPaymentEvent(sink: EventSink, type: PaymentEventType, payment: Payment): Promise<void> {
  const body = {
    type,
    orderId: payment.orderId,
    paymentId: payment.id,
    amountCents: payment.amountCents,
    reason: payment.status === PaymentStatus.Declined ? payment.declineReason : undefined,
  };
  await sink.send(PAYMENTS_TOPIC, payment.orderId, JSON.stringify(body));
}
